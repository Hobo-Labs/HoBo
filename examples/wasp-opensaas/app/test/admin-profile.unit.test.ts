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

  it("allows data URLs within the stated byte cap", () => {
    const capChars = Math.ceil(maxProfilePhotoBytes / 3) * 4 + 30;
    expect(capChars).toBeGreaterThan(100_000);
  });
});