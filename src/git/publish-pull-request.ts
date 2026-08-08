import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BLOCKED_PUBLISH_FILES = new Set([
  ".env",
  ".env.local",
  ".env.test",
  ".env.production",
  ".env.development",
  ".env.development.local",
  ".env.production.local",
]);

const ALLOWED_ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

export interface PublishPullRequestInput {
  workspaceRoot: string;
  task: string;
  validationReportPath?: string;
  reviewReportPath?: string;
  model?: string;
  runId?: string;
  baseBranch?: string;
  commitMessage?: string;
  title?: string;
}

export interface PublishPullRequestResult {
  branch: string;
  baseBranch: string;
  commitSha: string;
  changedFiles: string[];
  pullRequestUrl: string;
  reusedExistingPullRequest: boolean;
}

async function exec(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: 20 * 1024 * 1024,
    });

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: 0,
    };
  } catch (error) {
    const executionError = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };

    const numericExitCode =
      typeof executionError.code === "number"
        ? executionError.code
        : Number(executionError.code);

    if (options.allowFailure) {
      return {
        stdout: executionError.stdout?.trim() ?? "",
        stderr:
          executionError.stderr?.trim() ??
          executionError.message ??
          "Command failed.",
        exitCode: Number.isFinite(numericExitCode) ? numericExitCode : 1,
      };
    }

    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        executionError.stdout?.trim(),
        executionError.stderr?.trim(),
        executionError.message,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function git(
  workspaceRoot: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
) {
  return exec("git", ["-C", workspaceRoot, ...args], options);
}

function normalizeRepositoryPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isBootstrapOnlyPath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);
  return (
    normalized === "node_modules" || normalized.startsWith("node_modules/")
  );
}

