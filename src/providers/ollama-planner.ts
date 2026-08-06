import ollama from "ollama";
import * as z from "zod";

import { EngineeringPlanSchema, type EngineeringPlan } from "../domain/plan.js";

import type { RepositoryContext } from "../repository/analyse-repository.js";

export interface CreatePlanInput {
  task: string;
  repository: RepositoryContext;
  model: string;
  verificationFeedback?: string[];
}

function buildRepositoryDescription(repository: RepositoryContext): string {
  const importantFileContents = Object.entries(repository.importantFiles)
    .map(([filePath, content]) => `\n--- FILE: ${filePath} ---\n${content}`)
    .join("\n");

  const packageScripts = Object.entries(repository.packageScripts)
    .map(([name, command]) => `${name}: ${command}`)
    .join("\n");

  return `
REPOSITORY ROOT:
${repository.root}

TRACKED FILES:
${repository.trackedFiles.join("\n")}

AVAILABLE PACKAGE SCRIPTS:
${packageScripts || "(none)"}

IMPORTANT FILE CONTENTS:
${importantFileContents}
`.trim();
}

export async function createEngineeringPlan(
  input: CreatePlanInput,
): Promise<EngineeringPlan> {
  const repositoryDescription = buildRepositoryDescription(input.repository);

  const verificationFeedbackSection =
    input.verificationFeedback && input.verificationFeedback.length > 0
      ? `
  A PREVIOUS PLAN WAS REJECTED.

  Correct every issue below:

  ${input.verificationFeedback
    .map((issue, index) => `${index + 1}. ${issue}`)
    .join("\n")}

  Return a completely corrected plan. Do not explain the corrections.
  `
      : "";

  const response = await ollama.chat({
    model: input.model,

    messages: [
      {
        role: "system",
        content: `
You are the planning component of a software-engineering agent harness.

Your responsibility is to analyse the provided repository evidence and produce
a conservative, minimal and verifiable implementation plan.

Rules:

1. Do not claim to have inspected files that were not provided.
2. Every file must be identified as create, modify, or delete.
3. A file marked modify or delete must appear in the tracked-file list.
4. A file marked create must not appear in the tracked-file list.
5. Only include validation scripts that visibly exist in package.json.
6. Do not invent environment-variable names, defaults, limits, status codes,
   error codes, database fields, API behaviour, or product requirements.
7. When an important product decision is unspecified, set
   requiresClarification=true and provide a focused question.
8. Do not add UI changes unless the task or repository requirements explicitly
   require a UI change.
9. Do not add documentation work unless repository instructions or the task
   explicitly require it.
10. Prefer the smallest change that satisfies the stated acceptance criteria.
11. Separate existing relevant files from files that must be created.
12. Every implementation step must contain a deterministic validation method.
13. Do not write source code.
14. Return only the requested structured response.
15. Every file path field must contain only a repository-relative file path.
16. Never add annotations, descriptions, script names, or parentheses to paths.
17. Never use ".", "./", the repository root, directories, globs, or placeholders
    as file paths.
18. Examples of valid paths:
    - package.json
    - src/app/api/imports/route.ts
    - tests/imports/upload.test.ts
19. Example of an invalid path:
    - package.json (scripts: test, test:integration)
20. If no file needs to change for a proposed step, omit that step.
`.trim(),
      },
      {
        role: "user",
        content: `
ENGINEERING TASK:

${input.task}

REPOSITORY CONTEXT:

${repositoryDescription}

${verificationFeedbackSection}

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
