import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ImplementationAgentResult } from "../agent/run-implementation-agent.js";

export async function saveImplementationRun(input: {
  model: string;
  task: string;
  sourceRepository: string;
  workspace: string;
  branchName: string;
  baseCommit: string;
  result: ImplementationAgentResult;
}): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputDirectory = path.resolve("generated-runs");

  await mkdir(outputDirectory, {
    recursive: true,
  });

  const outputPath = path.join(
    outputDirectory,
    `${timestamp}-implementation.json`,
  );

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),

        model: input.model,
        task: input.task,

        sourceRepository: input.sourceRepository,

        workspace: input.workspace,
        branchName: input.branchName,
        baseCommit: input.baseCommit,

        result: input.result,
      },
      null,
      2,
    ),
    "utf8",
  );

  return outputPath;
}
