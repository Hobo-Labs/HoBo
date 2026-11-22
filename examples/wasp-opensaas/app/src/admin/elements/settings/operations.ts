import { HttpError } from "wasp/server";
import { type SaveAdminProfile } from "wasp/server/operations";
import {
  ProfileError,
  updateAdminProfile,
  type ProfileInput,
} from "./adminProfile";

export const saveAdminProfile: SaveAdminProfile<
  ProfileInput,
  Awaited<ReturnType<typeof updateAdminProfile>>
> = async (input, context) => {
  try {
    return await updateAdminProfile(
      { user: context.user, users: context.entities.User },
      input,
    );
  } catch (error) {
    if (error instanceof ProfileError)
      throw new HttpError(error.statusCode, error.message);
    throw error;
  }
};
