import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARACTERS = 20_000;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ValidationCheck {
  script: string;
  command: string;
  passed: boolean;
  exitCode?: number | string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ValidationResult {
  passed: boolean;
  startedAt: string;
  completedAt: string;
  packageManager: string;
  checks: ValidationCheck[];
  failedChecks: string[];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARACTERS) {
    return value;
  }

  return [
    value.slice(0, MAX_OUTPUT_CHARACTERS),
    "",
    `[TRUNCATED ${value.length - MAX_OUTPUT_CHARACTERS} CHARACTERS]`,
  ].join("\n");
}

async function loadPackageScripts(
  workspaceRoot: string,
): Promise<Record<string, string>> {
  const packageJsonPath = path.join(workspaceRoot, "package.json");

  if (!(await pathExists(packageJsonPath))) {
    throw new Error(`package.json not found in ${workspaceRoot}`);
  }

  const rawContent = await readFile(packageJsonPath, "utf8");

  const parsed: unknown = JSON.parse(rawContent);

  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return {};
  }

  const scripts = (
    parsed as {
      scripts?: unknown;
    }
  ).scripts;

  if (typeof scripts !== "object" || scripts === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function detectPackageManager(
  workspaceRoot: string,
): Promise<PackageManager> {
  if (await pathExists(path.join(workspaceRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (await pathExists(path.join(workspaceRoot, "yarn.lock"))) {
    return "yarn";
  }

  if (
    (await pathExists(path.join(workspaceRoot, "bun.lockb"))) ||
    (await pathExists(path.join(workspaceRoot, "bun.lock")))
  ) {
    return "bun";
  }

  return "npm";
}

function selectValidationScripts(
  packageScripts: Record<string, string>,
): string[] {
  const selected = new Set<string>();

  if (packageScripts.typecheck) {
    selected.add("typecheck");
  }

  if (packageScripts.lint) {
    selected.add("lint");
  }

  /*
   * During the MVP, correctness is more important
   * than avoiding some duplicate test execution.
   *
   * Run every meaningful test surface the repository
   * explicitly exposes.
   */
  if (packageScripts["test:unit"]) {
    selected.add("test:unit");
  }

  if (packageScripts["test:integration"]) {
    selected.add("test:integration");
  }

  if (packageScripts.test) {
    selected.add("test");
  }

  return [...selected];
}

function buildCommand(
  packageManager: PackageManager,
  script: string,
): {
  command: string;
  args: string[];
} {
  switch (packageManager) {
    case "pnpm":
      return {
        command: "pnpm",
        args: ["run", script],
      };

    case "yarn":
      return {
        command: "yarn",
        args: [script],
      };

    case "bun":
      return {
        command: "bun",
        args: ["run", script],
      };

    default:
      return {
        command: "npm",
        args: ["run", script],
      };
  }
}

async function runCheck(input: {
  workspaceRoot: string;
  packageManager: PackageManager;
  script: string;
}): Promise<ValidationCheck> {
  const command = buildCommand(input.packageManager, input.script);

  const startedAt = Date.now();

  try {
    const result = await execFileAsync(command.command, command.args, {
      cwd: input.workspaceRoot,

      timeout: COMMAND_TIMEOUT_MS,

      maxBuffer: 20 * 1024 * 1024,

      env: {
        ...process.env,
        CI: "1",
      },
    });

    return {
      script: input.script,

      command: [command.command, ...command.args].join(" "),

      passed: true,

      durationMs: Date.now() - startedAt,

      stdout: truncate(result.stdout),

      stderr: truncate(result.stderr),
    };
  } catch (error) {
    const executionError = error as {
      code?: number | string;

      stdout?: string;

      stderr?: string;

      message?: string;
    };

    return {
      script: input.script,

      command: [command.command, ...command.args].join(" "),

      passed: false,

      exitCode: executionError.code,

      durationMs: Date.now() - startedAt,

      stdout: truncate(executionError.stdout ?? ""),

      stderr: truncate(executionError.stderr ?? executionError.message ?? ""),
    };
  }
}

function normalizeRepositoryPath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/");
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);

  return (
    /(^|\/)(tests?|__tests__)(\/|$)/.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function taskRequiresTestChanges(task: string): boolean {
  return (
    /\b(add|write|create|include|modify|update)\b.{0,30}\btests?\b/i.test(
      task,
    ) ||
    /\bautomated tests?\b/i.test(task) ||
    /\btest coverage\b/i.test(task)
  );
}

async function getChangedFiles(workspaceRoot: string): Promise<string[]> {
  /*
   * `git diff HEAD` gives us tracked changes,
   * including both staged and unstaged changes.
   */
  const trackedResult = await execFileAsync(
    "git",
    ["diff", "HEAD", "--name-only"],
    {
      cwd: workspaceRoot,

      timeout: COMMAND_TIMEOUT_MS,

      maxBuffer: 5 * 1024 * 1024,
    },
  );

  /*
   * `git diff` does not include genuinely new,
   * untracked files, so collect those separately.
   */
  const untrackedResult = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd: workspaceRoot,

      timeout: COMMAND_TIMEOUT_MS,

      maxBuffer: 5 * 1024 * 1024,
    },
  );

  const trackedFiles = trackedResult.stdout
    .split("\n")
    .map(normalizeRepositoryPath)
    .filter(Boolean);

  const untrackedFiles = untrackedResult.stdout
    .split("\n")
    .map(normalizeRepositoryPath)
    .filter(Boolean);

  return [...new Set([...trackedFiles, ...untrackedFiles])].filter(
    (filePath) => filePath !== "node_modules" && filePath !== "node_modules/",
  );
}

async function runRequiredTestChangeCheck(input: {
  workspaceRoot: string;
  task: string;
}): Promise<ValidationCheck | undefined> {
  /*
   * This gate exists only when the user's task
   * explicitly requires a test change.
   *
   * Normal tasks are unaffected.
   *
   * "BASELINE" is therefore also unaffected.
   */
  if (!taskRequiresTestChanges(input.task)) {
    return undefined;
  }

  const startedAt = Date.now();

  try {
    const changedFiles = await getChangedFiles(input.workspaceRoot);

    const changedTestFiles = changedFiles.filter(isTestPath);

    const passed = changedTestFiles.length > 0;

    return {
      script: "task:test-change",

      command:
        "git diff HEAD --name-only && git ls-files --others --exclude-standard",

      passed,

      durationMs: Date.now() - startedAt,

      stdout: truncate(
        [
          "Task explicitly requires automated tests.",
          "",
          "Changed repository files:",
          changedFiles.length > 0
            ? changedFiles.map((file) => `- ${file}`).join("\n")
            : "(none)",
          "",
          "Changed test files:",
          changedTestFiles.length > 0
            ? changedTestFiles.map((file) => `- ${file}`).join("\n")
            : "(none)",
        ].join("\n"),
      ),

      stderr: passed
        ? ""
        : [
            "The engineering task explicitly requires automated tests,",
            "but ForgeLoop detected no modified or newly-created test files.",
            "",
            "The candidate does not satisfy the task requirements.",
          ].join(" "),
    };
  } catch (error) {
    const executionError = error as {
      code?: number | string;

      stdout?: string;

      stderr?: string;

      message?: string;
    };

    return {
      script: "task:test-change",

      command:
        "git diff HEAD --name-only && git ls-files --others --exclude-standard",

      passed: false,

      exitCode: executionError.code,

      durationMs: Date.now() - startedAt,

      stdout: truncate(executionError.stdout ?? ""),

      stderr: truncate(
        executionError.stderr ??
          executionError.message ??
          "Unable to inspect repository changes.",
      ),
    };
  }
}

export async function runValidation(
  workspaceRootInput: string,
  task: string,
): Promise<ValidationResult> {
  const workspaceRoot = path.resolve(workspaceRootInput);

  const scripts = await loadPackageScripts(workspaceRoot);

  const packageManager = await detectPackageManager(workspaceRoot);

  const validationScripts = selectValidationScripts(scripts);

  if (validationScripts.length === 0) {
    throw new Error(
      [
        "ForgeLoop could not find",
        "typecheck, lint, test:unit, test:integration",
        "or test scripts in package.json.",
      ].join(" "),
    );
  }

  const startedAt = new Date().toISOString();

  const checks: ValidationCheck[] = [];

  /*
   * First enforce task requirements that can be
   * proven mechanically.
   *
   * Example:
   *
   * "add automated tests"
   *
   * must result in at least one changed test file.
   */
  const requiredTestChangeCheck = await runRequiredTestChangeCheck({
    workspaceRoot,
    task,
  });

  if (requiredTestChangeCheck) {
    console.log("Running validation: task:test-change...");

    checks.push(requiredTestChangeCheck);

    console.log(
      requiredTestChangeCheck.passed
        ? "PASS: task:test-change"
        : "FAIL: task:test-change",
    );
  }

  /*
   * Run package checks sequentially.
   *
   * This keeps logs deterministic and avoids
   * unnecessarily overloading a developer machine.
   *
   * We deliberately continue even if the structural
   * task gate failed so the validation report contains
   * complete evidence about the candidate.
   */
  for (const script of validationScripts) {
    console.log(`Running validation: ${script}...`);

    const result = await runCheck({
      workspaceRoot,
      packageManager,
      script,
    });

    checks.push(result);

    console.log(result.passed ? `PASS: ${script}` : `FAIL: ${script}`);
  }

  const failedChecks = checks
    .filter((check) => !check.passed)
    .map((check) => check.script);

  return {
    passed: failedChecks.length === 0,

    startedAt,

    completedAt: new Date().toISOString(),

    packageManager,

    checks,

    failedChecks,
  };
}
