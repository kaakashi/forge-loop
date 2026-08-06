import * as z from "zod";

export const PlanStepSchema = z.object({
  order: z.number().int().positive(),
  description: z.string().min(1),
  expectedFiles: z.array(z.string()),
  validation: z.array(z.string()),
});

export const EngineeringPlanSchema = z.object({
  summary: z.string().min(1),

  assumptions: z.array(z.string()),

  relevantFiles: z.array(z.string()),

  steps: z.array(PlanStepSchema).min(1),

  finalValidationCommands: z.array(z.string()),

  risks: z.array(z.string()),

  requiresClarification: z.boolean(),

  clarificationQuestions: z.array(z.string()),
});

export type EngineeringPlan = z.infer<typeof EngineeringPlanSchema>;
