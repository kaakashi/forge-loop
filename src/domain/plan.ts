import * as z from "zod";

export const AssumptionSchema = z.object({
  statement: z.string().min(1),

  impact: z.enum(["implementation_detail", "product_behavior"]),

  source: z.enum(["task", "repository", "planner", "unresolved"]),

  evidence: z.string().optional(),

  evidencePath: z.string().optional(),
});

export const FileChangeSchema = z.object({
  path: z.string().min(1),

  action: z.enum(["create", "modify", "delete"]),

  reason: z.string().min(1),
});

export const PlanStepSchema = z.object({
  order: z.number().int().positive(),

  description: z.string().min(1),

  fileChanges: z.array(FileChangeSchema).min(1),

  validationCommands: z.array(z.string()),

  manualChecks: z.array(z.string()),
});

export const EngineeringPlanSchema = z.object({
  summary: z.string().min(1),

  assumptions: z.array(AssumptionSchema),

  acceptanceCriteria: z.array(z.string().min(1)).min(1),

  outOfScope: z.array(z.string()),

  relevantExistingFiles: z.array(z.string()),

  steps: z.array(PlanStepSchema).min(1),

  finalValidationCommands: z.array(z.string()),

  risks: z.array(z.string()),

  requiresClarification: z.boolean(),

  clarificationQuestions: z.array(z.string()),
});

export type EngineeringPlan = z.infer<typeof EngineeringPlanSchema>;
