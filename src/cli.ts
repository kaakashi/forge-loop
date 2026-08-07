import { Command } from "commander";

import path from "node:path";
import { readFile } from "node:fs/promises";

import { createEngineeringPlan } from "./providers/ollama-planner.js";
import { analyseRepository } from "./repository/analyse-repository.js";
import { verifyEngineeringPlan } from "./domain/verify-plan.js";
import { savePlanningRun } from "./runs/save-run.js";

import { createIsolatedWorktree } from "./git/create-worktree.js";

import { assertSafeAgentWorkspace } from "./agent/workspace-safety.js";

import { runImplementationAgent } from "./agent/run-implementation-agent.js";
import { saveImplementationRun } from "./runs/save-implementation-run.js";

import { runValidation } from "./validation/run-validation.js";
import { saveValidationRun } from "./runs/save-validation-run.js";

import { runRepairAgent } from "./agent/run-repair-agent.js";
import { saveRepairRun } from "./runs/save-repair-run.js";

const program = new Command();

program
  .name("forgeloop")
  .description(
    "A repository-agnostic local software-engineering agent harness.",
  )
  .version("0.1.0");

program
  .command("plan")
  .description("Analyse a repository and create an implementation plan.")
  .requiredOption("--repo <path>", "Path to the target Git repository.")
  .requiredOption("--task <description>", "Engineering task to plan.")
  .option(
    "--model <model>",
    "Ollama model to use.",
    process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
  )
  .action(async (options: { repo: string; task: string; model: string }) => {
    try {
      console.log("Analysing repository...");

      const repository = await analyseRepository(options.repo);

      console.log(`Found ${repository.trackedFiles.length} tracked files.`);

      const MAX_PLAN_ATTEMPTS = 3;

      let plan: Awaited<ReturnType<typeof createEngineeringPlan>> | undefined;

      let verification: ReturnType<typeof verifyEngineeringPlan> | undefined;

      let verificationFeedback: string[] = [];

      for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
        console.log(
          `Requesting plan from ${options.model} ` +
            `(attempt ${attempt}/${MAX_PLAN_ATTEMPTS})...`,
        );

        plan = await createEngineeringPlan({
          task: options.task,
          repository,
          model: options.model,
          verificationFeedback,
        });

        verification = verifyEngineeringPlan(plan, repository, options.task);

        if (verification.valid) {
          break;
        }

        console.log("\nPlan verification failed:\n");

        for (const issue of verification.issues) {
          const prefix = issue.severity === "error" ? "ERROR" : "WARNING";

          console.log(`[${prefix}] ${issue.code}: ${issue.message}`);
        }

        verificationFeedback = verification.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.code}: ${issue.message}`);

        if (attempt < MAX_PLAN_ATTEMPTS) {
          console.log("\nSending verification feedback to the planner...\n");
        }
      }

      if (!plan || !verification) {
        throw new Error("The planner did not produce a plan.");
      }

      if (!verification.valid) {
        console.error(`\nPlan rejected after ${MAX_PLAN_ATTEMPTS} attempts.`);

        process.exitCode = 2;
        return;
      }

      const warnings = verification.issues.filter(
        (issue) => issue.severity === "warning",
      );

      if (warnings.length > 0) {
        console.log(
          `\nPlan verification passed with ${warnings.length} warning(s):\n`,
        );

        for (const warning of warnings) {
          console.log(`[WARNING] ${warning.code}: ${warning.message}`);
        }
      } else {
        console.log("\nPlan verification passed.");
      }

      console.log("\nPlan created successfully:\n");
      console.log(JSON.stringify(plan, null, 2));

      const outputPath = await savePlanningRun({
        task: options.task,
        model: options.model,
        repository,
        plan,
      });
      console.log(`\nRun record saved to: ${outputPath}`);
    } catch (error) {
      console.error("\nForgeLoop planning failed.");

      if (error instanceof Error) {
        console.error(error.message);

        if (error.cause instanceof Error) {
          console.error(`Cause: ${error.cause.message}`);
        }
      } else {
        console.error(error);
      }

      process.exitCode = 1;
    }
  });

program
  .command("workspace")
  .description("Create an isolated Git worktree for an engineering task.")
  .requiredOption("--repo <path>", "Path to the target Git repository.")
  .requiredOption("--task <description>", "Engineering task for the workspace.")
  .action(async (options: { repo: string; task: string }) => {
    try {
      console.log("Inspecting repository state...");

      const repository = await analyseRepository(options.repo);

      console.log("Creating isolated worktree...");

      const workspace = await createIsolatedWorktree({
        repositoryRoot: repository.root,
        task: options.task,
      });

      console.log("\nWorkspace created successfully:\n");

      console.log(JSON.stringify(workspace, null, 2));

      console.log(`\nOpen workspace:\ncd "${workspace.worktreePath}"`);
    } catch (error) {
      console.error("\nWorkspace creation failed.");

      if (error instanceof Error) {
        console.error(error.message);
      } else {
        console.error(error);
      }

      process.exitCode = 1;
    }
  });

program
  .command("implement")
  .description(
    "Implement an engineering task inside an isolated ForgeLoop worktree.",
  )
  .requiredOption("--repo <path>", "Source repository that owns the worktree.")
  .requiredOption("--workspace <path>", "Generated ForgeLoop worktree.")
  .requiredOption("--task <description>", "Engineering task to implement.")
  .option("--plan <path>", "Optional saved planning-run JSON file.")
  .option(
    "--model <model>",
    "Ollama model to use.",
    process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
  )
  .option(
    "--require-source-name <name>",
    "Safety check for the expected source repository directory name.",
  )
  .action(
    async (options: {
      repo: string;
      workspace: string;
      task: string;
      plan?: string;
      model: string;
      requireSourceName?: string;
    }) => {
      try {
        console.log("Validating isolated workspace...");

        const safeWorkspace = await assertSafeAgentWorkspace({
          sourceRepository: options.repo,

          workspace: options.workspace,

          expectedSourceName: options.requireSourceName,
        });

        let plan: string | undefined;

        if (options.plan) {
          const planPath = path.resolve(options.plan);

          plan = await readFile(planPath, "utf8");

          console.log(`Loaded plan: ${planPath}`);
        }

        console.log(`Source repository: ${safeWorkspace.sourceRepositoryRoot}`);

        console.log(`Agent workspace: ${safeWorkspace.workspaceRoot}`);

        console.log(`Branch: ${safeWorkspace.branchName}`);

        console.log(`Model: ${options.model}`);

        const result = await runImplementationAgent({
          workspaceRoot: safeWorkspace.workspaceRoot,

          task: options.task,
          model: options.model,
          plan,
        });

        const reportPath = await saveImplementationRun({
          model: options.model,
          task: options.task,

          sourceRepository: safeWorkspace.sourceRepositoryRoot,

          workspace: safeWorkspace.workspaceRoot,

          branchName: safeWorkspace.branchName,

          baseCommit: safeWorkspace.baseCommit,

          result,
        });

        console.log("\nImplementation run finished:\n");

        console.log(
          JSON.stringify(
            {
              status: result.status,
              turns: result.turns,
              counters: result.counters,
              usage: result.usage,
              finalMessage: result.finalMessage,
              reportPath,
            },
            null,
            2,
          ),
        );

        console.log("\nGit status:\n");

        console.log(result.finalStatus);

        console.log("\nGit diff:\n");

        console.log(result.finalDiff);

        if (result.status === "max_turns_reached") {
          process.exitCode = 2;
        }
      } catch (error) {
        console.error("\nImplementation run failed.");

        if (error instanceof Error) {
          console.error(error.message);

          if (error.cause instanceof Error) {
            console.error(`Cause: ${error.cause.message}`);
          }
        } else {
          console.error(error);
        }

        process.exitCode = 1;
      }
    },
  );

program
  .command("validate")
  .description(
    "Run deterministic validation against an agent-generated workspace.",
  )
  .requiredOption("--workspace <path>", "ForgeLoop worktree to validate.")
  .option("--task <description>", "Original engineering task.")
  .action(async (options: { workspace: string; task?: string }) => {
    try {
      console.log("Starting deterministic validation...\n");

      const result = await runValidation(options.workspace);

      const reportPath = await saveValidationRun({
        workspace: options.workspace,

        task: options.task,

        result,
      });

      console.log("\nValidation result:\n");

      for (const check of result.checks) {
        console.log(
          `${check.passed ? "PASS" : "FAIL"} ${check.script} (${check.durationMs}ms)`,
        );

        if (!check.passed) {
          if (check.stdout) {
            console.log("\nSTDOUT:\n");

            console.log(check.stdout);
          }

          if (check.stderr) {
            console.log("\nSTDERR:\n");

            console.log(check.stderr);
          }
        }
      }

      console.log("\nSummary:\n");

      console.log(
        JSON.stringify(
          {
            passed: result.passed,

            failedChecks: result.failedChecks,

            reportPath,
          },
          null,
          2,
        ),
      );

      if (!result.passed) {
        process.exitCode = 2;
      }
    } catch (error) {
      console.error("\nValidation failed to run.");

      console.error(error instanceof Error ? error.message : error);

      process.exitCode = 1;
    }
  });

program
  .command("repair")
  .description(
    "Repair a failed candidate using deterministic validation feedback.",
  )
  .requiredOption("--repo <path>", "Source repository that owns the worktree.")
  .requiredOption(
    "--workspace <path>",
    "Dirty ForgeLoop worktree containing the failed candidate.",
  )
  .requiredOption(
    "--validation-report <path>",
    "Validation JSON generated by ForgeLoop.",
  )
  .requiredOption("--task <description>", "Original engineering task.")
  .option(
    "--model <model>",
    "Ollama model to use.",
    process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
  )
  .option(
    "--require-source-name <name>",
    "Expected source repository directory name.",
  )
  .action(
    async (options: {
      repo: string;
      workspace: string;
      validationReport: string;
      task: string;
      model: string;
      requireSourceName?: string;
    }) => {
      try {
        console.log("Validating repair workspace...");

        const safeWorkspace = await assertSafeAgentWorkspace({
          sourceRepository: options.repo,

          workspace: options.workspace,

          expectedSourceName: options.requireSourceName,

          allowDirty: true,
        });

        const validationReportPath = path.resolve(options.validationReport);

        const rawValidationReport = await readFile(
          validationReportPath,
          "utf8",
        );

        const parsedValidation: unknown = JSON.parse(rawValidationReport);

        if (
          typeof parsedValidation !== "object" ||
          parsedValidation === null ||
          !("result" in parsedValidation)
        ) {
          throw new Error("Invalid ForgeLoop validation report.");
        }

        const result = (
          parsedValidation as {
            result?: {
              checks?: Array<{
                script?: string;
                passed?: boolean;
                stdout?: string;
                stderr?: string;
              }>;
            };
          }
        ).result;

        const failedChecks =
          result?.checks?.filter((check) => check.passed === false) ?? [];

        if (failedChecks.length === 0) {
          throw new Error(
            "The supplied validation report contains no failed checks.",
          );
        }

        /*
         * Keep local-model context bounded.
         *
         * For stdout we keep the beginning because
         * TypeScript/compiler failures normally
         * appear there.
         *
         * For stderr we keep the end because test
         * frameworks often put failed assertions
         * and stack traces there.
         */
        const validationFailures = failedChecks
          .map((check) => {
            const stdout = (check.stdout ?? "").slice(0, 8_000);

            const stderrRaw = check.stderr ?? "";

            const stderr = stderrRaw.slice(
              Math.max(0, stderrRaw.length - 10_000),
            );

            return [
              `FAILED CHECK: ${check.script ?? "unknown"}`,
              "",
              "STDOUT:",
              stdout || "(empty)",
              "",
              "STDERR:",
              stderr || "(empty)",
            ].join("\n");
          })
          .join("\n\n============================\n\n");

        console.log(
          `Repairing ${failedChecks.length} failed validation check(s)...`,
        );

        console.log(`Workspace: ${safeWorkspace.workspaceRoot}`);

        console.log(`Branch: ${safeWorkspace.branchName}`);

        console.log(`Model: ${options.model}`);

        const repairResult = await runRepairAgent({
          workspaceRoot: safeWorkspace.workspaceRoot,

          task: options.task,

          model: options.model,

          validationFailures,
        });

        const reportPath = await saveRepairRun({
          model: options.model,

          task: options.task,

          workspace: safeWorkspace.workspaceRoot,

          validationReport: validationReportPath,

          result: repairResult,
        });

        console.log("\nRepair run finished:\n");

        console.log(
          JSON.stringify(
            {
              status: repairResult.status,

              turns: repairResult.turns,

              counters: repairResult.counters,

              usage: repairResult.usage,

              finalMessage: repairResult.finalMessage,

              reportPath,
            },
            null,
            2,
          ),
        );

        console.log("\nGit status:\n");

        console.log(repairResult.finalStatus);

        console.log("\nGit diff:\n");

        console.log(repairResult.finalDiff);

        if (repairResult.status === "max_turns_reached") {
          process.exitCode = 2;
        }
      } catch (error) {
        console.error("\nRepair run failed.");

        console.error(error instanceof Error ? error.message : error);

        process.exitCode = 1;
      }
    },
  );

await program.parseAsync(process.argv);
