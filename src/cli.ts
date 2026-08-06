import { Command } from "commander";

import { createEngineeringPlan } from "./providers/ollama-planner.js";
import { analyseRepository } from "./repository/analyse-repository.js";
import { savePlanningRun } from "./runs/save-run.js";

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

      console.log(`Requesting plan from ${options.model}...`);

      const plan = await createEngineeringPlan({
        task: options.task,
        repository,
        model: options.model,
      });

      const outputPath = await savePlanningRun({
        task: options.task,
        model: options.model,
        repository,
        plan,
      });

      console.log("\nPlan created successfully:\n");
      console.log(JSON.stringify(plan, null, 2));
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

await program.parseAsync(process.argv);
