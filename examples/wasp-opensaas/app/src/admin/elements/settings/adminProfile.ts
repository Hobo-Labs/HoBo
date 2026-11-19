import type { PrismaClient } from "@prisma/client";
import * as z from "zod";

export const maxProfilePhotoBytes = 256 * 1024;

function isValidPhoto(value: string | null): boolean {
  if (value === null) return true;
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const [, type, encoded] = match;
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length > maxProfilePhotoBytes ||
    bytes.toString("base64") !== encoded
  )
    return false;
  if (type === "png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "jpeg") {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return false;
    for (let i = 2; i < bytes.length - 1; i += 1) {
      if (bytes[i] === 255 && bytes[i + 1] === 217) return true;
    }
    return false;
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

const profileSchema = z.object({
  fullName: z.string().trim().max(100),
  phoneNumber: z.string().trim().max(40),
  bio: z.string().trim().max(1000),
  profilePhoto: z
    .string()
    .max(Math.ceil(maxProfilePhotoBytes / 3) * 4 + 30)
    .nullable()
    .refine(isValidPhoto),
});

export type ProfileInput = z.input<typeof profileSchema>;

type ProfileContext = {
  user: { id: string; isAdmin: boolean } | null | undefined;
  users: PrismaClient["user"];
};

export class ProfileError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function updateAdminProfile(
  context: ProfileContext,
  input: ProfileInput,
) {
  if (!context.user) throw new ProfileError(401, "Authentication required");
  if (!context.user.isAdmin)
    throw new ProfileError(403, "Administrator access required");
  const result = profileSchema.safeParse(input);
  if (!result.success)
    throw new ProfileError(400, "Invalid profile details or photo");
  const { fullName, phoneNumber, bio, profilePhoto } = result.data;
  return context.users.update({
    where: { id: context.user.id },
    data: {
      fullName: fullName || null,
      phoneNumber: phoneNumber || null,
      bio: bio || null,
      profilePhoto,
    },
    select: {
      fullName: true,
      phoneNumber: true,
      bio: true,
      profilePhoto: true,
    },
  });
}
