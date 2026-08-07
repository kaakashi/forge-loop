import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Tool } from "ollama";
import * as z from "zod";

const execFileAsync = promisify(execFile);

const MAX_READ_CHARACTERS = 24_000;
const MAX_WRITE_CHARACTERS = 100_000;
const MAX_TOOL_RESULT_CHARACTERS = 24_000;

const MAX_FILE_WRITES = 10;
const MAX_COMMAND_RUNS = 8;

const BLOCKED_PATH_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
]);

const ALLOWED_SCRIPT_PATTERN =
  /^(test(?::[\w-]+)?|lint(?::[\w-]+)?|typecheck|check(?::[\w-]+)?|format:check|build)$/;

const listFilesSchema = z.object({
  path: z.string().default("."),
  limit: z.number().int().min(1).max(300).default(200),
});

const readFileSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const searchCodeSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().default("."),
  limit: z.number().int().min(1).max(100).default(50),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_WRITE_CHARACTERS),
  mode: z.enum(["create", "overwrite"]),
});

const replaceInFileSchema = z.object({
  path: z.string().min(1),
  search: z.string().min(1).max(40_000),
  replacement: z.string().max(40_000),
  replaceAll: z.boolean().default(false),
});

const runPackageScriptSchema = z.object({
  script: z.string().min(1),
  args: z.array(z.string().max(500)).max(10).default([]),
});

export interface ToolExecutionLog {
  timestamp: string;
  tool: string;
  arguments: unknown;
  success: boolean;
  result: string;
}

export interface WorkspaceToolRuntime {
  definitions: Tool[];

  execute(toolName: string, rawArguments: unknown): Promise<string>;

  getLogs(): ToolExecutionLog[];

  getCounters(): {
    fileWrites: number;
    commandRuns: number;
  };
}

function truncate(value: string, maximum = MAX_TOOL_RESULT_CHARACTERS): string {
  if (value.length <= maximum) {
    return value;
  }

  return [
    value.slice(0, maximum),
    "",
    `[TRUNCATED ${value.length - maximum} CHARACTERS]`,
  ].join("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function containsBlockedSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => BLOCKED_PATH_SEGMENTS.has(segment));
}

function resolveInsideWorkspace(
  workspaceRoot: string,
  relativePath: string,
  options: {
    allowRoot?: boolean;
  } = {},
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not permitted.");
  }

  const normalizedPath = relativePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");

  if (
    !options.allowRoot &&
    (normalizedPath.length === 0 || normalizedPath === ".")
  ) {
    throw new Error("A concrete file path is required.");
  }

  if (containsBlockedSegment(normalizedPath)) {
    throw new Error(`Access to this path is blocked: ${relativePath}`);
  }

  const absolutePath = path.resolve(workspaceRoot, normalizedPath);

  const relativeToRoot = path.relative(workspaceRoot, absolutePath);

  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("The requested path escapes the workspace.");
  }

  return absolutePath;
}

