import { Command } from "commander";

import { createEngineeringPlan } from "./providers/ollama-planner.js";
import { analyseRepository } from "./repository/analyse-repository.js";
import { savePlanningRun } from "./runs/save-run.js";
import { verifyEngineeringPlan } from "./domain/verify-plan.js";
import { createIsolatedWorktree } from "./git/create-worktree.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeAgentWorkspace } from "./agent/workspace-safety.js";

import { runImplementationAgent } from "./agent/run-implementation-agent.js";

import { saveImplementationRun } from "./runs/save-implementation-run.js";

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

await program.parseAsync(process.argv);
