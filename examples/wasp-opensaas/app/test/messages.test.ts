import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countUnreadContactMessages,
  listContactMessages,
  setContactMessageRead,
} from "../src/admin/dashboards/messages/contactMessages";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("contact messages", () => {
  const prisma = new PrismaClient(
    databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined,
  );
  const fixtureId = crypto.randomUUID();
  const fixtureEmail = `${fixtureId}@example.test`;
  let adminContext: Parameters<typeof listContactMessages>[0];
  let memberContext: Parameters<typeof listContactMessages>[0];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: fixtureEmail, isAdmin: true },
    });
    adminContext = { user, messages: prisma.contactFormMessage };
    memberContext = { ...adminContext, user: { isAdmin: false } };
    await prisma.contactFormMessage.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        userId: user.id,
        content: `Message ${index}`,
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)),
      })),
    });
  });

  afterAll(async () => {
    await prisma.contactFormMessage.deleteMany({
      where: { user: { email: fixtureEmail } },
    });
    await prisma.user.deleteMany({ where: { email: fixtureEmail } });
    await prisma.$disconnect();
  });

  it("restricts all operations to administrators", async () => {
    const anonymousContext = { ...adminContext, user: null };
    await expect(
      listContactMessages(anonymousContext, { page: 0 }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      countUnreadContactMessages(anonymousContext),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      setContactMessageRead(anonymousContext, { id: fixtureId }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      listContactMessages(memberContext, { page: 0 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      countUnreadContactMessages(memberContext),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      setContactMessageRead(memberContext, { id: fixtureId }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("paginates messages and updates unread counts", async () => {
    const first = await listContactMessages(adminContext, { page: 0 });
    expect(first.messages).toHaveLength(20);
    expect(first.hasNext).toBe(true);
    expect(first.messages[0].content).toBe("Message 20");
    expect(first.messages[0].user.email).toBe(fixtureEmail);
    const second = await listContactMessages(adminContext, { page: 1 });
    expect(second.messages).toHaveLength(1);
    expect(second.hasNext).toBe(false);
    expect(await countUnreadContactMessages(adminContext)).toBe(21);
    await setContactMessageRead(adminContext, { id: first.messages[0].id });
    await setContactMessageRead(adminContext, { id: first.messages[0].id });
    expect(await countUnreadContactMessages(adminContext)).toBe(20);
    expect(
      (await listContactMessages(adminContext, { page: 0 })).messages[0].isRead,
    ).toBe(true);
  });

  it("rejects invalid arguments and missing messages", async () => {
    await expect(
      listContactMessages(adminContext, { page: -1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      setContactMessageRead(adminContext, { id: fixtureId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