async function assertNoSymlinkSegments(
  workspaceRoot: string,
  absolutePath: string,
): Promise<void> {
  const relativePath = path.relative(workspaceRoot, absolutePath);

  const segments = relativePath.split(path.sep).filter(Boolean);

  let currentPath = workspaceRoot;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);

    if (!(await pathExists(currentPath))) {
      break;
    }

    const stats = await lstat(currentPath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Symbolic-link access is not permitted: ${relativePath}`);
    }
  }
}

async function git(workspaceRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", workspaceRoot, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });

  return result.stdout;
}

async function loadPackageScripts(
  workspaceRoot: string,
): Promise<Record<string, string>> {
  const packageJsonPath = path.join(workspaceRoot, "package.json");

  if (!(await pathExists(packageJsonPath))) {
    return {};
  }

  const rawContent = await readFile(packageJsonPath, "utf8");

  const packageJson: unknown = JSON.parse(rawContent);

  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("scripts" in packageJson)
  ) {
    return {};
  }

  const scripts = (
    packageJson as {
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

function createToolDefinitions(packageScripts: Record<string, string>): Tool[] {
  const permittedScripts = Object.keys(packageScripts).filter((script) =>
    ALLOWED_SCRIPT_PATTERN.test(script),
  );

  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List tracked and newly created files inside the isolated workspace.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Repository-relative directory, normally '.'.",
            },
            limit: {
              type: "number",
              description: "Maximum files to return, up to 300.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a text file inside the isolated workspace with line numbers.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: {
              type: "string",
              description: "Repository-relative file path.",
            },
            startLine: {
              type: "number",
              description: "Optional one-based starting line.",
            },
            endLine: {
              type: "number",
              description: "Optional one-based ending line.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_code",
        description:
          "Search tracked repository files for an exact text or code fragment.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "Text or code fragment to find.",
            },
            path: {
              type: "string",
              description: "Optional repository-relative search path.",
            },
            limit: {
              type: "number",
              description: "Maximum matching lines.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "replace_in_file",
        description:
          "Safely replace an exact text fragment in an existing file. Prefer this over rewriting an entire existing file.",
        parameters: {
          type: "object",
          required: ["path", "search", "replacement"],
          properties: {
            path: {
              type: "string",
              description: "Repository-relative existing file path.",
            },
            search: {
              type: "string",
              description: "Exact existing text to replace.",
            },
            replacement: {
              type: "string",
              description: "Replacement text.",
            },
            replaceAll: {
              type: "boolean",
              description:
                "Replace every exact occurrence instead of exactly one.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create a new file or deliberately overwrite a complete file inside the isolated workspace.",
        parameters: {
          type: "object",
          required: ["path", "content", "mode"],
          properties: {
            path: {
              type: "string",
              description: "Repository-relative file path.",
            },
            content: {
              type: "string",
              description: "Complete file content.",
            },
            mode: {
              type: "string",
              enum: ["create", "overwrite"],
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_package_script",
        description:
          "Run an existing non-interactive validation script from package.json. Package installation and arbitrary shell commands are unavailable.",
        parameters: {
          type: "object",
          required: ["script"],
          properties: {
            script: {
              type: "string",
              enum:
                permittedScripts.length > 0
                  ? permittedScripts
                  : ["NO_ALLOWED_SCRIPTS"],
            },
            args: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description:
          "Show changed and untracked files in the isolated workspace.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_diff",
        description:
          "Show tracked Git changes plus the contents of newly created untracked files in the isolated workspace.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
  ];
}

export async function createWorkspaceToolRuntime(
  workspaceRootInput: string,
): Promise<WorkspaceToolRuntime> {
  const workspaceRoot = await realpath(workspaceRootInput);

  const packageScripts = await loadPackageScripts(workspaceRoot);

  const packageManager = await detectPackageManager(workspaceRoot);

  const logs: ToolExecutionLog[] = [];

  let fileWrites = 0;
  let commandRuns = 0;

  async function executeTool(
    toolName: string,
    rawArguments: unknown,
  ): Promise<string> {
    try {
      let result: string;

      switch (toolName) {
        case "list_files": {
          const input = listFilesSchema.parse(rawArguments);

          const requestedPath =
            input.path === "."
              ? ""
              : input.path.replaceAll("\\", "/").replace(/^\.\/+/, "");

          resolveInsideWorkspace(workspaceRoot, requestedPath || ".", {
            allowRoot: true,
          });

          const rawFiles = await git(workspaceRoot, [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
          ]);

          const files = rawFiles
            .split("\n")
            .map((file) => file.trim())
            .filter(Boolean)
            .filter((file) => !containsBlockedSegment(file))
            .filter(
              (file) =>
                requestedPath.length === 0 ||
                file === requestedPath ||
                file.startsWith(`${requestedPath}/`),
            )
            .slice(0, input.limit);

          result = JSON.stringify(
            {
              path: input.path,
              count: files.length,
              files,
            },
            null,
            2,
          );

          break;
        }

        case "read_file": {
          const input = readFileSchema.parse(rawArguments);

          const absolutePath = resolveInsideWorkspace(
            workspaceRoot,
            input.path,
          );

          await assertNoSymlinkSegments(workspaceRoot, absolutePath);

          const content = await readFile(absolutePath, "utf8");

          if (content.includes("\0")) {
            throw new Error("Binary files cannot be read.");
          }

          const lines = content.split("\n");

          const startLine = input.startLine ?? 1;

          const endLine = Math.min(
            input.endLine ?? startLine + 399,
            lines.length,
          );

          if (startLine > endLine) {
            throw new Error("startLine must not exceed endLine.");
          }

          const selectedLines = lines
            .slice(startLine - 1, endLine)
            .map((line, index) => `${startLine + index}: ${line}`)
            .join("\n");

          result = truncate(
            [
              `FILE: ${input.path}`,
              `LINES: ${startLine}-${endLine} OF ${lines.length}`,
              "",
              selectedLines,
            ].join("\n"),
            MAX_READ_CHARACTERS,
          );

          break;
        }

        case "search_code": {
          const input = searchCodeSchema.parse(rawArguments);

          const requestedPath =
            input.path === "."
              ? "."
              : input.path.replaceAll("\\", "/").replace(/^\.\/+/, "");

          resolveInsideWorkspace(workspaceRoot, requestedPath, {
            allowRoot: true,
          });

          let output = "";

          try {
            output = await git(workspaceRoot, [
              "grep",
              "-n",
              "-I",
              "-e",
              input.query,
              "--",
              requestedPath,
            ]);
          } catch (error) {
            const possibleError = error as {
              code?: number | string;
              stdout?: string;
            };

            if (possibleError.code !== 1 && possibleError.code !== "1") {
              throw error;
            }

            output = possibleError.stdout ?? "";
          }

          const matches = output
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .slice(0, input.limit);

          result = JSON.stringify(
            {
              query: input.query,
              path: input.path,
              count: matches.length,
              matches,
            },
            null,
            2,
          );

          break;
        }

        case "replace_in_file": {
          if (fileWrites >= MAX_FILE_WRITES) {
            throw new Error(`File-write limit reached (${MAX_FILE_WRITES}).`);
          }

          const input = replaceInFileSchema.parse(rawArguments);

          const absolutePath = resolveInsideWorkspace(
            workspaceRoot,
            input.path,
          );

          await assertNoSymlinkSegments(workspaceRoot, absolutePath);

          const original = await readFile(absolutePath, "utf8");

          const occurrenceCount = original.split(input.search).length - 1;

          if (occurrenceCount === 0) {
            throw new Error("The exact search text was not found.");
          }

          if (!input.replaceAll && occurrenceCount !== 1) {
            throw new Error(
              [
                `The search text occurs ${occurrenceCount} times.`,
                "Provide a more specific fragment or use replaceAll=true.",
              ].join(" "),
            );
          }

          const updated = input.replaceAll
            ? original.split(input.search).join(input.replacement)
            : original.replace(input.search, input.replacement);

          if (updated.length > MAX_WRITE_CHARACTERS) {
            throw new Error("Updated file exceeds the permitted size.");
          }

          await writeFile(absolutePath, updated, "utf8");

          fileWrites += 1;

          result = JSON.stringify(
            {
              path: input.path,
              replacements: input.replaceAll ? occurrenceCount : 1,
              bytesWritten: Buffer.byteLength(updated),
            },
            null,
            2,
          );

          break;
        }

        case "write_file": {
          if (fileWrites >= MAX_FILE_WRITES) {
            throw new Error(`File-write limit reached (${MAX_FILE_WRITES}).`);
          }

          const input = writeFileSchema.parse(rawArguments);

          const absolutePath = resolveInsideWorkspace(
            workspaceRoot,
            input.path,
          );

          await assertNoSymlinkSegments(workspaceRoot, absolutePath);

          const exists = await pathExists(absolutePath);

          if (input.mode === "create" && exists) {
            throw new Error("Cannot create a file that already exists.");
          }

          if (input.mode === "overwrite" && !exists) {
            throw new Error("Cannot overwrite a file that does not exist.");
          }

          await mkdir(path.dirname(absolutePath), {
            recursive: true,
          });

          await writeFile(absolutePath, input.content, "utf8");

          fileWrites += 1;

          result = JSON.stringify(
            {
              path: input.path,
              mode: input.mode,
              bytesWritten: Buffer.byteLength(input.content),
            },
            null,
            2,
          );

          break;
        }

        case "run_package_script": {
          if (commandRuns >= MAX_COMMAND_RUNS) {
            throw new Error(`Command-run limit reached (${MAX_COMMAND_RUNS}).`);
          }

          const input = runPackageScriptSchema.parse(rawArguments);

          if (!ALLOWED_SCRIPT_PATTERN.test(input.script)) {
            throw new Error(`Script is not allowed: ${input.script}`);
          }

          if (!(input.script in packageScripts)) {
            throw new Error(
              `Script does not exist in package.json: ${input.script}`,
            );
          }

          commandRuns += 1;

          let command: string;
          let commandArguments: string[];

          switch (packageManager) {
            case "pnpm":
              command = "pnpm";
              commandArguments = ["run", input.script, ...input.args];
              break;

            case "yarn":
              command = "yarn";
              commandArguments = [input.script, ...input.args];
              break;

            case "bun":
              command = "bun";
              commandArguments = ["run", input.script, ...input.args];
              break;

            default:
              command = "npm";
              commandArguments = [
                "run",
                input.script,
                ...(input.args.length > 0 ? ["--", ...input.args] : []),
              ];
          }

          try {
            const execution = await execFileAsync(command, commandArguments, {
              cwd: workspaceRoot,
              timeout: 180_000,
              maxBuffer: 20 * 1024 * 1024,
              env: {
                ...process.env,
                CI: "1",
              },
            });

            result = truncate(
              JSON.stringify(
                {
                  success: true,
                  command: [command, ...commandArguments].join(" "),
                  stdout: execution.stdout,
                  stderr: execution.stderr,
                },
                null,
                2,
              ),
            );
          } catch (error) {
            const executionError = error as {
              message?: string;
              stdout?: string;
              stderr?: string;
              code?: number | string;
              signal?: string;
            };

            result = truncate(
              JSON.stringify(
                {
                  success: false,
                  command: [command, ...commandArguments].join(" "),
                  exitCode: executionError.code,
                  signal: executionError.signal,
                  stdout: executionError.stdout ?? "",
                  stderr: executionError.stderr ?? "",
                  message: executionError.message,
                },
                null,
                2,
              ),
            );
          }

          break;
        }

        case "git_status": {
          const output = await git(workspaceRoot, ["status", "--short"]);

          result = output.trim().length > 0 ? output : "Workspace is clean.";

          break;
        }

        case "git_diff": {
          /*
           * Regular `git diff` does not include newly created
           * untracked files.
           *
           * ForgeLoop therefore collects:
           *
           * 1. tracked-file diff statistics;
           * 2. tracked-file patch;
           * 3. untracked file paths;
           * 4. bounded contents of those untracked files.
           */

          const [statistics, diff, untrackedOutput] = await Promise.all([
            git(workspaceRoot, ["diff", "--stat"]),

            git(workspaceRoot, ["diff", "--no-ext-diff", "--unified=3"]),

            git(workspaceRoot, ["ls-files", "--others", "--exclude-standard"]),
          ]);

          const untrackedFiles = untrackedOutput
            .split("\n")
            .map((file) => file.trim())
            .filter(Boolean)
            .filter((file) => !containsBlockedSegment(file))
            .slice(0, 10);

          const untrackedContents: string[] = [];

          for (const file of untrackedFiles) {
            try {
              const absolutePath = resolveInsideWorkspace(workspaceRoot, file);

              await assertNoSymlinkSegments(workspaceRoot, absolutePath);

              const content = await readFile(absolutePath, "utf8");

              if (content.includes("\0")) {
                untrackedContents.push(
                  [`UNTRACKED FILE: ${file}`, "(binary content omitted)"].join(
                    "\n",
                  ),
                );

                continue;
              }

              untrackedContents.push(
                [`UNTRACKED FILE: ${file}`, truncate(content, 8_000)].join(
                  "\n",
                ),
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);

              untrackedContents.push(
                [
                  `UNTRACKED FILE: ${file}`,
                  `(unable to display contents: ${message})`,
                ].join("\n"),
              );
            }
          }

          result = truncate(
            [
              "DIFF STAT:",
              statistics || "(no tracked-file changes)",

              "",
              "TRACKED DIFF:",
              diff || "(no tracked-file diff)",

              "",
              "UNTRACKED FILES:",
              untrackedContents.length > 0
                ? untrackedContents.join("\n\n")
                : "(none)",
            ].join("\n"),
          );

          break;
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      logs.push({
        timestamp: new Date().toISOString(),
        tool: toolName,
        arguments: rawArguments,
        success: true,
        result: truncate(result, 4_000),
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const result = JSON.stringify(
        {
          success: false,
          error: message,
        },
        null,
        2,
      );

      logs.push({
        timestamp: new Date().toISOString(),
        tool: toolName,
        arguments: rawArguments,
        success: false,
        result,
      });

      return result;
    }
  }

  return {
    definitions: createToolDefinitions(packageScripts),

    execute: executeTool,

    getLogs: () => [...logs],

    getCounters: () => ({
      fileWrites,
      commandRuns,
    }),
  };
}
