import type { PrismaClient } from "@prisma/client";
import * as z from "zod";

const pageSize = 20;
const pageSchema = z.object({ page: z.number().int().min(0).max(100_000) });
const messageSchema = z.object({ id: z.string().uuid() });

type MessageContext = {
  user: { isAdmin: boolean } | null | undefined;
  messages: PrismaClient["contactFormMessage"];
};

export class ContactMessageError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function requireAdmin(user: MessageContext["user"]) {
  if (!user) throw new ContactMessageError(401, "Authentication required");
  if (!user.isAdmin)
    throw new ContactMessageError(403, "Administrator access required");
}

function parseArguments<Schema extends z.ZodType>(
  schema: Schema,
  input: z.input<Schema>,
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ContactMessageError(400, "Invalid operation arguments");
  return result.data;
}

export async function listContactMessages(
  context: MessageContext,
  input: { page: number },
) {
  requireAdmin(context.user);
  const { page } = parseArguments(pageSchema, input);
  const messages = await context.messages.findMany({
    skip: page * pageSize,
    take: pageSize + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      createdAt: true,
      content: true,
      isRead: true,
      repliedAt: true,
      user: { select: { username: true, email: true } },
    },
  });
  return {
    messages: messages.slice(0, pageSize),
    hasNext: messages.length > pageSize,
  };
}

export async function countUnreadContactMessages(context: MessageContext) {
  requireAdmin(context.user);
  return context.messages.count({ where: { isRead: false } });
}

export async function setContactMessageRead(
  context: MessageContext,
  input: { id: string },
) {
  requireAdmin(context.user);
  const { id } = parseArguments(messageSchema, input);
  const result = await context.messages.updateMany({
    where: { id },
    data: { isRead: true },
  });
  if (result.count === 0)
    throw new ContactMessageError(404, "Message not found");
}
