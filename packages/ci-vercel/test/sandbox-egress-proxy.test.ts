import { describe, expect, it } from "vitest";
import {
	createSandboxEgressProxy,
	createVerifiedSandboxEgressHandler,
	isPublicIpv4,
} from "../src/sandbox-egress-proxy.js";

const meta = {
	host: "relay.example",
	teamId: "team-1",
	projectId: "project-1",
	sandboxId: "sbx_123",
	sandboxName: "ci-123",
};
function fixture(options: { addresses?: string[]; budget?: number } = {}) {
	let remaining = options.budget ?? 100_000;
	const reservations: number[] = [];
	const seen: { address: string; body: string; headers: Headers }[] = [];
	const handler = createVerifiedSandboxEgressHandler({
		teamId: "team-1",
		projectId: "project-1",
		hosts: ["github.com"],
		ledger: {
			async reserveSandboxEgress(id, amount) {
				expect(id).toBe(meta.sandboxId);
				reservations.push(amount);
				if (amount > remaining) return false;
				remaining -= amount;
				return true;
			},
		},
		resolve: async () => options.addresses ?? ["8.8.8.8"],
		transport: async (input) => {
			const body = input.body ? await new Response(input.body).text() : "";
			seen.push({ address: input.address, body, headers: input.headers });
			return new Response("ok", { status: 200 });
		},
	});
	return { handler, reservations, seen };
}

