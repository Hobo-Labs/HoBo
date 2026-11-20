import * as z from "zod";

const customerIdSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).transform((customer) => customer.id),
]);

export function getCustomerId(
  customer: string | { id: string } | null,
): string {
  const result = customerIdSchema.safeParse(customer);
  if (!result.success) throw new Error("Customer is missing");
  return result.data;
}
