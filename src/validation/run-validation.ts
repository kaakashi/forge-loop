import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARACTERS = 20_000;

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
): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
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

function selectValidationScripts(scripts: Record<string, string>): string[] {
  const selected: string[] = [];

  if ("typecheck" in scripts) {
    selected.push("typecheck");
  }

  if ("lint" in scripts) {
    selected.push("lint");
  }

  /*
   * Prefer the targeted integration suite.
   * If there isn't one, fall back to the
   * repository's normal test script.
   */
  if ("test:integration" in scripts) {
    selected.push("test:integration");
  } else if ("test" in scripts) {
    selected.push("test");
  }

  return selected;
}

function buildCommand(
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
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
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
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

export async function runValidation(
  workspaceRootInput: string,
): Promise<ValidationResult> {
  const workspaceRoot = path.resolve(workspaceRootInput);

  const scripts = await loadPackageScripts(workspaceRoot);

  const packageManager = await detectPackageManager(workspaceRoot);

  const validationScripts = selectValidationScripts(scripts);

  if (validationScripts.length === 0) {
    throw new Error(
      [
        "ForgeLoop could not find",
        "typecheck, lint, test:integration",
        "or test scripts in package.json.",
      ].join(" "),
    );
  }

  const startedAt = new Date().toISOString();

  const checks: ValidationCheck[] = [];

  /*
   * Run sequentially.
   *
   * This keeps logs deterministic and avoids
   * overloading a developer machine.
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
