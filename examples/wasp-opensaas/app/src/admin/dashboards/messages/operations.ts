import { HttpError } from "wasp/server";
import {
  type GetContactMessages,
  type GetUnreadContactMessageCount,
  type MarkContactMessageRead,
} from "wasp/server/operations";
import {
  ContactMessageError,
  countUnreadContactMessages,
  listContactMessages,
  setContactMessageRead,
} from "./contactMessages";

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ContactMessageError) {
      throw new HttpError(error.statusCode, error.message);
    }
    throw error;
  }
}

export const getContactMessages: GetContactMessages<
  { page: number },
  Awaited<ReturnType<typeof listContactMessages>>
> = (args, context) =>
  execute(() =>
    listContactMessages(
      { user: context.user, messages: context.entities.ContactFormMessage },
      args,
    ),
  );

export const getUnreadContactMessageCount: GetUnreadContactMessageCount<
  void,
  number
> = (_args, context) =>
  execute(() =>
    countUnreadContactMessages({
      user: context.user,
      messages: context.entities.ContactFormMessage,
    }),
  );

export const markContactMessageRead: MarkContactMessageRead<
  { id: string },
  void
> = (args, context) =>
  execute(() =>
    setContactMessageRead(
      { user: context.user, messages: context.entities.ContactFormMessage },
      args,
    ),
  );
