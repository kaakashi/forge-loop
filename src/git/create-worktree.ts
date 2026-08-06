import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeDetails {
  runId: string;
  branchName: string;
  worktreePath: string;
  baseCommit: string;
}

export interface CreateWorktreeInput {
  repositoryRoot: string;
  task: string;
  outputRoot?: string;
}

async function git(
  repositoryRoot: string,
  args: string[],
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return execFileAsync("git", ["-C", repositoryRoot, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function createTimestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function createTaskSlug(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "engineering-task";
}

export async function createIsolatedWorktree(
  input: CreateWorktreeInput,
): Promise<WorktreeDetails> {
  const repositoryRoot = path.resolve(input.repositoryRoot);

  const status = await git(repositoryRoot, ["status", "--porcelain"]);

  if (status.stdout.trim()) {
    throw new Error(
      [
        "The target repository contains uncommitted changes.",
        "Commit or stash them before creating an agent worktree.",
        "ForgeLoop worktrees are intentionally based on a committed Git state.",
      ].join(" "),
    );
  }

  const baseCommitResult = await git(repositoryRoot, ["rev-parse", "HEAD"]);

  const baseCommit = baseCommitResult.stdout.trim();

  const runId = [createTimestamp(), randomUUID().slice(0, 8)].join("-");

  const taskSlug = createTaskSlug(input.task);

  const branchName = `forgeloop/${taskSlug}-${runId}`;

  const outputRoot = input.outputRoot ?? path.resolve("generated-worktrees");

  const repositoryName = path.basename(repositoryRoot);

  const worktreePath = path.join(outputRoot, repositoryName, runId);

  if (await pathExists(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  await mkdir(path.dirname(worktreePath), {
    recursive: true,
  });

  await git(repositoryRoot, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    baseCommit,
  ]);

  return {
    runId,
    branchName,
    worktreePath,
    baseCommit,
  };
}
