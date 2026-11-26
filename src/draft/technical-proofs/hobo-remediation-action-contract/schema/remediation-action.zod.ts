import { z } from "zod";

export const knownRemediationActionKinds = [
  "failover",
  "scale",
  "retry",
  "circuit-break",
  "resync",
  "compensate",
  "dead-letter",
  "revert-champion",
  "rotate-credential",
  "halt-spend",
  "degrade",
  "escalate",
  "propose",
] as const;

export const TargetRefSchema = z.object({
  kind: z.enum(["resource", "camp", "region"]),
  id: z.string().trim().min(1),
});

export const BlastRadiusSchema = z
  .object({
    scope: z.enum(["resource", "camp", "region"]),
    reversible: z.boolean(),
    compensationPath: z.string().trim().min(1).optional(),
    estimatedImpact: z.enum(["low", "medium", "high"]),
  })
  .superRefine((value, context) => {
    if (value.reversible && !value.compensationPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "compensationPath is required for reversible actions",
        path: ["compensationPath"],
      });
    }
  });

export const RemediationActionSchema = z.object({
  kind: z.string().trim().min(1),
  target: TargetRefSchema,
  blastRadius: BlastRadiusSchema,
  environment: z.string().trim().min(1).default("unknown"),
  idempotencyKey: z.string().trim().min(1),
  conformanceState: z.enum(["green", "unknown", "failing"]),
});

export const PolicyEffectClassSchema = z.enum([
  "auto",
  "canary-with-auto-rollback",
  "require-approval",
]);
