import ollama, { type Message, type Tool } from "ollama";

import {
  createWorkspaceToolRuntime,
  type ToolExecutionLog,
} from "./workspace-tools.js";

const MAX_AGENT_TURNS = 16;
const MAX_EXPLORATION_TURNS = 8;
const TEST_REQUIREMENT_NUDGE_TURN = 10;
const VALIDATION_NUDGE_TURN = 12;

const COMPLETION_MARKER = "FORGELOOP_TASK_COMPLETE";

const POST_EXPLORATION_ALLOWED_TOOLS = new Set([
  "list_files",
  "read_file",
  "replace_in_file",
  "write_file",
  "run_package_script",
  "git_diff",
]);

export interface ImplementationAgentInput {
  workspaceRoot: string;
  task: string;
  model: string;
  plan?: string;
}

export interface ImplementationAgentResult {
  status: "completed" | "no_changes" | "max_turns_reached";

  finalMessage: string;

  turns: number;

  toolExecutions: ToolExecutionLog[];

  counters: {
    fileWrites: number;
    commandRuns: number;
  };

  usage: {
    promptTokens: number;
    completionTokens: number;
    totalDurationNanoseconds: number;
  };

  finalStatus: string;
  finalDiff: string;
}

function normalizeRepositoryPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function isIntegrationTestPath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);

  return (
    /(^|\/)tests\/integration(\/|$)/.test(normalized) ||
    /\.integration\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function isUnitTestPath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);

  /*
   * Integration tests frequently also end in
   * ".test.ts". Check integration first so they do
   * not incorrectly require the unit-test surface.
   */
  if (isIntegrationTestPath(normalized)) {
    return false;
  }

  return (
    /(^|\/)tests\/unit(\/|$)/.test(normalized) ||
    /(^|\/)__tests__(\/|$)/.test(normalized) ||
    /\.(unit\.)?(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function isTestPath(filePath: string): boolean {
  return isUnitTestPath(filePath) || isIntegrationTestPath(filePath);
}

function isCodePath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);

  return /\.(?:[cm]?[jt]sx?)$/i.test(normalized);
}

function getAvailableValidationScripts(definitions: Tool[]): Set<string> {
  const runPackageScriptTool = definitions.find(
    (tool) => tool.function.name === "run_package_script",
  );

  if (!runPackageScriptTool) {
    return new Set();
  }

  const parameters = runPackageScriptTool.function.parameters as {
    properties?: {
      script?: {
        enum?: unknown;
      };
    };
  };

  const scriptValues = parameters.properties?.script?.enum;

  if (!Array.isArray(scriptValues)) {
    return new Set();
  }

  return new Set(
    scriptValues.filter(
      (value): value is string =>
        typeof value === "string" && value !== "NO_ALLOWED_SCRIPTS",
    ),
  );
}

function getMutationPath(log: ToolExecutionLog): string | undefined {
  if (
    !log.success ||
    (log.tool !== "write_file" && log.tool !== "replace_in_file")
  ) {
    return undefined;
  }

  if (typeof log.arguments !== "object" || log.arguments === null) {
    return undefined;
  }

  const filePath = (
    log.arguments as {
      path?: unknown;
    }
  ).path;

  if (typeof filePath !== "string") {
    return undefined;
  }

  return normalizeRepositoryPath(filePath);
}

function getSuccessfulMutationPaths(logs: ToolExecutionLog[]): string[] {
  return logs
    .map(getMutationPath)
    .filter((filePath): filePath is string => typeof filePath === "string");
}

function pickAvailableScript(
  availableScripts: Set<string>,
  candidates: string[],
): string | undefined {
  return candidates.find((script) => availableScripts.has(script));
}

