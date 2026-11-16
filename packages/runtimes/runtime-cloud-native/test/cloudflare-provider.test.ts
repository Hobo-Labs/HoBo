import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mustGet } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLOUDFLARE_REMOTE_HANDLER_UNBOUND,
	CLOUDFLARE_TOKEN_VERIFY_URL,
	CloudflareCloudNativeError,
	createCloudflareCloudNativeProvider,
	createCloudNativeRuntimeHost,
	defaultCloudNativeProviders,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const ensureCtx = { hoboHome: "/tmp" };
const serveCtx = (
	overrides: Partial<{
		bindleEnv: Record<string, string>;
		privateComponents: { resourceName: string; projectDir: string }[];
	}> = {},
) => ({
	hoboHome: "/tmp",
	projectDir: "/tmp",
	privateComponents: [{ resourceName: "api", projectDir: "/tmp" }],
	...overrides,
});

function activeTokenFetch(calls: { url: string; init?: RequestInit }[]) {
	// SAFETY: assertion required at this I/O or test boundary.
	return (async (input: URL | RequestInfo, init?: RequestInit) => {
		calls.push({ url: String(input), ...(init ? { init } : undefined) });
		return Response.json({
			success: true,
			errors: [],
			messages: [],
			result: { id: "t1", status: "active" },
		});
	}) as typeof fetch;
}

describe("cloudflare cloud-native provider: credential gate", () => {
	it("fails closed without credentials, naming both missing vars", async () => {
		const provider = createCloudflareCloudNativeProvider({});
		const result = await provider.ensure(ensureCtx);
		expect(result.ready).toBe(false);
		expect(result.details).toEqual({
			provider: "cloudflare",
			implemented: true,
			credentialGated: true,
			missing: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
		});
	});

	it("names only the absent credential", async () => {
		const provider = createCloudflareCloudNativeProvider({
			apiToken: "token-value",
		});
		const result = await provider.ensure(ensureCtx);
		expect(result.ready).toBe(false);
		expect(result.details?.missing).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
	});

	it("never leaks credential values in the gated result", async () => {
		const provider = createCloudflareCloudNativeProvider({
			apiToken: "super-secret-token",
		});
		const result = await provider.ensure(ensureCtx);
		expect(JSON.stringify(result)).not.toContain("super-secret-token");
	});

	it("servePrivate without a bound endpoint answers 501 with remediation", async () => {
		const provider = createCloudflareCloudNativeProvider({});
		const serve = await provider.servePrivate(serveCtx());
		cleanups.push(() => serve.close());
		expect(serve.isolation).toEqual({
			isolateBoundary: "cloudflare-worker",
			privateSandboxes: 0,
			details: { mode: "remote-proxy" },
		});
		const response = await mustGet(
			serve.handlers,
			"api",
		)(new Request("http://internal/hello"));
		expect(response.status).toBe(501);
		const body = await response.json();
		expect(body.error).toBe(CLOUDFLARE_REMOTE_HANDLER_UNBOUND);
		expect(body.resource).toBe("api");
		expect(body.remediation).toContain("HOBO_CLOUD_NATIVE_ENDPOINT_API");
	});

	it("close() clears the handler map", async () => {
		const provider = createCloudflareCloudNativeProvider({});
		const serve = await provider.servePrivate(serveCtx());
		expect(serve.handlers.size).toBe(1);
		await serve.close();
		expect(serve.handlers.size).toBe(0);
	});
});

describe("cloudflare cloud-native provider: token verify (injected fetch)", () => {
	const credentials = { accountId: "acct-1", apiToken: "tok-1" };

	it("forms the verify request (URL + bearer header) and reports ready", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const provider = createCloudflareCloudNativeProvider({
			...credentials,
			fetchImpl: activeTokenFetch(calls),
		});
		const result = await provider.ensure(ensureCtx);
		expect(calls).toHaveLength(1);
		const verifyCall = calls[0];
		if (verifyCall === undefined) {
			throw new Error("expected token verify fetch");
		}
		expect(verifyCall.url).toBe(CLOUDFLARE_TOKEN_VERIFY_URL);
		expect(verifyCall.init?.method).toBe("GET");
		const headers = verifyCall.init?.headers;
		if (
			headers === undefined ||
			Array.isArray(headers) ||
			headers instanceof Headers
		) {
			throw new Error("expected authorization headers bag");
		}
		expect(headers.authorization).toBe("Bearer tok-1");
		expect(result.ready).toBe(true);
		expect(result.details).toEqual({
			provider: "cloudflare",
			implemented: true,
			tokenStatus: "active",
		});
	});

	it("throws a typed error on an inactive token", async () => {
		const provider = createCloudflareCloudNativeProvider({
			...credentials,
			// SAFETY: assertion required at this I/O or test boundary.
			fetchImpl: (async () =>
				Response.json({
					success: true,
					result: { id: "t1", status: "disabled" },
				})) as typeof fetch,
		});
		await expect(provider.ensure(ensureCtx)).rejects.toThrow(
			CloudflareCloudNativeError,
		);
		await expect(provider.ensure(ensureCtx)).rejects.toThrow(
			/not active \(status: disabled\)/,
		);
	});

	it("throws a typed error on a malformed payload", async () => {
		const provider = createCloudflareCloudNativeProvider({
			...credentials,
			// SAFETY: assertion required at this I/O or test boundary.
			fetchImpl: (async () => Response.json({ nope: 1 })) as typeof fetch,
		});
		await expect(provider.ensure(ensureCtx)).rejects.toThrow(
			CloudflareCloudNativeError,
		);
	});

	it("throws a typed error with remediation on a non-ok response", async () => {
		const provider = createCloudflareCloudNativeProvider({
			...credentials,
			// SAFETY: assertion required at this I/O or test boundary.
			fetchImpl: (async () =>
				new Response("nope", { status: 403 })) as typeof fetch,
		});
		const failure = await provider.ensure(ensureCtx).catch((error) => error);
		expect(failure).toBeInstanceOf(CloudflareCloudNativeError);
		expect(failure.message).toMatch(/HTTP 403/);
		expect(failure.remediation).toMatch(/API Token/i);
	});
});

