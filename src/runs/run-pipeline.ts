import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  publishPullRequest,
  type PublishPullRequestResult,
} from "../git/publish-pull-request.js";

export interface RunForgeLoopPipelineInput {
  repo: string;
  task: string;
  createPr?: boolean;
  baseBranch?: string;
  requireSourceName?: string;
  model?: string;
}

export interface RunForgeLoopPipelineResult {
  repository: string;
  task: string;
  planReportPath: string;
  workspaceRoot: string;
  branch: string;
  baselineValidationReportPath: string;
  implementationStatus: string;
  finalValidationReportPath: string;
  reviewReportPath: string;
  publish?: PublishPullRequestResult;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const CURRENT_FILE = fileURLToPath(import.meta.url);
const FORGELOOP_ROOT = path.resolve(path.dirname(CURRENT_FILE), "../..");

function localTsxPath(): string {
  const executableName = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return path.join(FORGELOOP_ROOT, "node_modules", ".bin", executableName);
}

async function runCli(args: string[]): Promise<CliResult> {
  const tsx = localTsxPath();
  const cliPath = path.join(FORGELOOP_ROOT, "src", "cli.ts");

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(tsx, [cliPath, ...args], {
      cwd: FORGELOOP_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function requireSuccessfulCommand(stage: string, result: CliResult): void {
  if (result.exitCode === 0) return;

  throw new Error(
    [
      `${stage} command failed with exit code ${result.exitCode}.`,
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function parsePathAfterLabel(output: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`${escapedLabel}\\s*([^\\n\\r]+)`));

  if (!match?.[1]) {
    throw new Error(`Unable to parse "${label}" from ForgeLoop CLI output.`);
  }

  return match[1].trim();
}

function parseJsonStringField(output: string, field: string): string {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`"${escapedField}"\\s*:\\s*"([^"]+)"`));

  if (!match?.[1]) {
    throw new Error(`Unable to parse "${field}" from ForgeLoop CLI output.`);
  }

  return match[1];
}

function parseValidationReportPath(output: string): string {
  const matches = [
    ...output.matchAll(/"reportPath"\s*:\s*"([^"]+-validation\.json)"/g),
  ];
  const last = matches.at(-1)?.[1];
  if (!last)
    throw new Error("Unable to parse deterministic validation report path.");
  return last;
}

function parseReviewReportPath(output: string): string {
  const matches = [
    ...output.matchAll(/"reportPath"\s*:\s*"([^"]+-review\.json)"/g),
  ];
  const last = matches.at(-1)?.[1];
  if (!last) throw new Error("Unable to parse independent review report path.");
  return last;
}

function validationPassed(output: string): boolean {
  return /"passed"\s*:\s*true/.test(output);
}

function reviewApproved(output: string): boolean {
  return (
    /"verdict"\s*:\s*"approve"/.test(output) &&
    /"taskSatisfied"\s*:\s*true/.test(output) &&
    !/"severity"\s*:\s*"blocking"/.test(output)
  );
}

function parseImplementationStatus(output: string): string {
  const match = output.match(
    /"status"\s*:\s*"(completed|no_changes|max_turns_reached)"/,
  );
  return match?.[1] ?? "unknown";
}

async function gitMeaningfulStatus(workspaceRoot: string): Promise<string[]> {
  const result = await new Promise<CliResult>((resolve, reject) => {
    const child = spawn("git", ["-C", workspaceRoot, "status", "--short"], {
      cwd: FORGELOOP_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to inspect implementation worktree: ${result.stderr}`,
    );
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) => line !== "?? node_modules" && line !== "?? node_modules/",
    );
}

function printStage(title: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(`ForgeLoop :: ${title}`);
  console.log("=".repeat(72));
}

export async function runForgeLoopPipeline(
  input: RunForgeLoopPipelineInput,
): Promise<RunForgeLoopPipelineResult> {
  const repository = await realpath(input.repo);
  const requireSourceName =
    input.requireSourceName ?? path.basename(repository);

  printStage("PLAN");
  const planResult = await runCli([
    "plan",
    "--repo",
    repository,
    "--task",
    input.task,
  ]);
  requireSuccessfulCommand("Planning", planResult);
  const planReportPath = parsePathAfterLabel(
    planResult.stdout,
    "Run record saved to:",
  );

  printStage("WORKSPACE");
  const workspaceResult = await runCli([
    "workspace",
    "--repo",
    repository,
    "--task",
    input.task,
  ]);
  requireSuccessfulCommand("Workspace creation", workspaceResult);
  const workspaceRoot = parseJsonStringField(
    workspaceResult.stdout,
    "worktreePath",
  );
  const branch = parseJsonStringField(workspaceResult.stdout, "branchName");

  printStage("BOOTSTRAP");
  const bootstrapResult = await runCli([
    "bootstrap",
    "--repo",
    repository,
    "--workspace",
    workspaceRoot,
  ]);
  requireSuccessfulCommand("Workspace bootstrap", bootstrapResult);

  printStage("BASELINE VALIDATION");
  const baselineResult = await runCli([
    "validate",
    "--workspace",
    workspaceRoot,
    "--task",
    "BASELINE",
  ]);
  requireSuccessfulCommand("Baseline validation", baselineResult);
  const baselineValidationReportPath = parseValidationReportPath(
    baselineResult.stdout,
  );

  if (!validationPassed(baselineResult.stdout)) {
    throw new Error(
      [
        "ForgeLoop stopped because the isolated workspace did not establish a clean baseline.",
        `Baseline report: ${baselineValidationReportPath}`,
      ].join("\n"),
    );
  }

  printStage("IMPLEMENTATION");
  const implementationResult = await runCli([
    "implement",
    "--repo",
    repository,
    "--workspace",
    workspaceRoot,
    "--require-source-name",
    requireSourceName,
    "--plan",
    planReportPath,
    "--task",
    input.task,
    "--model",
    input.model ?? "qwen3.5:9b",
  ]);

  const implementationStatus = parseImplementationStatus(
    implementationResult.stdout,
  );

  /*
   * Implementation exit codes have different semantics
   * from deterministic pipeline gates.
   *
   * Exit 0:
   *   Agent completed normally.
   *
   * Exit 2 + max_turns_reached:
   *   The bounded agent session ended without declaring
   *   completion. This is NOT candidate failure.
   *
   *   If meaningful repository changes exist, ForgeLoop
   *   must preserve the candidate and let deterministic
   *   validation decide whether it is acceptable.
   *
   * Any other non-zero result:
   *   Treat as an actual implementation-stage failure.
   */
  const boundedAgentStop =
    implementationResult.exitCode === 2 &&
    implementationStatus === "max_turns_reached";

  if (implementationResult.exitCode !== 0 && !boundedAgentStop) {
    throw new Error(
      [
        `Implementation agent command failed with exit code ${implementationResult.exitCode}.`,
        `Implementation status: ${implementationStatus}`,
        implementationResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (boundedAgentStop) {
    console.log("");
    console.log(
      [
        "Implementation agent reached its bounded turn limit.",
        "ForgeLoop will inspect the resulting candidate and",
        "allow deterministic validation to determine success.",
      ].join(" "),
    );
  }

  const meaningfulStatus = await gitMeaningfulStatus(workspaceRoot);
  if (meaningfulStatus.length === 0) {
    throw new Error(
      [
        "ForgeLoop stopped because the implementation agent produced no meaningful repository changes.",
        `Implementation status: ${implementationStatus}`,
        `Workspace: ${workspaceRoot}`,
      ].join("\n"),
    );
  }

  printStage("AUTHORITATIVE VALIDATION");
  const validationResult = await runCli([
    "validate",
    "--workspace",
    workspaceRoot,
    "--task",
    input.task,
  ]);
  requireSuccessfulCommand(
    "Authoritative deterministic validation",
    validationResult,
  );
  const finalValidationReportPath = parseValidationReportPath(
    validationResult.stdout,
  );

  if (!validationPassed(validationResult.stdout)) {
    throw new Error(
      [
        "ForgeLoop rejected the candidate because deterministic validation failed.",
        `Validation report: ${finalValidationReportPath}`,
        `Workspace preserved for inspection: ${workspaceRoot}`,
      ].join("\n"),
    );
  }

  printStage("INDEPENDENT REVIEW");
  const reviewResult = await runCli([
    "review",
    "--workspace",
    workspaceRoot,
    "--validation-report",
    finalValidationReportPath,
    "--task",
    input.task,
  ]);
  requireSuccessfulCommand("Independent review", reviewResult);
  const reviewReportPath = parseReviewReportPath(reviewResult.stdout);

  if (!reviewApproved(reviewResult.stdout)) {
    throw new Error(
      [
        "ForgeLoop rejected the candidate because the independent reviewer did not approve it.",
        `Review report: ${reviewReportPath}`,
        `Workspace preserved for inspection: ${workspaceRoot}`,
      ].join("\n"),
    );
  }

  let publish: PublishPullRequestResult | undefined;

  if (input.createPr) {
    printStage("PUBLISH");
    publish = await publishPullRequest({
      workspaceRoot,
      task: input.task,
      validationReportPath: finalValidationReportPath,
      reviewReportPath,
      model: input.model ?? "qwen3.5:9b",
      runId: path.basename(workspaceRoot),
      baseBranch: input.baseBranch,
    });
  }

  printStage("COMPLETE");
  console.log(`Repository: ${repository}`);
  console.log(`Task: ${input.task}`);
  console.log("Planning: PASS");
  console.log("Workspace: PASS");
  console.log("Baseline: PASS");
  console.log(`Implementation: ${implementationStatus}`);
  console.log("Deterministic validation: PASS");
  console.log("Independent review: APPROVED");
  console.log(`Branch: ${branch}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Pull Request: ${publish?.pullRequestUrl ?? "(not requested)"}`);
  console.log("");
  console.log("FORGELOOP_RUN_COMPLETE");

  return {
    repository,
    task: input.task,
    planReportPath,
    workspaceRoot,
    branch,
    baselineValidationReportPath,
    implementationStatus,
    finalValidationReportPath,
    reviewReportPath,
    publish,
  };
}
