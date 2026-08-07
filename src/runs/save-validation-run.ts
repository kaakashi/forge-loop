import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ValidationResult } from "../validation/run-validation.js";

export async function saveValidationRun(input: {
  workspace: string;
  task?: string;
  result: ValidationResult;
}): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputDirectory = path.resolve("generated-runs");

  await mkdir(outputDirectory, {
    recursive: true,
  });

  const outputPath = path.join(outputDirectory, `${timestamp}-validation.json`);

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),

        workspace: path.resolve(input.workspace),

        task: input.task,

        result: input.result,
      },
      null,
      2,
    ),
    "utf8",
  );

  return outputPath;
}
