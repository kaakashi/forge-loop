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

function normalizeEvidence(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsEvidence(source: string, evidence: string): boolean {
  const normalizedSource = normalizeEvidence(source);

  const normalizedEvidence = normalizeEvidence(evidence);

  return (
    normalizedEvidence.length >= 3 &&
    normalizedSource.includes(normalizedEvidence)
  );
}

const PRODUCT_DECISION_PATTERN =
  /\b(default|environment variable|env var|status code|error code|maximum|minimum|limit|timeout|retry|database field|api response|ui behavior|ui behaviour)\b/i;

export function verifyEngineeringPlan(
  plan: EngineeringPlan,
  repository: RepositoryContext,
  task: string,
): PlanVerification {
  const issues: PlanIssue[] = [];

  const trackedFiles = new Set(
    repository.trackedFiles.map((file) => file.replaceAll("\\", "/")),
  );

  for (const assumption of plan.assumptions) {
    const looksLikeProductDecision =
      assumption.impact === "product_behavior" ||
      PRODUCT_DECISION_PATTERN.test(assumption.statement);

    if (assumption.source === "task") {
      if (
        !assumption.evidence ||
        !containsEvidence(task, assumption.evidence)
      ) {
        issues.push({
          severity: "error",
          code: "TASK_EVIDENCE_NOT_FOUND",
          message: `Assumption claims task evidence that was not found: ${assumption.statement}`,
        });
      }
    }

    if (assumption.source === "repository") {
      if (!assumption.evidence || !assumption.evidencePath) {
        issues.push({
          severity: "error",
          code: "MISSING_REPOSITORY_EVIDENCE",
          message: `Repository-backed assumption lacks evidence: ${assumption.statement}`,
        });

        continue;
      }

      const normalizedPath = normalizeRepositoryPath(assumption.evidencePath);

      if (!normalizedPath) {
        issues.push({
          severity: "error",
          code: "UNSAFE_EVIDENCE_PATH",
          message: `Invalid evidence path: ${assumption.evidencePath}`,
        });

        continue;
      }

      const inspectedContent = repository.importantFiles[normalizedPath];

      if (!inspectedContent) {
        issues.push({
          severity: "error",
          code: "EVIDENCE_FILE_NOT_INSPECTED",
          message: `The planner cited an uninspected file: ${normalizedPath}`,
          path: normalizedPath,
        });

        continue;
      }

      if (!containsEvidence(inspectedContent, assumption.evidence)) {
        issues.push({
          severity: "error",
          code: "REPOSITORY_EVIDENCE_NOT_FOUND",
          message: `The cited evidence was not found in ${normalizedPath}.`,
          path: normalizedPath,
        });
      }
    }

    if (assumption.source === "planner" && looksLikeProductDecision) {
      issues.push({
        severity: "error",
        code: "UNSUPPORTED_PRODUCT_DECISION",
        message: `The planner invented a product decision: ${assumption.statement}`,
      });
    }

    if (assumption.source === "unresolved" && !plan.requiresClarification) {
      issues.push({
        severity: "error",
        code: "UNRESOLVED_DECISION_WITHOUT_CLARIFICATION",
        message: `The plan contains an unresolved decision but does not request clarification: ${assumption.statement}`,
      });
    }
  }

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

  const allValidationCommands = [
    ...plan.finalValidationCommands,
    ...plan.steps.flatMap((step) => step.validationCommands),
  ];

  for (const command of allValidationCommands) {
    if (/\s+on\s+[\w./-]+\s*$/i.test(command)) {
      issues.push({
        severity: "error",
        code: "DESCRIPTIVE_TEXT_IN_COMMAND",
        message: `Validation command contains descriptive text: ${command}`,
        command,
      });

      continue;
    }

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
        message: `Package script "${scriptName}" does not exist.`,
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

  const BLOCKING_ISSUE_CODES = new Set([
    "DUPLICATE_STEP_ORDER",

    "UNSAFE_FILE_PATH",
    "ANNOTATED_FILE_PATH",

    "MODIFY_FILE_NOT_FOUND",
    "DELETE_FILE_NOT_FOUND",
    "CREATE_FILE_ALREADY_EXISTS",

    "UNSAFE_RELEVANT_FILE_PATH",
    "ANNOTATED_RELEVANT_FILE_PATH",
    "RELEVANT_FILE_NOT_FOUND",

    "PACKAGE_SCRIPT_NOT_FOUND",
    "DESCRIPTIVE_TEXT_IN_COMMAND",

    "MISSING_CLARIFICATION_QUESTIONS",
  ]);

  const normalizedIssues: PlanIssue[] = issues.map((issue) => ({
    ...issue,
    severity: BLOCKING_ISSUE_CODES.has(issue.code) ? "error" : "warning",
  }));

  return {
    valid: !normalizedIssues.some((issue) => issue.severity === "error"),
    issues: normalizedIssues,
  };
}
