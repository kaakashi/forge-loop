import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 180_000;

const ENV_FILES = [".env", ".env.local", ".env.test", ".env.development.local"];

export interface BootstrapStep {
  name: string;
  status: "completed" | "skipped";
  detail: string;
}

export interface BootstrapResult {
  sourceRepositoryRoot: string;
  workspaceRoot: string;
  steps: BootstrapStep[];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(targetPath: string): Promise<void> {
  const stats = await lstat(targetPath);

  if (!stats.isDirectory()) {
    throw new Error(`Expected directory: ${targetPath}`);
  }
}

async function prepareNodeModules(
  sourceRepositoryRoot: string,
  workspaceRoot: string,
): Promise<BootstrapStep> {
  const sourceNodeModules = path.join(sourceRepositoryRoot, "node_modules");

  const workspaceNodeModules = path.join(workspaceRoot, "node_modules");

  if (await pathExists(workspaceNodeModules)) {
    const stats = await lstat(workspaceNodeModules);

    if (!stats.isSymbolicLink() && !stats.isDirectory()) {
      throw new Error(
        "workspace/node_modules exists but is neither a directory nor a symbolic link.",
      );
    }

    return {
      name: "dependencies",
      status: "skipped",
      detail: "Workspace already has node_modules.",
    };
  }

  if (!(await pathExists(sourceNodeModules))) {
    throw new Error(
      [
        "Source repository does not have node_modules.",
        "ForgeLoop will not automatically install packages during bootstrap.",
        `Run dependency installation in: ${sourceRepositoryRoot}`,
      ].join(" "),
    );
  }

  await assertDirectory(sourceNodeModules);

  await symlink(sourceNodeModules, workspaceNodeModules, "dir");

  return {
    name: "dependencies",
    status: "completed",
    detail: "Linked source repository node_modules into the isolated worktree.",
  };
}

async function copyRuntimeEnvironment(
  sourceRepositoryRoot: string,
  workspaceRoot: string,
): Promise<BootstrapStep> {
  const copiedFiles: string[] = [];

  for (const filename of ENV_FILES) {
    const sourcePath = path.join(sourceRepositoryRoot, filename);

    const workspacePath = path.join(workspaceRoot, filename);

    if (!(await pathExists(sourcePath))) {
      continue;
    }

    if (await pathExists(workspacePath)) {
      continue;
    }

    await copyFile(sourcePath, workspacePath);

    copiedFiles.push(filename);
  }

  if (copiedFiles.length === 0) {
    return {
      name: "environment",
      status: "skipped",
      detail: "No runtime environment files needed copying.",
    };
  }

  return {
    name: "environment",
    status: "completed",
    detail: `Copied runtime-only environment files: ${copiedFiles.join(", ")}`,
  };
}

async function hasPrisma(workspaceRoot: string): Promise<boolean> {
  const schemaPath = path.join(workspaceRoot, "prisma", "schema.prisma");

  if (await pathExists(schemaPath)) {
    return true;
  }

  const packageJsonPath = path.join(workspaceRoot, "package.json");

  if (!(await pathExists(packageJsonPath))) {
    return false;
  }

  try {
    const raw = await readFile(packageJsonPath, "utf8");

    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    return Boolean(
      parsed.dependencies?.prisma ||
      parsed.devDependencies?.prisma ||
      parsed.dependencies?.["@prisma/client"] ||
      parsed.devDependencies?.["@prisma/client"],
    );
  } catch {
    return false;
  }
}

async function generatePrismaArtifacts(
  workspaceRoot: string,
): Promise<BootstrapStep> {
  if (!(await hasPrisma(workspaceRoot))) {
    return {
      name: "prisma-generate",
      status: "skipped",
      detail: "Repository does not appear to use Prisma.",
    };
  }

  const prismaBinary = path.join(
    workspaceRoot,
    "node_modules",
    ".bin",
    "prisma",
  );

  if (!(await pathExists(prismaBinary))) {
    throw new Error(
      [
        "Prisma was detected but its local CLI is unavailable.",
        `Expected: ${prismaBinary}`,
      ].join(" "),
    );
  }

  try {
    const result = await execFileAsync(
      prismaBinary,
      ["generate", "--no-hints"],
      {
        cwd: workspaceRoot,

        timeout: COMMAND_TIMEOUT_MS,

        maxBuffer: 20 * 1024 * 1024,

        env: {
          ...process.env,
          CI: "1",
        },
      },
    );

    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    return {
      name: "prisma-generate",

      status: "completed",

      detail: output || "Prisma artifacts generated successfully.",
    };
  } catch (error) {
    const executionError = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    throw new Error(
      [
        "Prisma generation failed.",
        executionError.stdout ?? "",
        executionError.stderr ?? "",
        executionError.message ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

export async function bootstrapWorkspace(input: {
  sourceRepository: string;
  workspace: string;
}): Promise<BootstrapResult> {
  const sourceRepositoryRoot = await realpath(input.sourceRepository);

  const workspaceRoot = await realpath(input.workspace);

  /*
   * Never bootstrap the source repository itself.
   */
  if (sourceRepositoryRoot === workspaceRoot) {
    throw new Error("Refusing to bootstrap the source repository directly.");
  }

  await mkdir(workspaceRoot, {
    recursive: true,
  });

  const steps: BootstrapStep[] = [];

  steps.push(await prepareNodeModules(sourceRepositoryRoot, workspaceRoot));

  /*
   * Environment files are runtime-only.
   * The coding agent will be explicitly blocked
   * from reading them.
   */
  steps.push(await copyRuntimeEnvironment(sourceRepositoryRoot, workspaceRoot));

  /*
   * Prisma Client is generated from the
   * repository's own schema/configuration.
   */
  steps.push(await generatePrismaArtifacts(workspaceRoot));

  return {
    sourceRepositoryRoot,
    workspaceRoot,
    steps,
  };
}
