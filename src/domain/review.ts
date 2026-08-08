import * as z from "zod";

export const ReviewFindingSchema = z.object({
  severity: z.enum(["blocking", "warning"]),

  category: z.enum([
    "task_requirement",
    "correctness",
    "regression",
    "testing",
    "scope",
    "maintainability",
    "security",
  ]),

  title: z.string().min(1),

  description: z.string().min(1),

  evidence: z.string().min(1),

  file: z.string().optional(),

  suggestedFix: z.string().optional(),
});

export const EngineeringReviewSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),

  summary: z.string().min(1),

  taskSatisfied: z.boolean(),

  validationConsidered: z.boolean(),

  findings: z.array(ReviewFindingSchema),

  reviewedFiles: z.array(z.string()),

  remainingRisks: z.array(z.string()),
});

export type EngineeringReview = z.infer<typeof EngineeringReviewSchema>;
