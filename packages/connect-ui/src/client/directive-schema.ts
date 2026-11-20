import { z } from "zod";

const HttpsOnlyUrl = z.string().refine((value) => {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}, "directive url must be an absolute http(s) URL");

export const DirectiveSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	z.object({ kind: z.literal("navigate"), url: HttpsOnlyUrl }),
	z.object({
		kind: z.literal("post"),
		url: HttpsOnlyUrl,
		fields: z.record(z.string(), z.string()),
	}),
]);
