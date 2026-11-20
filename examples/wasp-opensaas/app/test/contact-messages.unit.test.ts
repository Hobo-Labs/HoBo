import { describe, expect, it, vi } from "vitest";
import {
  ContactMessageError,
  countUnreadContactMessages,
  listContactMessages,
  setContactMessageRead,
} from "../src/admin/dashboards/messages/contactMessages";

type MessageRow = {
  id: string;
  createdAt: Date;
  content: string;
  isRead: boolean;
  repliedAt: Date | null;
  user: { username: string | null; email: string };
};

type MessageContext = Parameters<typeof listContactMessages>[0];

function mockMessages(rows: MessageRow[]) {
  return {
    findMany: vi.fn(
      async ({
        skip,
        take,
      }: {
        skip: number;
        take: number;
        orderBy: unknown;
        select: unknown;
      }) => rows.slice(skip, skip + take),
    ),
    count: vi.fn(async ({ where }: { where: { isRead: boolean } }) =>
      rows.filter((row) => row.isRead === where.isRead).length,
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { isRead: boolean };
      }) => {
        const match = rows.find((row) => row.id === where.id);
        if (!match) return { count: 0 };
        match.isRead = data.isRead;
        return { count: 1 };
      },
    ),
  } satisfies MessageContext["messages"];
}

function adminContext(messages: MessageRow[]): MessageContext {
  return {
    user: { isAdmin: true },
    messages: mockMessages(messages),
  };
}

describe("contact message operations", () => {
  it("fails closed without an admin user", async () => {
    const messages = mockMessages([]);
    await expect(
      listContactMessages({ user: null, messages }, { page: 0 }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      countUnreadContactMessages({ user: { isAdmin: false }, messages }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("pages messages and reports a next page when the slice overflows", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      id: crypto.randomUUID(),
      createdAt: new Date(Date.UTC(2024, 0, index + 1)),
      content: `Message ${index}`,
      isRead: index % 2 === 0,
      repliedAt: null,
      user: { username: null, email: "admin@example.test" },
    }));
    const context = adminContext(rows);
    const first = await listContactMessages(context, { page: 0 });
    expect(first.messages).toHaveLength(20);
    expect(first.hasNext).toBe(true);
    expect(context.messages.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 21,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    const unread = await countUnreadContactMessages(context);
    expect(unread).toBe(10);
    expect(context.messages.count).toHaveBeenCalledWith({
      where: { isRead: false },
    });
  });

  it("marks a message read or rejects unknown ids", async () => {
    const id = crypto.randomUUID();
    const context = adminContext([
      {
        id,
        createdAt: new Date(),
        content: "Hi",
        isRead: false,
        repliedAt: null,
        user: { username: null, email: "a@example.test" },
      },
    ]);
    await setContactMessageRead(context, { id });
    expect(context.messages.updateMany).toHaveBeenCalledWith({
      where: { id },
      data: { isRead: true },
    });
    await expect(
      setContactMessageRead(context, { id: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ContactMessageError);
  });
});