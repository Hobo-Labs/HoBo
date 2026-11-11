import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSandboxProxyQuotaHandler } from "../src/sandbox-proxy-quota.js";

const leaseId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const token = randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(token).digest("hex");
function setup() {
	const store = {
		// The store is handed the raw bearer token: the relay cache store
		// checks a derived token's MAC, and a digest-keyed store hashes it.
		authenticateSandboxProxy: vi.fn(async (presented: string) =>
			presented === token
				? { accountId: "tenant", leaseId, proxySessionId: "sbx_proxy" }
				: undefined,
		),
		reserveSandboxProxyEgress: vi.fn(async () => true),
	};
	return { store, handle: createSandboxProxyQuotaHandler(store) };
}
function request(body: typeof envelope & { extra?: string }, bearer = token) {
	return new Request("https://relay.example.test/internal/sandbox/quota", {
		method: "POST",
		headers: { authorization: `Bearer ${bearer}` },
		body: JSON.stringify(body),
	});
}
const envelope = {
	leaseId,
	proxySessionId: "sbx_proxy",
	sandboxId: "sbx_guest",
	bytes: 65536,
	requestId,
};
describe("scoped sandbox proxy quota", () => {
	it("authenticates the secret and fences lease, proxy, guest, and idempotency key", async () => {
		const f = setup();
		const response = await f.handle(request(envelope));
		expect(response.status).toBe(204);
		expect(f.store.authenticateSandboxProxy).toHaveBeenCalledWith(token);
		expect(f.store.reserveSandboxProxyEgress).toHaveBeenCalledWith(
			leaseId,
			"sbx_proxy",
			digest,
			"sbx_guest",
			65536,
			requestId,
		);
		expect(
			(
				await f.handle(
					request({
						...envelope,
						leaseId: "00000000-0000-4000-8000-000000000099",
					}),
				)
			).status,
		).toBe(403);
		expect(f.store.reserveSandboxProxyEgress).toHaveBeenCalledTimes(1);
	});
	it("rejects invalid bearer without consuming the request body", async () => {
		const f = setup();
		const incoming = request(envelope, randomBytes(32).toString("base64url"));
		expect((await f.handle(incoming)).status).toBe(403);
		expect(incoming.bodyUsed).toBe(false);
		expect(f.store.reserveSandboxProxyEgress).not.toHaveBeenCalled();
	});
	it("refuses replay or exhausted budget", async () => {
		const f = setup();
		f.store.reserveSandboxProxyEgress.mockResolvedValue(false);
		expect((await f.handle(request(envelope))).status).toBe(429);
	});
	it("bounds bodies and requires a request identifier", async () => {
		const f = setup();
		expect(
			(await f.handle(request({ ...envelope, extra: "x".repeat(2000) })))
				.status,
		).toBe(413);
		expect(
			(await f.handle(request({ ...envelope, requestId: "" }))).status,
		).toBe(403);
		expect(f.store.reserveSandboxProxyEgress).not.toHaveBeenCalled();
	});
});
