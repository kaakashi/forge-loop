import ollama, { type Message } from "ollama";

import {
  createWorkspaceToolRuntime,
  type ToolExecutionLog,
} from "./workspace-tools.js";

const MAX_AGENT_TURNS = 16;

const COMPLETION_MARKER = "FORGELOOP_TASK_COMPLETE";

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

export async function runImplementationAgent(
  input: ImplementationAgentInput,
): Promise<ImplementationAgentResult> {
  const runtime = await createWorkspaceToolRuntime(input.workspaceRoot);

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
6. Use write_file with mode=create for genuinely new files.
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

    const response = await ollama.chat({
      model: input.model,
      messages,
      tools: runtime.definitions,
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

    if (toolCalls.length === 0) {
      finalMessage = response.message.content.trim();

      const counters = runtime.getCounters();

      const declaredComplete = finalMessage.startsWith(COMPLETION_MARKER);

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

If you identified additional work, continue using the available tools.

When and only when implementation, validation, and final diff inspection are complete,
begin your final response with exactly:

${COMPLETION_MARKER}
`.trim(),
        });

        continue;
      }

      if (counters.fileWrites > 0 && counters.commandRuns === 0) {
        console.log(
          "Agent declared completion without running validation. Asking it to validate...",
        );

        messages.push({
          role: "user",
          content: `
You declared completion after modifying files, but you have not run any validation command.

Use the available package-script tool to run the most relevant test, typecheck,
lint, or build validation available for this repository.

Inspect the final diff afterwards.

Do not declare completion until validation has been attempted.
`.trim(),
        });

        continue;
      }

      const finalStatus = await runtime.execute("git_status", {});

      const finalDiff = await runtime.execute("git_diff", {});

      const hasChanges = !finalStatus.includes("Workspace is clean.");

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

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;

      const toolArguments = toolCall.function.arguments;

      console.log(`Tool: ${toolName}`);

      const toolResult = await runtime.execute(toolName, toolArguments);

      messages.push({
        role: "tool",
        tool_name: toolName,
        content: toolResult,
      });
    }
  }

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
