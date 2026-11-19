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

function mockMessages(rows: MessageRow[]) {
  return {
    findMany: vi.fn(async () => rows),
    count: vi.fn(async () => rows.filter((row) => !row.isRead).length),
    updateMany: vi.fn(async ({ where }: { where: { id: string } }) => ({
      count: rows.some((row) => row.id === where.id) ? 1 : 0,
    })),
  };
}

describe("contact message operations", () => {
  it("fails closed without an admin user", async () => {
    const messages = mockMessages([]);
  await expect(
      listContactMessages({ user: null, messages: messages as never }, { page: 0 }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      countUnreadContactMessages({ user: { isAdmin: false }, messages: messages as never }),
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
    const messages = mockMessages(rows);
    const first = await listContactMessages(
      { user: { isAdmin: true }, messages: messages as never },
      { page: 0 },
    );
    expect(first.messages).toHaveLength(20);
    expect(first.hasNext).toBe(true);
    const unread = await countUnreadContactMessages({
      user: { isAdmin: true },
      messages: messages as never,
    });
    expect(unread).toBe(10);
  });

  it("marks a message read or rejects unknown ids", async () => {
    const id = crypto.randomUUID();
    const messages = mockMessages([
      {
        id,
        createdAt: new Date(),
        content: "Hi",
        isRead: false,
        repliedAt: null,
        user: { username: null, email: "a@example.test" },
      },
    ]);
    await setContactMessageRead(
      { user: { isAdmin: true }, messages: messages as never },
      { id },
    );
    expect(messages.updateMany).toHaveBeenCalled();
    await expect(
      setContactMessageRead(
        { user: { isAdmin: true }, messages: messages as never },
        { id: crypto.randomUUID() },
      ),
    ).rejects.toBeInstanceOf(ContactMessageError);
  });
});