describe("cloudflare cloud-native provider: remote proxy", () => {
	it("forwards to the bound endpoint and relays status + body", async () => {
		const seen: { method: string; url: string; body: string }[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				seen.push({
					method: req.method ?? "",
					url: req.url ?? "",
					body: Buffer.concat(chunks).toString("utf8"),
				});
				res.statusCode = 418;
				res.setHeader("content-type", "text/plain");
				res.end(`teapot:${req.url}`);
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		cleanups.push(
			() => new Promise((resolve) => server.close(() => resolve())),
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const { port } = server.address() as AddressInfo;

		const provider = createCloudflareCloudNativeProvider({});
		const serve = await provider.servePrivate(
			serveCtx({
				bindleEnv: {
					HOBO_CLOUD_NATIVE_ENDPOINT_API: `http://127.0.0.1:${port}`,
				},
			}),
		);
		cleanups.push(() => serve.close());
		const response = await mustGet(
			serve.handlers,
			"api",
		)(
			new Request("http://internal/things/1?q=yes", {
				method: "POST",
				body: "ping",
			}),
		);
		expect(response.status).toBe(418);
		expect(await response.text()).toBe("teapot:/things/1?q=yes");
		expect(seen).toEqual([
			{ method: "POST", url: "/things/1?q=yes", body: "ping" },
		]);
	});

	it("rejects a malformed bound endpoint with a typed error", async () => {
		const provider = createCloudflareCloudNativeProvider({});
		await expect(
			provider.servePrivate(
				serveCtx({
					bindleEnv: { HOBO_CLOUD_NATIVE_ENDPOINT_API: "not a url" },
				}),
			),
		).rejects.toThrow(CloudflareCloudNativeError);
	});
});

describe("default registry with the real cloudflare entry", () => {
	it("still fans out across all provider ids", async () => {
		const ids = defaultCloudNativeProviders().map((p) => p.id);
		expect(ids).toEqual([
			"mock",
			"aws",
			"gcp",
			"azure",
			"vercel",
			"cloudflare",
		]);
	});

	it("cloudflare in the default registry is the real credential-gated entry", async () => {
		const cloudflare = defaultCloudNativeProviders().find(
			(p) => p.id === "cloudflare",
		);
		if (!cloudflare) throw new Error("cloudflare provider missing");
		// No credentials in this environment: fail closed, implemented: true.
		const result = await cloudflare.ensure(ensureCtx);
		expect(result.details?.implemented).toBe(true);
		expect(result.details?.credentialGated).toBe(true);
		// servePrivate no longer throws HOBO_CLOUD_NATIVE_UNIMPLEMENTED: it
		// realizes the mesh contract with honest 501 handlers.
		const serve = await cloudflare.servePrivate(serveCtx());
		cleanups.push(() => serve.close());
		expect(
			(await mustGet(serve.handlers, "api")(new Request("http://internal/")))
				.status,
		).toBe(501);
	});

	it.each([
		"aws",
		"gcp",
		"azure",
		"vercel",
	])("stub provider '%s' still throws HOBO_CLOUD_NATIVE_UNIMPLEMENTED", async (id) => {
		const host = createCloudNativeRuntimeHost({
			providers: defaultCloudNativeProviders().filter((p) => p.id === id),
			defaultProvider: id,
		});
		await expect(host.servePrivate(serveCtx())).rejects.toThrow(
			/HOBO_CLOUD_NATIVE_UNIMPLEMENTED/,
		);
	});

	it("registry ensure surfaces the credential gate without blocking mock readiness", async () => {
		const host = createCloudNativeRuntimeHost();
		const result = await host.ensure(ensureCtx);
		expect(result.ready).toBe(true);
		expect(result.notes.join("\n")).toMatch(
			/\[cloudflare\] .*credential-gated.*CLOUDFLARE_API_TOKEN/,
		);
	});
});
