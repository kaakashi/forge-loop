import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });

  return result.stdout.trim();
}

async function resolveGitRoot(repositoryPath: string): Promise<string> {
  const root = await git(path.resolve(repositoryPath), [
    "rev-parse",
    "--show-toplevel",
  ]);

  return realpath(root);
}

async function resolveGitCommonDirectory(
  repositoryRoot: string,
): Promise<string> {
  const commonDirectory = await git(repositoryRoot, [
    "rev-parse",
    "--git-common-dir",
  ]);

  const absolutePath = path.isAbsolute(commonDirectory)
    ? commonDirectory
    : path.resolve(repositoryRoot, commonDirectory);

  return realpath(absolutePath);
}

async function validateRuntimeNodeModules(
  sourceRepositoryRoot: string,
  workspaceRoot: string,
): Promise<void> {
  const workspaceNodeModules = path.join(workspaceRoot, "node_modules");

  const sourceNodeModules = path.join(sourceRepositoryRoot, "node_modules");

  let stats;

  try {
    stats = await lstat(workspaceNodeModules);
  } catch {
    throw new Error(
      [
        "node_modules appears in workspace Git status",
        "but the path could not be inspected.",
      ].join(" "),
    );
  }

  if (!stats.isSymbolicLink()) {
    throw new Error(
      [
        "ForgeLoop only permits node_modules",
        "inside an agent workspace when it is",
        "a symbolic link to the demo source repository.",
      ].join(" "),
    );
  }

  let actualTarget: string;
  let expectedTarget: string;

  try {
    actualTarget = await realpath(workspaceNodeModules);

    expectedTarget = await realpath(sourceNodeModules);
  } catch {
    throw new Error(
      [
        "Unable to resolve the workspace",
        "node_modules symlink or its expected target.",
      ].join(" "),
    );
  }

  if (actualTarget !== expectedTarget) {
    throw new Error(
      [
        "The workspace node_modules symlink points",
        "to an unexpected location.",
        `Expected: ${expectedTarget}`,
        `Actual: ${actualTarget}`,
      ].join(" "),
    );
  }
}

async function assertWorkspaceCleanExceptRuntimeArtifacts(
  sourceRepositoryRoot: string,
  workspaceRoot: string,
): Promise<void> {
  const status = await git(workspaceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  if (!status) {
    return;
  }

  const statusLines = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const unexpectedChanges: string[] = [];

  let nodeModulesSeen = false;

  for (const line of statusLines) {
    /*
     * Git porcelain format:
     *
     * ?? node_modules
     *
     * We permit exactly this runtime-only artifact.
     */
    if (line === "?? node_modules" || line === "?? node_modules/") {
      nodeModulesSeen = true;
      continue;
    }

    unexpectedChanges.push(line);
  }

  if (nodeModulesSeen) {
    await validateRuntimeNodeModules(sourceRepositoryRoot, workspaceRoot);
  }

  if (unexpectedChanges.length > 0) {
    throw new Error(
      [
        "The agent workspace contains unexpected uncommitted changes.",
        "",
        ...unexpectedChanges,
        "",
        "Use a fresh worktree or reset these changes before starting another implementation run.",
      ].join("\n"),
    );
  }
}

export interface SafeWorkspace {
  sourceRepositoryRoot: string;
  workspaceRoot: string;
  branchName: string;
  baseCommit: string;
}

export async function assertSafeAgentWorkspace(input: {
  sourceRepository: string;
  workspace: string;
  expectedSourceName?: string;
}): Promise<SafeWorkspace> {
  const sourceRepositoryRoot = await resolveGitRoot(input.sourceRepository);

  const workspaceRoot = await resolveGitRoot(input.workspace);

  /*
   * Optional safety guard used by our demo.
   *
   * This makes it much harder to accidentally point
   * ForgeLoop at the real FlowLens repository.
   */
  if (
    input.expectedSourceName &&
    path.basename(sourceRepositoryRoot) !== input.expectedSourceName
  ) {
    throw new Error(
      [
        "Unexpected source repository.",
        `Expected "${input.expectedSourceName}",`,
        `received "${path.basename(sourceRepositoryRoot)}".`,
      ].join(" "),
    );
  }

  /*
   * Never allow the agent to operate directly
   * inside the source repository.
   */
  if (sourceRepositoryRoot === workspaceRoot) {
    throw new Error(
      [
        "Refusing to run directly inside the source repository.",
        "Provide a generated ForgeLoop worktree instead.",
      ].join(" "),
    );
  }

  /*
   * Every agent workspace must live underneath
   * ForgeLoop's generated-worktrees directory.
   */
  if (!workspaceRoot.split(path.sep).includes("generated-worktrees")) {
    throw new Error(
      [
        "Refusing to run outside generated-worktrees.",
        `Received: ${workspaceRoot}`,
      ].join(" "),
    );
  }

  /*
   * Verify that the workspace is genuinely a
   * worktree belonging to the supplied source repo.
   */
  const sourceCommonDirectory =
    await resolveGitCommonDirectory(sourceRepositoryRoot);

  const workspaceCommonDirectory =
    await resolveGitCommonDirectory(workspaceRoot);

  if (sourceCommonDirectory !== workspaceCommonDirectory) {
    throw new Error(
      [
        "The supplied workspace does not belong",
        "to the supplied source repository.",
      ].join(" "),
    );
  }

  /*
   * ForgeLoop must never operate on main/master
   * or another manually created branch.
   */
  const branchName = await git(workspaceRoot, ["branch", "--show-current"]);

  if (!branchName.startsWith("forgeloop/")) {
    throw new Error(
      [
        "Refusing to run on a non-ForgeLoop branch.",
        `Current branch: ${branchName}`,
      ].join(" "),
    );
  }

  /*
   * Require a clean engineering workspace.
   *
   * The only exception is an intentionally-created
   * node_modules symlink pointing back to the
   * flow-lens-ai-demo dependency directory.
   */
  await assertWorkspaceCleanExceptRuntimeArtifacts(
    sourceRepositoryRoot,
    workspaceRoot,
  );

  const baseCommit = await git(workspaceRoot, ["rev-parse", "HEAD"]);

  return {
    sourceRepositoryRoot,
    workspaceRoot,
    branchName,
    baseCommit,
  };
}
