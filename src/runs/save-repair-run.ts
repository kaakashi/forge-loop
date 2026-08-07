import { mkdir, writeFile } from "node:fs/promises";

import path from "node:path";

import type { RepairAgentResult } from "../agent/run-repair-agent.js";

export async function saveRepairRun(input: {
  model: string;
  task: string;
  workspace: string;
  validationReport: string;
  result: RepairAgentResult;
}): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputDirectory = path.resolve("generated-runs");

  await mkdir(outputDirectory, {
    recursive: true,
  });

  const outputPath = path.join(outputDirectory, `${timestamp}-repair.json`);

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),

        model: input.model,

        task: input.task,

        workspace: path.resolve(input.workspace),

        validationReport: path.resolve(input.validationReport),

        result: input.result,
      },
      null,
      2,
    ),
    "utf8",
  );

  return outputPath;
}
