import { HttpError } from "wasp/server";
import * as z from "zod";

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export function ensureArgsSchemaOrThrowHttpError<Schema extends z.ZodType>(
  schema: Schema,
  rawArgs: JsonValue,
): z.infer<Schema> {
  const parseResult = schema.safeParse(rawArgs);
  if (!parseResult.success) {
    console.error(
      new Error(
        "Operation arguments validation failed:\n" +
          z.prettifyError(parseResult.error),
        { cause: parseResult.error },
      ),
    );

    throw new HttpError(400, "Operation arguments validation failed", {
      cause: parseResult.error,
    });
  } else {
    return parseResult.data;
  }
}