describe("sandbox egress guard", () => {
	it("rejects private, link-local, metadata, documentation, multicast and IPv6 destinations", () => {
		for (const address of [
			"0.1.2.3",
			"10.0.0.1",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.169.254",
			"172.16.1.2",
			"192.168.1.1",
			"192.0.2.2",
			"198.51.100.2",
			"203.0.113.1",
			"224.0.0.1",
			"::1",
			"::ffff:127.0.0.1",
		])
			expect(isPublicIpv4(address)).toBe(false);
		for (const address of ["8.8.8.8", "1.1.1.1", "172.15.1.2", "172.32.1.2"])
			expect(isPublicIpv4(address)).toBe(true);
	});
	it("requires exact identity, HTTPS, port 443, configured domain and public DNS", async () => {
		const f = fixture();
		for (const [url, identity] of [
			["https://github.com/", { ...meta, teamId: "other" }],
			["https://github.com/", { ...meta, sandboxId: "bad" }],
			["https://github.com.attacker.test/", meta],
			["http://github.com/", meta],
			["https://github.com:8443/", meta],
		] as const)
			expect((await f.handler(new Request(url), identity)).status).toBe(403);
		expect(f.reservations).toEqual([]);
		const privateDns = fixture({ addresses: ["8.8.8.8", "169.254.169.254"] });
		expect(
			(await privateDns.handler(new Request("https://github.com/"), meta))
				.status,
		).toBe(403);
		expect(privateDns.seen).toEqual([]);
		expect(() =>
			createVerifiedSandboxEgressHandler({
				teamId: "t",
				projectId: "p",
				hosts: ["*.github.com"],
				ledger: {
					async reserveSandboxEgress() {
						return true;
					},
				},
			}),
		).toThrow();
	});
	it("allows configured runner subdomains without relaxing identity, DNS or quota", async () => {
		const resolved: string[] = [];
		const forwarded: {
			hostname: string;
			address: string;
			host: string | null;
		}[] = [];
		const charges: number[] = [];
		const handler = createVerifiedSandboxEgressHandler({
			teamId: meta.teamId,
			projectId: meta.projectId,
			hosts: ["*.actions.githubusercontent.com", "*.blob.core.windows.net"],
			ledger: {
				async reserveSandboxEgress(_id, bytes) {
					charges.push(bytes);
					return true;
				},
			},
			resolve: async (hostname) => {
				resolved.push(hostname);
				return hostname.startsWith("private.") ? ["127.0.0.1"] : ["8.8.8.8"];
			},
			transport: async (input) => {
				forwarded.push({
					hostname: input.url.hostname,
					address: input.address,
					host: input.headers.get("host"),
				});
				return new Response("ok");
			},
		});
		for (const hostname of [
			"runner-1.actions.githubusercontent.com",
			"a.b.actions.githubusercontent.com",
			"account.blob.core.windows.net",
		]) {
			const response = await handler(
				new Request(`https://${hostname}/`, {
					headers: { host: "attacker.test" },
				}),
				meta,
			);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(forwarded).toEqual([
			{
				hostname: "runner-1.actions.githubusercontent.com",
				address: "8.8.8.8",
				host: null,
			},
			{
				hostname: "a.b.actions.githubusercontent.com",
				address: "8.8.8.8",
				host: null,
			},
			{
				hostname: "account.blob.core.windows.net",
				address: "8.8.8.8",
				host: null,
			},
		]);
		expect(charges.length).toBeGreaterThan(0);
		for (const url of [
			"https://actions.githubusercontent.com/",
			"https://bad-actions.githubusercontent.com/",
			"https://x.actions.githubusercontent.com.attacker.test/",
			"https://blob.core.windows.net/",
			"https://x.blob.core.windows.net.attacker.test/",
			"http://runner-1.actions.githubusercontent.com/",
			"https://runner-1.actions.githubusercontent.com:444/",
		])
			expect((await handler(new Request(url), meta)).status).toBe(403);
		expect(
			(
				await handler(
					new Request("https://private.actions.githubusercontent.com/"),
					meta,
				)
			).status,
		).toBe(403);
		expect(resolved).toContain("private.actions.githubusercontent.com");
		expect(forwarded).toHaveLength(3);
	});
	it("reserves request bytes before forwarding and strips spoofed hop headers", async () => {
		const f = fixture();
		const request = new Request("https://github.com/path?a=b", {
			method: "POST",
			headers: {
				"x-example": "test",
				connection: "x-drop",
				"x-drop": "secret",
				"vercel-forwarded-host": "attacker",
				authorization: "Bearer workflow-token",
			},
			body: "body",
		});
		const response = await f.handler(request, meta);
		expect(response.status).toBe(200);
		expect(f.seen[0]).toMatchObject({ address: "8.8.8.8", body: "body" });
		expect(f.seen[0]?.headers.has("x-drop")).toBe(false);
		expect(f.seen[0]?.headers.has("connection")).toBe(false);
		expect(f.seen[0]?.headers.has("vercel-forwarded-host")).toBe(false);
		expect(f.seen[0]?.headers.get("authorization")).toBe(
			"Bearer workflow-token",
		);
		expect(await response.text()).toBe("ok");
		expect(f.reservations).toHaveLength(4);
		expect(f.reservations[1]).toBe(4);
		expect(f.reservations[3]).toBe(2);
	});
	it("blocks a body chunk when the shared ledger refuses its reservation", async () => {
		const f = fixture({ budget: 4158 });
		const response = await f.handler(
			new Request("https://github.com/", {
				method: "POST",
				body: "1234567890",
			}),
			meta,
		);
		expect(response.status).toBe(503);
		expect(f.seen).toEqual([]);
		expect(f.reservations.at(-1)).toBe(10);
	});
	it("bounds declared upload and response sizes", async () => {
		const f = fixture();
		const upload = new Request("https://github.com/", {
			method: "POST",
			headers: { "content-length": "4194305" },
			body: "a",
		});
		expect((await f.handler(upload, meta)).status).toBe(413);
		expect(f.reservations).toEqual([]);
		const handler = createVerifiedSandboxEgressHandler({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress() {
					return true;
				},
			},
			resolve: async () => ["8.8.8.8"],
			maxResponseBytes: 4 * 1024 * 1024,
			transport: async () =>
				new Response("x", { headers: { "content-length": "4194305" } }),
		});
		expect(
			(await handler(new Request("https://github.com/"), meta)).status,
		).toBe(502);
	});
	it("fails closed on streamed responses over the Vercel Function limit", async () => {
		const reservations: number[] = [];
		let chunks = 5;
		const handler = createVerifiedSandboxEgressHandler({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress(_id, bytes) {
					reservations.push(bytes);
					return true;
				},
			},
			resolve: async () => ["8.8.8.8"],
			transport: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							if (chunks-- > 0) controller.enqueue(new Uint8Array(1024 * 1024));
							else controller.close();
						},
					}),
				),
		});
		const response = await handler(new Request("https://github.com/"), meta);
		await expect(response.arrayBuffer()).rejects.toThrow(
			"sandbox response budget exceeded",
		);
		expect(reservations.slice(2).reduce((a, b) => a + b, 0)).toBe(
			4 * 1024 * 1024,
		);
		expect(() =>
			createVerifiedSandboxEgressHandler({
				teamId: "team-1",
				projectId: "project-1",
				hosts: ["github.com"],
				ledger: {
					async reserveSandboxEgress() {
						return true;
					},
				},
				maxResponseBytes: 5 * 1024 * 1024,
			}),
		).toThrow("invalid sandbox response limit");
	});

	it("terminates a response stream before sending a chunk the ledger refuses", async () => {
		const reservations: number[] = [];
		let remaining = 8212;
		const handler = createVerifiedSandboxEgressHandler({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress(_id, bytes) {
					reservations.push(bytes);
					if (bytes > remaining) return false;
					remaining -= bytes;
					return true;
				},
			},
			resolve: async () => ["8.8.8.8"],
			transport: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2, 3, 4]));
							controller.enqueue(new Uint8Array([5, 6, 7, 8]));
							controller.close();
						},
					}),
				),
		});
		const response = await handler(new Request("https://github.com/"), meta);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) throw new Error("missing response stream");
		expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3, 4]));
		await expect(reader.read()).rejects.toThrow(
			"sandbox response budget exceeded",
		);
		expect(reservations).toEqual([4112, 4096, 4, 4]);
	});
	it("enforces a shared ceiling across concurrent requests", async () => {
		let remaining = 12400;
		const handler = createVerifiedSandboxEgressHandler({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress(_id, bytes) {
					if (bytes > remaining) return false;
					remaining -= bytes;
					return true;
				},
			},
			resolve: async () => ["8.8.8.8"],
			transport: async () => new Response("ok"),
		});
		const result = await Promise.all([
			handler(new Request("https://github.com/one"), meta),
			handler(new Request("https://github.com/two"), meta),
		]);
		expect(result.map((entry) => entry.status).sort()).toEqual([200, 429]);
		const success = result.find((entry) => entry.status === 200);
		expect(await success?.text()).toBe("ok");
		expect(remaining).toBeGreaterThanOrEqual(0);
	});
	it("accounts for request target and raw headers even when they are stripped", async () => {
		const f = fixture();
		const response = await f.handler(
			new Request(`https://github.com/?q=${"x".repeat(900)}`, {
				headers: { "vercel-spoof": "x".repeat(500) },
			}),
			meta,
		);
		expect(response.status).toBe(200);
		expect(f.reservations[0]).toBeGreaterThan(4096 + 1400);
		await response.body?.cancel();
	});
	it("fails closed when DNS does not answer before the deadline", async () => {
		const handler = createVerifiedSandboxEgressHandler({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			timeoutMs: 20,
			ledger: {
				async reserveSandboxEgress() {
					return true;
				},
			},
			resolve: () => new Promise<string[]>(() => {}),
		});
		expect(
			(await handler(new Request("https://github.com/"), meta)).status,
		).toBe(503);
	});
	it("aborts a stalled upstream response at the absolute deadline", async () => {
		let cancelled = false;
		const handler = createVerifiedSandboxEgressHandler({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			timeoutMs: 20,
			ledger: {
				async reserveSandboxEgress() {
					return true;
				},
			},
			resolve: async () => ["8.8.8.8"],
			transport: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		const response = await handler(new Request("https://github.com/"), meta);
		await expect(response.text()).rejects.toThrow(
			"sandbox egress deadline exceeded",
		);
		expect(cancelled).toBe(true);
	});
	it("uses the SDK verifier and rejects requests without Vercel OIDC", async () => {
		let reserves = 0;
		const proxy = createSandboxEgressProxy({
			teamId: "team-1",
			projectId: "project-1",
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress() {
					reserves++;
					return true;
				},
			},
		});
		expect(
			(await proxy(new Request("https://relay.example/egress"))).status,
		).toBe(403);
		expect(reserves).toBe(0);
	});
});
