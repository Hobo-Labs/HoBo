import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const OWNER_BODY_LIMIT = 32 * 1024 * 1024;
export const OWNER_MESSAGE_LIMIT =
	Math.ceil((OWNER_BODY_LIMIT * 4) / 3) + 1024 * 1024;

const headers = z
	.array(z.tuple([z.string().max(8192), z.string().max(65536)]))
	.max(512);

const origin = z
	.string()
	.url()
	.max(2048)
	.refine((value) => new URL(value).origin === value);

export const ownerRun = z.object({
	id: z.uuid(),
	secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

export const ownerPolicy = z.object({
	allowedOrigins: z.array(origin).min(1).max(32),
	allowInsecureLoopback: z.boolean(),
	allowProxy: z.boolean(),
	allowExtraCa: z.boolean(),
});

function allowedProtocol(url: URL, allowInsecureLoopback: boolean): boolean {
	if (url.protocol === "https:") return true;
	return (
		allowInsecureLoopback &&
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "[::1]")
	);
}

export const ownerRequest = z
	.object({
		run: ownerRun,
		policy: ownerPolicy,
		url: z.string().url().max(16384),
		method: z.string().min(1).max(32),
		headers,
		redirect: z.enum(["follow", "error", "manual"]),
		cache: z.enum([
			"default",
			"no-store",
			"reload",
			"no-cache",
			"force-cache",
			"only-if-cached",
		]),
		credentials: z.enum(["omit", "same-origin", "include"]),
		integrity: z.string().max(16384),
		keepalive: z.boolean(),
		mode: z.enum(["same-origin", "no-cors", "cors"]),
		referrer: z.string().max(16384),
		referrerPolicy: z.enum([
			"",
			"no-referrer",
			"no-referrer-when-downgrade",
			"origin",
			"origin-when-cross-origin",
			"same-origin",
			"strict-origin",
			"strict-origin-when-cross-origin",
			"unsafe-url",
		]),
		body: z.string().max(OWNER_MESSAGE_LIMIT).nullable(),
		egress: z
			.object({
				proxy: z.string().max(16384).optional(),
				noProxy: z.string().max(65536).optional(),
				caFile: z.string().max(16384).optional(),
			})
			.optional(),
	})
	.superRefine((request, context) => {
		const url = new URL(request.url);
		if (
			url.username !== "" ||
			url.password !== "" ||
			!request.policy.allowedOrigins.includes(url.origin) ||
			!allowedProtocol(url, request.policy.allowInsecureLoopback)
		)
			context.addIssue({ code: "custom", path: ["url"] });
		for (const [index, allowed] of request.policy.allowedOrigins.entries())
			if (!allowedProtocol(new URL(allowed), request.policy.allowInsecureLoopback))
				context.addIssue({
					code: "custom",
					path: ["policy", "allowedOrigins", index],
				});
		if (
			!request.policy.allowProxy &&
			(request.egress?.proxy !== undefined ||
				request.egress?.noProxy !== undefined)
		)
			context.addIssue({ code: "custom", path: ["egress"] });
		if (!request.policy.allowExtraCa && request.egress?.caFile !== undefined)
			context.addIssue({ code: "custom", path: ["egress", "caFile"] });
	});

export function authenticatedOwnerRun(
	request: z.infer<typeof ownerRequest>,
	expected: z.infer<typeof ownerRun>,
): boolean {
	if (request.run.id !== expected.id) return false;
	const supplied = Buffer.from(request.run.secret);
	const authorized = Buffer.from(expected.secret);
	return (
		supplied.length === authorized.length && timingSafeEqual(supplied, authorized)
	);
}

export const ownerResponse = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(false) }),
	z.object({
		ok: z.literal(true),
		runId: z.uuid(),
		url: z.string().url().max(16384),
		redirected: z.boolean(),
		type: z.enum([
			"basic",
			"cors",
			"default",
			"error",
			"opaque",
			"opaqueredirect",
		]),
		status: z.number().int().min(200).max(599),
		statusText: z.string().max(1024),
		headers,
		body: z.string().max(OWNER_MESSAGE_LIMIT),
	}),
]);