function getRequiredValidationScripts(
  logs: ToolExecutionLog[],
  availableScripts: Set<string>,
): Set<string> {
  const changedFiles = getSuccessfulMutationPaths(logs);

  const required = new Set<string>();

  /*
   * Any JavaScript / TypeScript source or test change
   * should pass the repository's strongest available
   * static correctness check.
   */
  if (changedFiles.some(isCodePath)) {
    const staticCheck = pickAvailableScript(availableScripts, [
      "typecheck",
      "check",
      "build",
    ]);

    if (staticCheck) {
      required.add(staticCheck);
    }
  }

  /*
   * Unit-test changes require the repository's unit
   * test surface when available.
   */
  if (changedFiles.some(isUnitTestPath)) {
    const unitTest = pickAvailableScript(availableScripts, [
      "test:unit",
      "test",
    ]);

    if (unitTest) {
      required.add(unitTest);
    }
  }

  /*
   * Integration-test changes require the repository's
   * integration test surface when available.
   */
  if (changedFiles.some(isIntegrationTestPath)) {
    const integrationTest = pickAvailableScript(availableScripts, [
      "test:integration",
      "test",
    ]);

    if (integrationTest) {
      required.add(integrationTest);
    }
  }

  return required;
}

function packageScriptPassed(log: ToolExecutionLog): boolean {
  if (log.tool !== "run_package_script") {
    return false;
  }

  /*
   * Workspace-tool execution itself may succeed while
   * the underlying package script exits unsuccessfully.
   *
   * The actual command result is encoded inside result.
   */
  try {
    const parsed = JSON.parse(log.result) as {
      success?: unknown;
    };

    return parsed.success === true;
  } catch {
    /*
     * Tool logs are bounded/truncated. The structured
     * success value occurs near the beginning, so use
     * this fallback when truncation prevents JSON.parse.
     */
    return log.result.includes('"success": true');
  }
}

function getPackageScriptName(log: ToolExecutionLog): string | undefined {
  if (
    log.tool !== "run_package_script" ||
    typeof log.arguments !== "object" ||
    log.arguments === null
  ) {
    return undefined;
  }

  const script = (
    log.arguments as {
      script?: unknown;
    }
  ).script;

  return typeof script === "string" ? script : undefined;
}

function getLatestWriteTimestamp(logs: ToolExecutionLog[]): number | undefined {
  const writeTimestamps = logs
    .filter((log) => getMutationPath(log) !== undefined)
    .map((log) => new Date(log.timestamp).getTime());

  if (writeTimestamps.length === 0) {
    return undefined;
  }

  return Math.max(...writeTimestamps);
}

function getValidationStateAfterLatestWrite(
  logs: ToolExecutionLog[],
): Map<string, boolean> {
  const latestWriteTimestamp = getLatestWriteTimestamp(logs);

  const state = new Map<string, boolean>();

  if (latestWriteTimestamp === undefined) {
    return state;
  }

  /*
   * Only validation performed AFTER the latest
   * successful repository mutation is current.
   *
   * Anything before the latest write is stale.
   */
  const validationLogs = logs
    .filter(
      (log) =>
        log.tool === "run_package_script" &&
        new Date(log.timestamp).getTime() > latestWriteTimestamp,
    )
    .sort(
      (left, right) =>
        new Date(left.timestamp).getTime() -
        new Date(right.timestamp).getTime(),
    );

  /*
   * Later executions override earlier executions of
   * the same validation surface.
   *
   * Example:
   *
   * typecheck FAIL
   * fix code
   * typecheck PASS
   *
   * Only the latest post-write result matters.
   */
  for (const log of validationLogs) {
    const script = getPackageScriptName(log);

    if (!script) {
      continue;
    }

    state.set(script, packageScriptPassed(log));
  }

  return state;
}

function getMissingValidationScripts(
  logs: ToolExecutionLog[],
  availableScripts: Set<string>,
): string[] {
  const required = getRequiredValidationScripts(logs, availableScripts);

  const validationState = getValidationStateAfterLatestWrite(logs);

  return [...required].filter((script) => validationState.get(script) !== true);
}

function hasSuccessfulTestFileChange(logs: ToolExecutionLog[]): boolean {
  return logs.some((log) => {
    const filePath = getMutationPath(log);

    return typeof filePath === "string" && isTestPath(filePath);
  });
}