function isBlockedPublishPath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);
  const filename = normalized.split("/").filter(Boolean).at(-1);

  if (!filename) return false;
  if (ALLOWED_ENV_TEMPLATES.has(filename)) return false;

  return (
    BLOCKED_PUBLISH_FILES.has(filename) ||
    (filename.startsWith(".env.") && !ALLOWED_ENV_TEMPLATES.has(filename))
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function getChangedFiles(workspaceRoot: string): Promise<string[]> {
  const [tracked, staged, untracked] = await Promise.all([
    git(workspaceRoot, ["diff", "HEAD", "--name-only"]),
    git(workspaceRoot, ["diff", "--cached", "--name-only"]),
    git(workspaceRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  return unique(
    [tracked.stdout, staged.stdout, untracked.stdout]
      .flatMap((output) => output.split("\n"))
      .map((filePath) => filePath.trim())
      .filter(Boolean)
      .map(normalizeRepositoryPath)
      .filter((filePath) => !isBootstrapOnlyPath(filePath)),
  );
}

function taskTitle(task: string, prefix = "ForgeLoop: "): string {
  const compact = task.replace(/\s+/g, " ").trim();
  const maximumTaskLength = Math.max(20, 72 - prefix.length);

  if (compact.length <= maximumTaskLength) {
    return `${prefix}${compact}`;
  }

  return `${prefix}${compact.slice(0, maximumTaskLength - 1).trimEnd()}…`;
}

async function detectBaseBranch(workspaceRoot: string): Promise<string> {
  const originHead = await git(
    workspaceRoot,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true },
  );

  if (originHead.exitCode === 0 && originHead.stdout.startsWith("origin/")) {
    return originHead.stdout.slice("origin/".length);
  }

  for (const candidate of ["main", "master"]) {
    const exists = await git(
      workspaceRoot,
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
      { allowFailure: true },
    );
    if (exists.exitCode === 0) return candidate;
  }

  throw new Error(
    "Unable to determine the remote base branch. Pass --base explicitly.",
  );
}

async function readOptionalJson(
  filePath?: string,
): Promise<unknown | undefined> {
  if (!filePath) return undefined;
  const raw = await readFile(path.resolve(filePath), "utf8");
  return JSON.parse(raw) as unknown;
}

function reportSaysValidationPassed(report: unknown): boolean | undefined {
  if (typeof report !== "object" || report === null) {
    return undefined;
  }

  const objectValue = report as {
    passed?: unknown;
    result?: unknown;
  };

  if (typeof objectValue.passed === "boolean") {
    return objectValue.passed;
  }

  if (typeof objectValue.result === "object" && objectValue.result !== null) {
    const nestedPassed = (
      objectValue.result as {
        passed?: unknown;
      }
    ).passed;

    if (typeof nestedPassed === "boolean") {
      return nestedPassed;
    }
  }

  return undefined;
}

function findReviewObject(
  value: unknown,
):
  | { verdict?: unknown; taskSatisfied?: unknown; findings?: unknown }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const objectValue = value as Record<string, unknown>;

  if ("verdict" in objectValue || "taskSatisfied" in objectValue) {
    return {
      verdict: objectValue.verdict,
      taskSatisfied: objectValue.taskSatisfied,
      findings: objectValue.findings,
    };
  }

  for (const child of Object.values(objectValue)) {
    const found = findReviewObject(child);
    if (found) return found;
  }

  return undefined;
}

function reportSaysReviewApproved(report: unknown): boolean | undefined {
  const review = findReviewObject(report);
  if (!review) return undefined;
  if (review.verdict !== "approve" || review.taskSatisfied !== true)
    return false;

  if (Array.isArray(review.findings)) {
    const hasBlockingFinding = review.findings.some((finding) => {
      if (typeof finding !== "object" || finding === null) return false;
      return (finding as { severity?: unknown }).severity === "blocking";
    });
    if (hasBlockingFinding) return false;
  }

  return true;
}

async function assertGhAvailable(workspaceRoot: string): Promise<void> {
  const version = await exec("gh", ["--version"], {
    cwd: workspaceRoot,
    allowFailure: true,
  });

  if (version.exitCode !== 0) {
    throw new Error(
      "GitHub CLI (`gh`) is required for --create-pr but was not found.",
    );
  }

  const auth = await exec("gh", ["auth", "status"], {
    cwd: workspaceRoot,
    allowFailure: true,
  });

  if (auth.exitCode !== 0) {
    throw new Error(
      [
        "GitHub CLI is installed but is not authenticated.",
        "Run: gh auth login",
        auth.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function buildPullRequestBody(input: {
  task: string;
  changedFiles: string[];
  validationReportPath?: string;
  reviewReportPath?: string;
  model?: string;
  runId?: string;
}): string {
  const changedFileLines = input.changedFiles
    .map((filePath) => `- \`${filePath}\``)
    .join("\n");

  return [
    "## Task",
    "",
    input.task,
    "",
    "## Files changed",
    "",
    changedFileLines || "- (none)",
    "",
    "## ForgeLoop gates",
    "",
    "- Deterministic validation: **PASS**",
    "- Independent review: **APPROVED**",
    "",
    "## Run metadata",
    "",
    `- Model: \`${input.model ?? "qwen3.5:9b"}\``,
    `- Run ID: \`${input.runId ?? "not-recorded"}\``,
    input.validationReportPath
      ? `- Validation report: \`${input.validationReportPath}\``
      : "- Validation report: not recorded",
    input.reviewReportPath
      ? `- Review report: \`${input.reviewReportPath}\``
      : "- Review report: not recorded",
    "",
    "---",
    "Generated by ForgeLoop after deterministic validation and independent review.",
  ].join("\n");
}

export async function publishPullRequest(
  input: PublishPullRequestInput,
): Promise<PublishPullRequestResult> {
  const workspaceRoot = await realpath(input.workspaceRoot);

  const insideWorktree = await git(workspaceRoot, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);

  if (insideWorktree.stdout !== "true") {
    throw new Error("Publish target is not a Git worktree.");
  }

  const branch = (
    await git(workspaceRoot, ["branch", "--show-current"])
  ).stdout.trim();

  if (!branch.startsWith("forgeloop/")) {
    throw new Error(
      `Refusing to publish non-ForgeLoop branch: ${branch || "(detached HEAD)"}`,
    );
  }

  const validationReport = await readOptionalJson(input.validationReportPath);
  if (
    validationReport !== undefined &&
    reportSaysValidationPassed(validationReport) !== true
  ) {
    throw new Error(
      "Refusing to publish because the supplied deterministic validation report is not passing.",
    );
  }

  const reviewReport = await readOptionalJson(input.reviewReportPath);
  if (
    reviewReport !== undefined &&
    reportSaysReviewApproved(reviewReport) !== true
  ) {
    throw new Error(
      "Refusing to publish because the supplied review report is not approved or contains a blocking finding.",
    );
  }

  const changedFiles = await getChangedFiles(workspaceRoot);
  if (changedFiles.length === 0) {
    throw new Error(
      "Refusing to publish because there are no meaningful repository changes.",
    );
  }

  const blockedFiles = changedFiles.filter(isBlockedPublishPath);
  if (blockedFiles.length > 0) {
    throw new Error(
      [
        "Refusing to publish runtime environment or secret-like files:",
        ...blockedFiles.map((filePath) => `- ${filePath}`),
      ].join("\n"),
    );
  }

  await assertGhAvailable(workspaceRoot);

  const origin = await git(workspaceRoot, ["remote", "get-url", "origin"], {
    allowFailure: true,
  });

  if (origin.exitCode !== 0 || origin.stdout.trim().length === 0) {
    throw new Error(
      "Refusing to publish because the worktree does not have an origin remote.",
    );
  }

  for (const filePath of changedFiles) {
    await git(workspaceRoot, ["add", "-A", "--", filePath]);
  }

  const stagedDiff = await git(workspaceRoot, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });

  if (stagedDiff.exitCode === 0) {
    throw new Error(
      "No staged repository changes remain after filtering bootstrap-only paths.",
    );
  }

  const commitMessage = input.commitMessage ?? taskTitle(input.task);
  await git(workspaceRoot, ["commit", "-m", commitMessage]);

  const commitSha = (await git(workspaceRoot, ["rev-parse", "HEAD"])).stdout;

  await git(workspaceRoot, ["push", "-u", "origin", branch]);

  const baseBranch =
    input.baseBranch ?? (await detectBaseBranch(workspaceRoot));

  const existingPr = await exec(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ],
    { cwd: workspaceRoot, allowFailure: true },
  );

  if (existingPr.exitCode === 0 && existingPr.stdout.trim().length > 0) {
    return {
      branch,
      baseBranch,
      commitSha,
      changedFiles,
      pullRequestUrl: existingPr.stdout.trim(),
      reusedExistingPullRequest: true,
    };
  }

  const created = await exec(
    "gh",
    [
      "pr",
      "create",
      "--base",
      baseBranch,
      "--head",
      branch,
      "--title",
      input.title ?? taskTitle(input.task),
      "--body",
      buildPullRequestBody({
        task: input.task,
        changedFiles,
        validationReportPath: input.validationReportPath,
        reviewReportPath: input.reviewReportPath,
        model: input.model,
        runId: input.runId,
      }),
    ],
    { cwd: workspaceRoot },
  );

  const pullRequestUrl = created.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line));

  if (!pullRequestUrl) {
    throw new Error(
      `GitHub CLI created the PR but ForgeLoop could not parse its URL.\n${created.stdout}`,
    );
  }

  return {
    branch,
    baseBranch,
    commitSha,
    changedFiles,
    pullRequestUrl,
    reusedExistingPullRequest: false,
  };
}
