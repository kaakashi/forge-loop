import path from "node:path";

import type { EngineeringPlan } from "./plan.js";
import type { RepositoryContext } from "../repository/analyse-repository.js";

export type PlanIssueSeverity = "error" | "warning";

export interface PlanIssue {
  severity: PlanIssueSeverity;
  code: string;
  message: string;
  path?: string;
  command?: string;
}

export interface PlanVerification {
  valid: boolean;
  issues: PlanIssue[];
}

function normalizeRepositoryPath(filePath: string): string | null {
  const unixPath = filePath.replaceAll("\\", "/");

  if (path.posix.isAbsolute(unixPath)) {
    return null;
  }

  const normalized = path.posix.normalize(unixPath).replace(/^\.\/+/, "");

  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }

  if (normalized.length === 0 || normalized === ".") {
    return null;
  }

  return normalized;
}

function extractPackageScript(command: string): string | null {
  const trimmed = command.trim();

  const npmRunMatch = trimmed.match(/^npm\s+run\s+([^\s]+)/);

  if (npmRunMatch?.[1]) {
    return npmRunMatch[1];
  }

  if (/^npm\s+test(?:\s|$)/.test(trimmed)) {
    return "test";
  }

  const pnpmRunMatch = trimmed.match(/^pnpm\s+run\s+([^\s]+)/);

  if (pnpmRunMatch?.[1]) {
    return pnpmRunMatch[1];
  }

  const pnpmDirectMatch = trimmed.match(/^pnpm\s+([^\s]+)/);

  if (
    pnpmDirectMatch?.[1] &&
    !["exec", "install", "add", "remove", "dlx"].includes(pnpmDirectMatch[1])
  ) {
    return pnpmDirectMatch[1];
  }

  const yarnRunMatch = trimmed.match(/^yarn\s+run\s+([^\s]+)/);

  if (yarnRunMatch?.[1]) {
    return yarnRunMatch[1];
  }

  const yarnDirectMatch = trimmed.match(/^yarn\s+([^\s]+)/);

  if (
    yarnDirectMatch?.[1] &&
    !["install", "add", "remove", "dlx"].includes(yarnDirectMatch[1])
  ) {
    return yarnDirectMatch[1];
  }

  const bunRunMatch = trimmed.match(/^bun\s+run\s+([^\s]+)/);

  if (bunRunMatch?.[1]) {
    return bunRunMatch[1];
  }

  return null;
}

export function verifyEngineeringPlan(
  plan: EngineeringPlan,
  repository: RepositoryContext,
): PlanVerification {
  const issues: PlanIssue[] = [];

  const trackedFiles = new Set(
    repository.trackedFiles.map((file) => file.replaceAll("\\", "/")),
  );

  const stepOrders = new Set<number>();

  for (const step of plan.steps) {
    if (stepOrders.has(step.order)) {
      issues.push({
        severity: "error",
        code: "DUPLICATE_STEP_ORDER",
        message: `Step order ${step.order} appears more than once.`,
      });
    }

    stepOrders.add(step.order);

    for (const change of step.fileChanges) {
      const normalizedPath = normalizeRepositoryPath(change.path);

      if (!normalizedPath) {
        issues.push({
          severity: "error",
          code: "UNSAFE_FILE_PATH",
          message: `The plan contains an unsafe repository path: ${change.path}`,
          path: change.path,
        });

        continue;
      }

      if (change.path.includes(" (") || change.path.includes(" scripts:")) {
        issues.push({
          severity: "error",
          code: "ANNOTATED_FILE_PATH",
          message: `File paths must not contain explanatory text: ${change.path}`,
          path: change.path,
        });

        continue;
      }

      const fileExists = trackedFiles.has(normalizedPath);

      if (change.action === "modify" && !fileExists) {
        issues.push({
          severity: "error",
          code: "MODIFY_FILE_NOT_FOUND",
          message: `The plan wants to modify a file that is not tracked: ${normalizedPath}`,
          path: normalizedPath,
        });
      }

      if (change.action === "delete" && !fileExists) {
        issues.push({
          severity: "error",
          code: "DELETE_FILE_NOT_FOUND",
          message: `The plan wants to delete a file that is not tracked: ${normalizedPath}`,
          path: normalizedPath,
        });
      }

      if (change.action === "create" && fileExists) {
        issues.push({
          severity: "error",
          code: "CREATE_FILE_ALREADY_EXISTS",
          message: `The plan wants to create a file that already exists: ${normalizedPath}`,
          path: normalizedPath,
        });
      }
    }
  }

  for (const relevantFile of plan.relevantExistingFiles) {
    const normalizedPath = normalizeRepositoryPath(relevantFile);

    if (!normalizedPath) {
      issues.push({
        severity: "error",
        code: "UNSAFE_RELEVANT_FILE_PATH",
        message: `The plan contains an unsafe relevant file path: ${relevantFile}`,
        path: relevantFile,
      });

      continue;
    }

    if (relevantFile.includes(" (") || relevantFile.includes(" scripts:")) {
      issues.push({
        severity: "error",
        code: "ANNOTATED_RELEVANT_FILE_PATH",
        message: `Relevant file paths must not contain explanatory text: ${relevantFile}`,
        path: relevantFile,
      });

      continue;
    }

    if (!trackedFiles.has(normalizedPath)) {
      issues.push({
        severity: "error",
        code: "RELEVANT_FILE_NOT_FOUND",
        message: `The planner referenced a file that is not tracked: ${normalizedPath}`,
        path: normalizedPath,
      });
    }
  }

  for (const command of plan.finalValidationCommands) {
    const scriptName = extractPackageScript(command);

    if (!scriptName) {
      issues.push({
        severity: "warning",
        code: "UNVERIFIED_VALIDATION_COMMAND",
        message: `ForgeLoop could not deterministically verify this command: ${command}`,
        command,
      });

      continue;
    }

    if (!(scriptName in repository.packageScripts)) {
      issues.push({
        severity: "error",
        code: "PACKAGE_SCRIPT_NOT_FOUND",
        message: `The plan references package script "${scriptName}", but it does not exist in package.json.`,
        command,
      });
    }
  }

  if (plan.requiresClarification && plan.clarificationQuestions.length === 0) {
    issues.push({
      severity: "error",
      code: "MISSING_CLARIFICATION_QUESTIONS",
      message: "The plan requires clarification but provides no questions.",
    });
  }

  if (!plan.requiresClarification && plan.clarificationQuestions.length > 0) {
    issues.push({
      severity: "warning",
      code: "UNEXPECTED_CLARIFICATION_QUESTIONS",
      message:
        "The plan provides clarification questions while requiresClarification is false.",
    });
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}
