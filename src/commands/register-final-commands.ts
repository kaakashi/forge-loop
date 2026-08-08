import type { Command } from "commander";

import { publishPullRequest } from "../git/publish-pull-request.js";
import { runForgeLoopPipeline } from "../runs/run-pipeline.js";

export function registerFinalCommands(program: Command): void {
  program
    .command("publish")
    .description(
      "Commit, push, and create a GitHub PR for a validated and approved ForgeLoop worktree.",
    )
    .requiredOption("--workspace <path>", "ForgeLoop-generated Git worktree.")
    .requiredOption("--task <task>", "Original engineering task.")
    .requiredOption(
      "--validation-report <path>",
      "Passing deterministic validation report.",
    )
    .requiredOption(
      "--review-report <path>",
      "Approved independent review report.",
    )
    .option(
      "--model <model>",
      "Implementation model used for PR metadata.",
      "qwen3.5:9b",
    )
    .option("--run-id <runId>", "ForgeLoop run identifier.")
    .option(
      "--base <branch>",
      "GitHub PR base branch. Defaults to origin/HEAD, main, or master.",
    )
    .option("--title <title>", "Explicit PR title.")
    .option("--commit-message <message>", "Explicit Git commit message.")
    .action(
      async (options: {
        workspace: string;
        task: string;
        validationReport: string;
        reviewReport: string;
        model: string;
        runId?: string;
        base?: string;
        title?: string;
        commitMessage?: string;
      }) => {
        console.log("Publishing validated ForgeLoop candidate...");

        const result = await publishPullRequest({
          workspaceRoot: options.workspace,
          task: options.task,
          validationReportPath: options.validationReport,
          reviewReportPath: options.reviewReport,
          model: options.model,
          runId: options.runId,
          baseBranch: options.base,
          title: options.title,
          commitMessage: options.commitMessage,
        });

        console.log("");
        console.log("ForgeLoop publish complete:");
        console.log("");
        console.log(JSON.stringify(result, null, 2));
      },
    );

  program
    .command("run")
    .description(
      "Run the full ForgeLoop pipeline: plan, isolate, bootstrap, validate, implement, validate, review, and optionally create a PR.",
    )
    .requiredOption("--repo <path>", "Source repository.")
    .requiredOption("--task <task>", "Engineering task.")
    .option(
      "--create-pr",
      "Commit, push, and create a GitHub PR after all gates pass.",
      false,
    )
    .option("--base <branch>", "GitHub PR base branch.")
    .option(
      "--require-source-name <name>",
      "Expected source repository directory name.",
    )
    .option(
      "--model <model>",
      "Model name used for run metadata.",
      "qwen3.5:9b",
    )
    .action(
      async (options: {
        repo: string;
        task: string;
        createPr: boolean;
        base?: string;
        requireSourceName?: string;
        model: string;
      }) => {
        await runForgeLoopPipeline({
          repo: options.repo,
          task: options.task,
          createPr: options.createPr,
          baseBranch: options.base,
          requireSourceName: options.requireSourceName,
          model: options.model,
        });
      },
    );
}
