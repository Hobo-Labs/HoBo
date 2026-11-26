import { z } from "zod";

export const TicketOpenedZodSchema = z.object({
  ticketId: z.string().regex(/^ticket_[a-z0-9]+$/),
  summary: z.string().min(1),
  priority: z.number().int().nonnegative().min(1).max(5),
  requesterEmail: z.string().regex(/^[^@]+@[^@]+\.[^@]+$/)
}).strict();
