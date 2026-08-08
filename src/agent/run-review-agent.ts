import ollama, { type Message } from "ollama";

import * as z from "zod";

import {
  EngineeringReviewSchema,
  type EngineeringReview,
} from "../domain/review.js";

import { createWorkspaceToolRuntime } from "./workspace-tools.js";

const MAX_REVIEW_EXPLORATION_TURNS = 8;

export interface ReviewAgentInput {
  workspaceRoot: string;
  task: string;
  model: string;
  validationSummary: string;
}

export async function runReviewAgent(
  input: ReviewAgentInput,
): Promise<EngineeringReview> {
  const runtime = await createWorkspaceToolRuntime(input.workspaceRoot);

  /*
   * Reviewer is intentionally read-only.
   */
  const readOnlyToolNames = new Set([
    "list_files",
    "read_file",
    "search_code",
    "git_status",
    "git_diff",
  ]);

  const tools = runtime.definitions.filter(
    (tool) =>
      typeof tool.function.name === "string" &&
      readOnlyToolNames.has(tool.function.name),
  );

  const messages: Message[] = [
    {
      role: "system",

      content: `
You are the independent reviewer inside ForgeLoop.

Another agent implemented an engineering task.
Deterministic validation has already run.

You are NOT the implementation worker.

Your job is to determine whether the candidate actually satisfies the original
engineering task and whether the resulting diff is appropriate.

You have read-only repository tools.

Review rules:

1. Inspect git_diff before reaching a verdict.
2. Compare the diff directly against every explicit requirement in the original task.
3. Passing tests do NOT prove that the requested behavior was fully implemented.
4. Explicitly verify whether requested automated tests were actually added.
5. Inspect relevant existing code or tests when necessary to understand behavior.
6. Look for unnecessary public API or function-signature changes.
7. Look for unrelated changes and scope expansion.
8. Look for behavior that compiles but does not satisfy the task.
9. Do not invent requirements that are absent from the task.
10. Do not suggest stylistic changes unless they materially affect maintainability.
11. A blocking finding means the candidate must not proceed to PR creation.
12. If ANY explicit task requirement is missing, taskSatisfied must be false and
    verdict must be request_changes.
13. Do not modify files.
14. Deterministic validation is evidence, not a substitute for reviewing the change.
15. Use your investigation turns efficiently. You will eventually be required to
    produce a verdict using the evidence you have collected.
16. The findings array contains problems or risks only.
    Do not create findings merely to describe requirements that were satisfied.

17. If verdict is "approve", there must be zero blocking findings.

18. If you identify a blocking problem, verdict must be "request_changes".

19. Successful checks belong in the summary, not as blocking findings.
`.trim(),
    },

    {
      role: "user",

      content: `
ORIGINAL ENGINEERING TASK:

${input.task}

DETERMINISTIC VALIDATION:

${input.validationSummary}

Review the candidate implementation in the current workspace.

Inspect the diff and only the repository evidence necessary to determine whether
the task was satisfied.
`.trim(),
    },
  ];

  /*
   * Phase 1:
   *
   * Give the model a bounded opportunity to gather
   * repository evidence using read-only tools.
   */
  for (let turn = 1; turn <= MAX_REVIEW_EXPLORATION_TURNS; turn += 1) {
    console.log(
      `\nReview exploration ${turn}/${MAX_REVIEW_EXPLORATION_TURNS}...`,
    );

    const response = await ollama.chat({
      model: input.model,

      messages,

      tools,

      stream: false,

      think: false,

      keep_alive: "15m",

      options: {
        temperature: 0,
        num_ctx: 16_384,
        num_predict: 1_500,
      },
    });

    messages.push(response.message);

    const toolCalls = response.message.tool_calls ?? [];

    /*
     * If the model voluntarily stops requesting
     * tools, evidence gathering is complete.
     */
    if (toolCalls.length === 0) {
      console.log("Reviewer finished evidence gathering early.");

      break;
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;

      if (!readOnlyToolNames.has(toolName)) {
        messages.push({
          role: "tool",

          tool_name: toolName,

          content: JSON.stringify({
            success: false,

            error: "Reviewer attempted to invoke a non-read-only tool.",
          }),
        });

        continue;
      }

      console.log(`Tool: ${toolName}`);

      if (toolCall.function.arguments === undefined) {
        messages.push({
          role: "tool",

          tool_name: toolName,

          content: JSON.stringify({
            success: false,

            error: "Reviewer tool call missing arguments.",
          }),
        });

        continue;
      }

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

  /*
   * Phase 2:
   *
   * Tool access is now removed completely.
   *
   * The reviewer MUST synthesize a verdict from
   * the evidence already collected.
   */
  console.log("\nEvidence gathering complete. Producing structured review...");

  const structuredResponse = await ollama.chat({
    model: input.model,

    messages: [
      ...messages,

      {
        role: "user",

        content: `
Evidence gathering is now complete.

You no longer have tool access.

Produce the final engineering review using only:
- the original task;
- deterministic validation results;
- Git diff;
- repository evidence gathered during review.

Important:

For every explicit requirement in the original task, determine whether the
candidate actually satisfies it.

If an explicit requirement is missing — including required automated tests —
set:

"taskSatisfied": false
"verdict": "request_changes"

Do not assume that existing unrelated tests satisfy a requirement to add new
automated tests.

Return only the structured review matching the supplied JSON schema.
`.trim(),
      },
    ],

    format: z.toJSONSchema(EngineeringReviewSchema),

    stream: false,

    think: false,

    keep_alive: "15m",

    options: {
      temperature: 0,
      num_ctx: 16_384,
      num_predict: 2_048,
    },
  });

  let parsed: unknown;

  try {
    parsed = JSON.parse(structuredResponse.message.content);
  } catch {
    throw new Error(
      [
        "Reviewer returned invalid JSON.",
        "",
        structuredResponse.message.content,
      ].join("\n"),
    );
  }

  const review = EngineeringReviewSchema.parse(parsed);

  const blockingFindings = review.findings.filter(
    (finding) => finding.severity === "blocking",
  );

  if (review.verdict === "approve" && !review.taskSatisfied) {
    throw new Error(
      [
        "Reviewer produced an inconsistent verdict:",
        "verdict=approve but taskSatisfied=false.",
      ].join(" "),
    );
  }

  if (review.verdict === "approve" && blockingFindings.length > 0) {
    throw new Error(
      [
        "Reviewer produced an inconsistent verdict:",
        `verdict=approve but ${blockingFindings.length}`,
        "blocking finding(s) were returned.",
      ].join(" "),
    );
  }

  return review;
}
