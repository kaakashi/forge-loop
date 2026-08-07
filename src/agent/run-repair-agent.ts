import ollama, { type Message } from "ollama";

import {
  createWorkspaceToolRuntime,
  type ToolExecutionLog,
} from "./workspace-tools.js";

const MAX_REPAIR_TURNS = 16;

const REPAIR_COMPLETION_MARKER = "FORGELOOP_REPAIR_COMPLETE";

export interface RepairAgentInput {
  workspaceRoot: string;
  task: string;
  model: string;
  validationFailures: string;
}

export interface RepairAgentResult {
  status: "completed" | "max_turns_reached";

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

export async function runRepairAgent(
  input: RepairAgentInput,
): Promise<RepairAgentResult> {
  const runtime = await createWorkspaceToolRuntime(input.workspaceRoot);

  const messages: Message[] = [
    {
      role: "system",
      content: `
You are the repair worker inside ForgeLoop.

Another implementation agent attempted an engineering task.
A deterministic validator then tested that implementation and found failures.

Your job is to repair the existing candidate implementation.

Rules:

1. The original engineering task remains authoritative.
2. Treat validation failures as concrete evidence, not suggestions.
3. Inspect the current Git diff before making changes.
4. Inspect relevant existing repository code and tests before repairing.
5. Prefer existing repository testing patterns over inventing mocks.
6. Fix the implementation, tests, or both when necessary.
7. Do not simply weaken tests to make them pass.
8. Do not delete legitimate validation coverage.
9. Do not modify dependencies, lockfiles, generated Prisma code, node_modules,
   Git metadata, or unrelated application features.
10. Prefer replace_in_file for existing files.
11. Use write_file only when creation or full replacement is genuinely needed.
12. Keep the change narrowly scoped to the original task.
13. You may run available package validation scripts when useful.
14. Inspect git_diff before finishing.
15. Do not stop after merely explaining what is wrong.
16. Fix syntax errors and compiler errors before addressing behavioral test failures.
17. When a validation failure points to a modified file, read the relevant function
    and surrounding code completely before changing it.
18. Preserve existing public function signatures unless changing them is strictly
    necessary for the original task.
19. Do not leave placeholder implementations, unconditional error throws, TODO
    implementations, or deliberately broken intermediate states.
20. After making code changes, run typecheck before declaring repair complete.
21. If typecheck fails, continue repairing before attempting broader test suites.

When the candidate has been repaired as far as you can determine, begin your
final response with exactly:

${REPAIR_COMPLETION_MARKER}

Then briefly summarize:
- what you repaired;
- which files changed;
- any remaining concerns.

Do not output the completion marker while you still intend to make changes.
`.trim(),
    },
    {
      role: "user",
      content: `
ORIGINAL ENGINEERING TASK:

${input.task}

DETERMINISTIC VALIDATION FAILURES:

${input.validationFailures}

The workspace already contains the failed candidate implementation.

Inspect the current diff and repository evidence, then repair the candidate.
`.trim(),
    },
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let totalDurationNanoseconds = 0;

  let finalMessage = "";

  for (let turn = 1; turn <= MAX_REPAIR_TURNS; turn += 1) {
    console.log(`\nRepair turn ${turn}/${MAX_REPAIR_TURNS}...`);

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

      const declaredComplete = finalMessage.startsWith(
        REPAIR_COMPLETION_MARKER,
      );

      if (!declaredComplete) {
        console.log(
          "Repair agent stopped without declaring completion. Asking it to continue...",
        );

        messages.push({
          role: "user",
          content: `
You stopped without declaring the repair complete.

Your previous response was:

${finalMessage || "(empty response)"}

Continue repairing the candidate using the available tools.

When and only when the repair is complete, begin the final response with:

${REPAIR_COMPLETION_MARKER}
`.trim(),
        });

        continue;
      }

      const finalStatus = await runtime.execute("git_status", {});

      const finalDiff = await runtime.execute("git_diff", {});

      return {
        status: "completed",

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

      console.log(`Tool: ${toolName}`);

      const toolResult = await runtime.execute(
        toolName,
        toolCall.function.arguments,
      );

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

    finalMessage: "Repair agent reached its bounded turn limit.",

    turns: MAX_REPAIR_TURNS,

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
