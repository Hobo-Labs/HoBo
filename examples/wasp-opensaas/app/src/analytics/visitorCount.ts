import * as z from "zod";

const visitorCountSchema = z.union([
  z
    .number()
    .int()
    .nonnegative()
    .refine(Number.isSafeInteger, { message: "Invalid visitor count" }),
  z
    .string()
    .trim()
    .regex(/^\d+$/u)
    .transform((digits) => Number(digits))
    .refine((parsed) => Number.isSafeInteger(parsed), {
      message: "Invalid visitor count",
    }),
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: analytics providers return untyped payloads; zod parse is the boundary.
export function visitorCountFromProvider(value: unknown): number {
  const result = visitorCountSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid visitor count");
  return result.data;
}