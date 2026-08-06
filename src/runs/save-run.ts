import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EngineeringPlan } from "../domain/plan.js";
import type { RepositoryContext } from "../repository/analyse-repository.js";

export interface PlanningRun {
  runId: string;
  createdAt: string;
  model: string;
  task: string;
  repository: {
    root: string;
    trackedFileCount: number;
    inspectedFiles: string[];
  };
  plan: EngineeringPlan;
}

function createRunId(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function savePlanningRun(input: {
  task: string;
  model: string;
  repository: RepositoryContext;
  plan: EngineeringPlan;
}): Promise<string> {
  const runId = createRunId();
  const runsDirectory = path.resolve("generated-runs");

  await mkdir(runsDirectory, {
    recursive: true,
  });

  const run: PlanningRun = {
    runId,
    createdAt: new Date().toISOString(),
    model: input.model,
    task: input.task,
    repository: {
      root: input.repository.root,
      trackedFileCount: input.repository.trackedFiles.length,
      inspectedFiles: Object.keys(input.repository.importantFiles),
    },
    plan: input.plan,
  };

  const outputPath = path.join(runsDirectory, `${runId}.json`);

  await writeFile(outputPath, JSON.stringify(run, null, 2), "utf8");

  return outputPath;
}
