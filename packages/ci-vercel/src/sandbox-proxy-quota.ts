import { createHash } from "node:crypto";
import { z } from "zod";

export interface ProxyQuotaStore {
	/**
	 * The raw bearer token the proxy VM presented (43 base64url characters).
	 * The relay cache store derives tokens from the lease id and checks the
	 * MAC; a store that keeps token digests hashes it itself.
	 */
	authenticateSandboxProxy(
		token: string,
	): Promise<
		{ accountId: string; leaseId: string; proxySessionId: string } | undefined
	>;
	reserveSandboxProxyEgress(
		leaseId: string,
		proxySessionId: string,
		tokenHash: string,
		sandboxId: string,
		bytes: number,
		requestId: string,
	): Promise<boolean>;
}
const Envelope = z
	.object({
		leaseId: z.string().uuid(),
		proxySessionId: z.string().regex(/^sbx_[A-Za-z0-9_-]+$/),
		sandboxId: z.string().regex(/^sbx_[A-Za-z0-9_-]+$/),
		bytes: z
			.number()
			.int()
			.positive()
			.max(4 * 1024 * 1024),
		requestId: z.string().uuid(),
	})
	.strict();

/** Authenticate the proxy's scoped secret before consuming a bounded body. */
export function createSandboxProxyQuotaHandler(store: ProxyQuotaStore) {
	return async (request: Request): Promise<Response> => {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const header = request.headers.get("authorization") ?? "";
		if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
			return new Response(null, { status: 403 });
		const secret = header.slice(7);
		const decoded = Buffer.from(secret, "base64url");
		if (decoded.length !== 32 || decoded.toString("base64url") !== secret)
			return new Response(null, { status: 403 });
		const digest = createHash("sha256").update(secret).digest("hex");
		try {
			const principal = await store.authenticateSandboxProxy(secret);
			if (!principal) return new Response(null, { status: 403 });
			const declared = request.headers.get("content-length");
			if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1024))
				return new Response(null, { status: 413 });
			const reader = request.body?.getReader();
			if (!reader) return new Response(null, { status: 400 });
			const chunks: Uint8Array[] = [];
			let length = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 1024) {
					await reader.cancel();
					return new Response(null, { status: 413 });
				}
				chunks.push(value);
			}
			const parsed = Envelope.safeParse(
				JSON.parse(Buffer.concat(chunks).toString("utf8")),
			);
			if (
				!parsed.success ||
				parsed.data.leaseId !== principal.leaseId ||
				parsed.data.proxySessionId !== principal.proxySessionId
			)
				return new Response(null, { status: 403 });
			const accepted = await store.reserveSandboxProxyEgress(
				principal.leaseId,
				principal.proxySessionId,
				digest,
				parsed.data.sandboxId,
				parsed.data.bytes,
				parsed.data.requestId,
			);
			return new Response(null, { status: accepted ? 204 : 429 });
		} catch {
			return new Response(null, { status: 503 });
		}
	};
}
