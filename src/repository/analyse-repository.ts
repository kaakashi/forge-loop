import { execFile } from "child_process";
import { access, readFile } from "fs/promises";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

const IMPORTANT_FILES = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "manage.py",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/test.yml",
];

const MAX_TRACKED_FILES = 500;
const MAX_FILE_CONTENT_LENGTH = 8_000;

export interface RepositoryContext {
  root: string;
  trackedFiles: string[];
  importantFiles: Record<string, string>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveGitRoot(repositoryPath: string): Promise<string> {
  const absolutePath = path.resolve(repositoryPath);

  try {
    const result = await execFileAsync(
      "git",
      ["-C", absolutePath, "rev-parse", "--show-toplevel"],
      {
        maxBuffer: 1024 * 1024,
      },
    );

    return result.stdout.trim();
  } catch (error) {
    throw new Error(
      `The supplied path is not a valid Git repository: ${absolutePath}`,
      {
        cause: error,
      },
    );
  }
}

async function getTrackedFiles(root: string): Promise<string[]> {
  const result = await execFileAsync("git", ["-C", root, "ls-files"], {
    maxBuffer: 10 * 1024 * 1024,
  });

  return result.stdout
    .split("\n")
    .map((file: string) => file.trim())
    .filter(Boolean)
    .slice(0, MAX_TRACKED_FILES);
}

async function readImportantFiles(
  root: string,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};

  for (const relativePath of IMPORTANT_FILES) {
    const absolutePath = path.join(root, relativePath);

    if (!(await fileExists(absolutePath))) {
      continue;
    }

    const rawContent = await readFile(absolutePath, "utf8");

    contents[relativePath] = rawContent.slice(0, MAX_FILE_CONTENT_LENGTH);
  }

  return contents;
}

export async function analyseRepository(
  repositoryPath: string,
): Promise<RepositoryContext> {
  const root = await resolveGitRoot(repositoryPath);
  const trackedFiles = await getTrackedFiles(root);
  const importantFiles = await readImportantFiles(root);

  return {
    root,
    trackedFiles,
    importantFiles,
  };
}
