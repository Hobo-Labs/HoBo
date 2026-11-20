// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  maxProfilePhotoBytes,
  updateAdminProfile,
} from "../src/admin/elements/settings/adminProfile";

const tinyJpegWithTrailing =
  `data:image/jpeg;base64,${Buffer.from([
    255,
    216,
    255,
    219,
    0,
    67,
    0,
    255,
    217,
    0,
    0,
  ]).toString("base64")}`;

function jpegDataUrl(byteLength: number) {
  const start = Buffer.from([255, 216, 255, 219, 0, 67, 0]);
  const end = Buffer.from([255, 217]);
  const padLength = byteLength - start.length - end.length;
  expect(padLength).toBeGreaterThanOrEqual(0);
  const bytes = Buffer.concat([start, Buffer.alloc(padLength, 0), end]);
  expect(bytes.length).toBe(byteLength);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

describe("admin profile validation", () => {
  it("accepts JPEG with bytes after EOI", async () => {
    const users = {
      update: async () => ({
        fullName: "Ada",
        phoneNumber: null,
        bio: null,
        profilePhoto: tinyJpegWithTrailing,
      }),
    };
    await expect(
      updateAdminProfile(
        { user: { id: "a", isAdmin: true }, users },
        {
          fullName: "Ada",
          phoneNumber: "",
          bio: "",
          profilePhoto: tinyJpegWithTrailing,
        },
      ),
    ).resolves.toMatchObject({ profilePhoto: tinyJpegWithTrailing });
  });

  it("accepts a JPEG at the byte cap through updateAdminProfile", async () => {
    const atCap = jpegDataUrl(maxProfilePhotoBytes);
    const users = {
      update: async () => ({
        fullName: "Ada",
        phoneNumber: null,
        bio: null,
        profilePhoto: atCap,
      }),
    };
    await expect(
      updateAdminProfile(
        { user: { id: "a", isAdmin: true }, users },
        {
          fullName: "Ada",
          phoneNumber: "",
          bio: "",
          profilePhoto: atCap,
        },
      ),
    ).resolves.toMatchObject({ profilePhoto: atCap });
  });

  it("rejects a JPEG one byte over the cap", async () => {
    const over = jpegDataUrl(maxProfilePhotoBytes + 1);
    await expect(
      updateAdminProfile(
        {
          user: { id: "a", isAdmin: true },
          users: {
            update: async () => {
              throw new Error("should not persist");
            },
          },
        },
        {
          fullName: "Ada",
          phoneNumber: "",
          bio: "",
          profilePhoto: over,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});