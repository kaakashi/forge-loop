import ollama from "ollama";
import * as z from "zod";

import { EngineeringPlanSchema, type EngineeringPlan } from "../domain/plan.js";

import type { RepositoryContext } from "../repository/analyse-repository.js";

export interface CreatePlanInput {
  task: string;
  repository: RepositoryContext;
  model: string;
}

function buildRepositoryDescription(repository: RepositoryContext): string {
  const importantFileContents = Object.entries(repository.importantFiles)
    .map(([filePath, content]) => `\n--- FILE: ${filePath} ---\n${content}`)
    .join("\n");

  return `
REPOSITORY ROOT:
${repository.root}

TRACKED FILES:
${repository.trackedFiles.join("\n")}

IMPORTANT FILE CONTENTS:
${importantFileContents}
`.trim();
}

export async function createEngineeringPlan(
  input: CreatePlanInput,
): Promise<EngineeringPlan> {
  const repositoryDescription = buildRepositoryDescription(input.repository);

  const response = await ollama.chat({
    model: input.model,

    messages: [
      {
        role: "system",
        content: `
You are the planning component of an autonomous software-engineering harness.

Your responsibility is to analyse a repository and produce a conservative,
specific and testable implementation plan.

Rules:

1. Do not claim to have inspected files that were not provided.
2. Do not invent commands when repository configuration provides alternatives.
3. Prefer the smallest change satisfying the task.
4. Identify relevant files using repository-relative paths.
5. Every implementation step must include validation.
6. Mark requiresClarification=true when the task cannot be safely implemented.
7. Do not produce source code.
8. Return only the requested structured response.
`.trim(),
      },
      {
        role: "user",
        content: `
ENGINEERING TASK:

${input.task}

REPOSITORY CONTEXT:

${repositoryDescription}

Create an implementation plan for this task.
`.trim(),
      },
    ],

    format: z.toJSONSchema(EngineeringPlanSchema),

    options: {
      temperature: 0,
      num_ctx: 16_384,
    },

    stream: false,
  });

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(response.message.content);
  } catch (error) {
    throw new Error("Ollama returned invalid JSON.", {
      cause: error,
    });
  }

  return EngineeringPlanSchema.parse(parsedJson);
}
