import { z } from "zod";

export const OWNER_BODY_LIMIT = 32 * 1024 * 1024;
export const OWNER_DEFAULT_RESPONSE_LIMIT = 1024 * 1024;
export const OWNER_TRUST_LIMIT = 8 * 1024 * 1024;
export const OWNER_MESSAGE_LIMIT =
	Math.ceil((OWNER_BODY_LIMIT * 4) / 3) + OWNER_TRUST_LIMIT + 1024 * 1024;

const headers = z
	.array(z.tuple([z.string().max(8192), z.string().max(65536)]))
	.max(512);

export const ownerTrustCertificates = z
	.array(z.string().max(65536))
	.max(4096)
	.refine(
		(certificates) =>
			Buffer.byteLength(JSON.stringify(certificates)) <= OWNER_TRUST_LIMIT,
	);

export const ownerRequest = z.object({
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
	maxResponseBytes: z.number().int().min(0).max(OWNER_BODY_LIMIT),
	allowInsecureLoopback: z.boolean(),
	trustedCertificates: ownerTrustCertificates,
	egress: z.object({
		proxy: z.string().max(16384).optional(),
		noProxy: z.string().max(65536).optional(),
		caFile: z.string().max(16384).optional(),
	}),
});

export const ownerResponse = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(false) }),
	z.object({
		ok: z.literal(true),
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
