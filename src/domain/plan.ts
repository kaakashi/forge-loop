import * as z from "zod";

export const FileChangeSchema = z.object({
  path: z.string().min(1),

  action: z.enum(["create", "modify", "delete"]),

  reason: z.string().min(1),
});

export const PlanStepSchema = z.object({
  order: z.number().int().positive(),

  description: z.string().min(1),

  fileChanges: z.array(FileChangeSchema).min(1),

  validation: z.array(z.string().min(1)).min(1),
});

export const EngineeringPlanSchema = z.object({
  summary: z.string().min(1),

  assumptions: z.array(z.string()),

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

export type FileChange = z.infer<typeof FileChangeSchema>;
