import { mkdir, writeFile } from "node:fs/promises";

import path from "node:path";

import type { EngineeringReview } from "../domain/review.js";

export async function saveReviewRun(input: {
  model: string;
  task: string;
  workspace: string;
  validationReport: string;
  review: EngineeringReview;
}): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputDirectory = path.resolve("generated-runs");

  await mkdir(outputDirectory, {
    recursive: true,
  });

  const outputPath = path.join(outputDirectory, `${timestamp}-review.json`);

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),

        model: input.model,

        task: input.task,

        workspace: path.resolve(input.workspace),

        validationReport: path.resolve(input.validationReport),

        review: input.review,
      },
      null,
      2,
    ),
    "utf8",
  );

  return outputPath;
}