function taskRequiresTestChanges(task: string): boolean {
  return (
    /\b(add|write|create|include|modify|update)\b.{0,30}\btests?\b/i.test(
      task,
    ) ||
    /\bautomated tests?\b/i.test(task) ||
    /\btest coverage\b/i.test(task)
  );
}

export async function runImplementationAgent(
  input: ImplementationAgentInput,
): Promise<ImplementationAgentResult> {
  const runtime = await createWorkspaceToolRuntime(input.workspaceRoot);

  const availableValidationScripts = getAvailableValidationScripts(
    runtime.definitions,
  );

  const messages: Message[] = [
    {
      role: "system",

      content: `
You are the implementation worker inside ForgeLoop, a bounded software-engineering agent harness.

You are operating only inside an isolated Git worktree. You must use the provided tools to inspect and modify the repository.

Rules:

1. Inspect relevant repository files before editing.

2. Treat the engineering task as authoritative.

3. Treat the supplied plan as advisory; correct it when repository evidence differs.

4. Make the smallest change that satisfies the task.

5. Prefer replace_in_file for existing files.

6. Use write_file only for genuinely new files. Existing files must be
   modified with replace_in_file.

7. Do not modify package dependencies or lockfiles.

8. Do not modify generated files, build output, node_modules, or Git metadata.

9. Do not start development servers or long-running processes.

10. Use only run_package_script for validation.

11. Run relevant type checks or tests when available.

12. Inspect git_diff before finishing.

13. Do not merely describe changes. Perform the changes using tools.

14. When complete, return a concise summary containing:
    - files changed;
    - validation performed;
    - any remaining risks.

15. Stop after the task is complete. Do not make unrelated improvements.

16. You are not finished merely because you stop calling tools.

17. When the implementation is genuinely complete, relevant validation has
    been run, and you have inspected the final diff, begin your final response
    with exactly:

    FORGELOOP_TASK_COMPLETE

18. Never output FORGELOOP_TASK_COMPLETE while you still intend to make
    another modification, investigate an error, or run additional validation.

19. Preserve existing public function signatures and contracts unless the
    engineering task explicitly requires changing them.

20. Before adding or modifying an integration test, inspect at least one
    nearby existing integration test and reuse the repository's established
    fixtures, seeded workspace data, authentication context, and database
    setup patterns.

21. Do not invent database IDs, workspace IDs, user IDs, or other persisted
    entities when the code under test writes database records. Use existing
    test setup patterns instead.

22. Prefer extending an existing implementation at the narrowest relevant
    layer rather than redesigning surrounding APIs.

23. Do not modify unrelated tests merely to accommodate an unnecessary API
    signature change.

24. If the task requires automated tests, the task is incomplete until you have
    added or modified appropriate test files.

25. Before finishing, inspect package.json and run the relevant test script for
    every test file you added or changed.

26. Never replace or substantially rewrite an existing implementation when a
    small localized modification can satisfy the task.

27. Never leave placeholders, TODO implementations, temporary stubs, or comments
    indicating unfinished work.

28. Tests must assert the specific requested behavior. Do not treat a generic
    throw or unrelated failure as proof that the requirement works.

29. When testing environment-variable behavior, explicitly establish and restore
    the environment state used by the test. Do not assume ambient environment
    values prove the requested behavior.

30. Validation must cover the current repository state. Any file modification
    after validation makes previous validation stale.
31. A failing validation command does not satisfy validation requirements.
32. When ForgeLoop tells you that specific validation surfaces remain, run those
    exact package scripts and correct failures before declaring completion.
33. If replace_in_file reports that the exact search text was not found,
    do not retry the same fragment from memory. Read the exact relevant
    lines again and retry using a smaller exact anchor.
34. When inserting a new test or small block into an existing file, prefer
    replacing a short unique anchor with that same anchor plus the new block.
    Do not copy a large surrounding section unless necessary.
35. A replacement that leaves a file unchanged is not an implementation
    change and must not be used to satisfy the task.
36. When testing a Promise-returning or async function, do not use synchronous
    toThrow or not.toThrow assertions around the function call. Await the
    Promise and use the repository's established resolves/rejects pattern.
`.trim(),
    },

    {
      role: "user",

      content: `
ENGINEERING TASK:

${input.task}

ADVISORY IMPLEMENTATION PLAN:

${input.plan ?? "(No separate plan supplied.)"}

Begin by inspecting the repository. Implement the task completely within the isolated worktree.
`.trim(),
    },
  ];

  let promptTokens = 0;

  let completionTokens = 0;

  let totalDurationNanoseconds = 0;

  let finalMessage = "";

  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn += 1) {
    console.log(`\nAgent turn ${turn}/${MAX_AGENT_TURNS}...`);

    let availableTools = runtime.definitions;

    /*
     * The first phase allows broad repository discovery.
     *
     * After that, broad search is removed so the model
     * must move toward implementation and validation.
     *
     * Bounded file listing remains available because it
     * is useful for locating known test directories.
     */
    if (turn > MAX_EXPLORATION_TURNS) {
      availableTools = runtime.definitions.filter(
        (tool) =>
          typeof tool.function.name === "string" &&
          POST_EXPLORATION_ALLOWED_TOOLS.has(tool.function.name),
      );
    }

    const response = await ollama.chat({
      model: input.model,

      messages,

      tools: availableTools,

      stream: false,

      think: false,

      keep_alive: "15m",

      options: {
        temperature: 0.1,

        num_ctx: 16_384,

        num_predict: 2_048,
      },
    });

    promptTokens += response.prompt_eval_count ?? 0;

    completionTokens += response.eval_count ?? 0;

    totalDurationNanoseconds += response.total_duration ?? 0;

    messages.push(response.message);

    const toolCalls = response.message.tool_calls ?? [];

    /*
     * A tool-less response may be either:
     *
     * - a genuine final completion;
     * - an agent that stopped reasoning too early.
     *
     * Completion is independently checked by the
     * harness.
     */
    if (toolCalls.length === 0) {
      finalMessage = response.message.content.trim();

      const logs = runtime.getLogs();

      const counters = runtime.getCounters();

      const declaredComplete = finalMessage.startsWith(COMPLETION_MARKER);

      const requiresTestChanges = taskRequiresTestChanges(input.task);

      const testFileChanged = hasSuccessfulTestFileChange(logs);

      const missingRequiredTests = requiresTestChanges && !testFileChanged;

      const missingValidationScripts = getMissingValidationScripts(
        logs,
        availableValidationScripts,
      );

      /*
       * Resolve concrete unmet requirements BEFORE using
       * the generic "continue" nudge.
       *
       * This prevents a tool-less response from bypassing
       * the deterministic missing-test / validation checks.
       */
      if (
        missingRequiredTests &&
        (declaredComplete ||
          counters.fileWrites > 0 ||
          turn >= TEST_REQUIREMENT_NUDGE_TURN)
      ) {
        console.log(
          declaredComplete
            ? "Agent declared completion but required test changes are missing."
            : "Agent stopped while required automated tests are still missing.",
        );

        messages.push({
          role: "user",

          content: `
ForgeLoop detected an unresolved deterministic task requirement:

- The original engineering task explicitly requires automated tests.
- No test file has been successfully created or modified yet.

${declaredComplete ? "Your completion declaration is rejected." : "Do not stop yet."}

Before doing anything else:

1. Use the test files and testing patterns you already discovered.
2. If the appropriate test file already exists, read the exact relevant section
   and modify it with replace_in_file.
3. Use write_file only if a genuinely new test file is appropriate.
4. Add focused tests that prove the requested behavior.
5. Do not redesign unrelated implementation while adding the tests.
6. After the latest edit, run every validation surface ForgeLoop reports as
   required.
7. Inspect git_diff before finishing.

Only after the required tests exist and current validation passes may you declare:

${COMPLETION_MARKER}
`.trim(),
        });

        continue;
      }

      /*
       * If concrete validation requirements remain, tell
       * the worker exactly which scripts are unresolved
       * instead of spending another turn on a vague nudge.
       */
      if (counters.fileWrites > 0 && missingValidationScripts.length > 0) {
        console.log(
          [
            declaredComplete
              ? "Agent declared completion but required"
              : "Agent stopped while required",
            "validation surfaces are missing or failing:",
            missingValidationScripts.join(", "),
          ].join(" "),
        );

        messages.push({
          role: "user",

          content: `
ForgeLoop detected unresolved validation requirements for the CURRENT repository
state.

The following required validation scripts have NOT passed:

${missingValidationScripts.map((script) => `- ${script}`).join("\n")}

${declaredComplete ? "Your completion declaration is rejected." : "Do not stop yet."}

A validation run performed before the latest successful file modification is
stale and does not count.

A failing validation run does not count.

Run each required script above.

If a script fails:

1. Inspect the reported failure.
2. Make only the smallest correction required.
3. Remember that any new file modification makes previous validation stale.
4. Rerun every validation surface ForgeLoop reports as missing.

After every required surface passes, inspect git_diff and only then declare:

${COMPLETION_MARKER}
`.trim(),
        });

        continue;
      }

      /*
       * At this point there is no mechanically provable
       * missing test or validation requirement.
       *
       * A non-completion response can therefore receive the
       * generic continuation nudge.
       */
      if (!declaredComplete) {
        console.log(
          "Agent stopped without declaring completion. Asking it to continue...",
        );

        messages.push({
          role: "user",

          content: `
You stopped without declaring the task complete.

Your last message was:

${finalMessage || "(empty response)"}

No deterministic missing-test or validation requirement is currently blocking
you.

If implementation work remains, continue using the available tools.

Before finishing, inspect git_diff.

When and only when implementation, required validation, and final diff inspection
are complete, begin your final response with exactly:

${COMPLETION_MARKER}
`.trim(),
        });

        continue;
      }

      const finalStatus = await runtime.execute("git_status", {});

      const finalDiff = await runtime.execute("git_diff", {});

      /*
       * node_modules is a bootstrap-only symlink and does
       * not count as a meaningful repository modification.
       */
      const meaningfulStatusLines = finalStatus
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter(
          (line) => line !== "?? node_modules" && line !== "?? node_modules/",
        );

      const hasChanges = meaningfulStatusLines.length > 0;

      return {
        status: hasChanges ? "completed" : "no_changes",

        finalMessage,

        turns: turn,

        toolExecutions: runtime.getLogs(),

        counters: runtime.getCounters(),

        usage: {
          promptTokens,

          completionTokens,

          totalDurationNanoseconds,
        },

        finalStatus,

        finalDiff,
      };
    }

    /*
     * Execute model-requested tools.
     */
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;

      const toolArguments = toolCall.function.arguments;

      console.log(`Tool: ${toolName}`);

      /*
       * Tool omission from Ollama's current definitions is
       * not trusted as the only phase-boundary mechanism.
       *
       * ForgeLoop enforces the boundary itself as well.
       */
      if (
        turn > MAX_EXPLORATION_TURNS &&
        !POST_EXPLORATION_ALLOWED_TOOLS.has(toolName)
      ) {
        const rejectedResult = JSON.stringify(
          {
            success: false,

            error: [
              "The repository exploration phase has ended.",
              `${toolName} is no longer available.`,
              "Use the repository evidence already gathered.",
              "Allowed actions now are bounded file navigation, targeted reads, implementation, validation, and git_diff.",
            ].join(" "),
          },
          null,
          2,
        );

        console.log(`Blocked post-exploration tool: ${toolName}`);

        messages.push({
          role: "tool",

          tool_name: toolName,

          content: rejectedResult,
        });

        continue;
      }

      const toolResult = await runtime.execute(toolName, toolArguments);

      messages.push({
        role: "tool",

        tool_name: toolName,

        content: toolResult,
      });
    }

    const countersAfterTurn = runtime.getCounters();

    /*
     * Explicit test requirement checkpoint.
     */
    const requiresTestChanges = taskRequiresTestChanges(input.task);

    const testFileChanged = hasSuccessfulTestFileChange(runtime.getLogs());

    if (
      turn === TEST_REQUIREMENT_NUDGE_TURN &&
      requiresTestChanges &&
      !testFileChanged
    ) {
      console.log(
        "Required automated tests are still missing. Forcing test implementation...",
      );

      messages.push({
        role: "user",

        content: `
The original engineering task explicitly requires automated tests.

ForgeLoop inspected your successful repository mutations and no test file has
yet been successfully created or modified.

The task cannot be completed in this state.

Before finishing:

1. Use the test files and testing patterns you already discovered.
2. If the appropriate test file already exists, read the exact relevant section
   and modify it with replace_in_file.
3. Use write_file only if a genuinely new test file is appropriate.
4. Add focused tests for the requested behavior.
5. Do not redesign unrelated implementation while doing this.
6. Run the validation surfaces ForgeLoop requests after the tests are changed.

You must satisfy the automated-test requirement before completion.
`.trim(),
      });
    }

    /*
     * Explicit transition from exploration into bounded
     * implementation.
     */
    if (turn === MAX_EXPLORATION_TURNS && countersAfterTurn.fileWrites === 0) {
      console.log(
        "Exploration budget exhausted. Forcing implementation phase...",
      );

      messages.push({
        role: "user",

        content: `
The bounded repository-exploration phase is complete.

You now have the remaining turns to IMPLEMENT and VALIDATE the task.

Do not continue broad investigation.

From this point:

1. Use the repository evidence already collected.
2. Use list_files only for bounded navigation to a known directory.
3. Use read_file only when you need exact contents of a known file.
4. Modify existing files only with replace_in_file.
5. Create genuinely new files only with write_file.
6. Follow the original task's testing requirements exactly. If it explicitly
   requires automated tests, those tests must be added or modified before the
   implementation can be complete.
7. When tests are required, reuse the repository's existing test patterns for
   the affected layer rather than inventing a new testing structure.
8. Run every validation surface ForgeLoop requires after the latest edit.
9. Inspect git_diff before finishing.

Spend the remaining turns implementing, validating, and finishing the requested
change.
`.trim(),
      });
    }

    /*
     * Required validation surfaces are derived from the
     * actual successful repository mutations.
     */
    const missingValidationScripts = getMissingValidationScripts(
      runtime.getLogs(),
      availableValidationScripts,
    );

    if (
      turn >= VALIDATION_NUDGE_TURN &&
      countersAfterTurn.fileWrites > 0 &&
      missingValidationScripts.length > 0
    ) {
      console.log(
        [
          "Required validation surfaces remain:",
          missingValidationScripts.join(", "),
        ].join(" "),
      );

      messages.push({
        role: "user",

        content: `
The implementation phase is nearing completion.

ForgeLoop requires the following validation scripts to pass against the CURRENT
repository state:

${missingValidationScripts.map((script) => `- ${script}`).join("\n")}

Run these validation surfaces now.

A validation command that failed does not satisfy the requirement.

A validation command run before the most recent successful file modification is
stale and does not satisfy the requirement.

If validation fails:

- inspect the reported failure;
- make only the smallest required correction;
- rerun ALL validation surfaces ForgeLoop reports as missing after the correction.

Do not make unrelated changes.

Once every required validation surface passes, inspect git_diff and finish.
`.trim(),
      });
    }
  }

  /*
   * Reaching the turn budget is not itself success or
   * failure of the candidate.
   *
   * The outer deterministic validator remains
   * authoritative.
   */
  const finalStatus = await runtime.execute("git_status", {});

  const finalDiff = await runtime.execute("git_diff", {});

  return {
    status: "max_turns_reached",

    finalMessage: "The implementation agent reached its bounded turn limit.",

    turns: MAX_AGENT_TURNS,

    toolExecutions: runtime.getLogs(),

    counters: runtime.getCounters(),

    usage: {
      promptTokens,

      completionTokens,

      totalDurationNanoseconds,
    },

    finalStatus,

    finalDiff,
  };
}
