// @vitest-environment node
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  maxProfilePhotoBytes,
  updateAdminProfile,
} from "../src/admin/elements/settings/adminProfile";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=";

describeDatabase("admin profile", () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const emailPrefix = crypto.randomUUID();
  let admin: { id: string; isAdmin: boolean };
  let member: { id: string; isAdmin: boolean };
  const profile = {
    fullName: "  Ada Lovelace ",
    phoneNumber: " 123 ",
    bio: " Hello ",
    profilePhoto: tinyPng,
  };

  beforeAll(async () => {
    admin = await prisma.user.create({
      data: { email: `${emailPrefix}-admin@example.test`, isAdmin: true },
    });
    member = await prisma.user.create({
      data: { email: `${emailPrefix}-member@example.test` },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    await prisma.$disconnect();
  });

  it("only lets administrators update their own profile", async () => {
    const users = prisma.user;
    await expect(
      updateAdminProfile({ user: null, users }, profile),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      updateAdminProfile({ user: member, users }, profile),
    ).rejects.toMatchObject({ statusCode: 403 });
    const input = { ...profile, id: member.id, isAdmin: false };
    expect(await updateAdminProfile({ user: admin, users }, input)).toEqual({
      fullName: "Ada Lovelace",
      phoneNumber: "123",
      bio: "Hello",
      profilePhoto: tinyPng,
    });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: member.id } }),
    ).toMatchObject({ fullName: null, profilePhoto: null });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }),
    ).toMatchObject({ isAdmin: true, fullName: "Ada Lovelace" });
  });

  it("rejects oversized, malformed, and unsupported images", async () => {
    const context = { user: admin, users: prisma.user };
    for (const profilePhoto of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,YWJj",
      `data:image/png;base64,${Buffer.alloc(maxProfilePhotoBytes + 1).toString(
        "base64",
      )}`,
    ]) {
      await expect(
        updateAdminProfile(context, { ...profile, profilePhoto }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(
      updateAdminProfile(context, { ...profile, bio: "x".repeat(1001) }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("removes a photo and clears optional fields", async () => {
    const result = await updateAdminProfile(
      { user: admin, users: prisma.user },
      { fullName: "", phoneNumber: "", bio: "", profilePhoto: null },
    );
    expect(result).toEqual({
      fullName: null,
      phoneNumber: null,
      bio: null,
      profilePhoto: null,
    });
  });
});
