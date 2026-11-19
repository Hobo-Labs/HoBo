/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: CdHost stubs exercise only handle(); other fields are never read. */
import { createServer, type Server } from "node:http";
import type { CdHost } from "@hobo/hobo/cd-platform";
import { createMemorySecretsPort } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCdHost } from "../src/entry.js";
import {
	CdStoreBindingError,
	composeVercelCdHost,
	createCdHttpEntry,
	holderIdOf,
	incomingRequestPath,
	journalFleetEnvProvisioned,
	memoizedCdHost,
	parseCdStoreCoordinates,
	readCdStoreCoordinates,
	topologyFilesOf,
} from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(handler: ReturnType<typeof createCdHttpEntry>) {
	const server = createServer((req, res) => void handler(req, res));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = z.object({ port: z.number() }).parse(server.address());
	return `http://127.0.0.1:${port}`;
}

const failing = (code: string) => async (): Promise<CdHost> => {
	throw new CdStoreBindingError(code, "not today");
};

function withVercel<T>(value: string | undefined, run: () => T): T {
	const previous = process.env.VERCEL;
	if (value === undefined) delete process.env.VERCEL;
	else process.env.VERCEL = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.VERCEL;
		else process.env.VERCEL = previous;
	}
}

describe("the CD function's HTTP entry", () => {
	it("uses the original URL path when Vercel rewrites to the function", () => {
		const path = withVercel("1", () =>
			incomingRequestPath({
				url: "/api/cd",
				headers: {
					"x-vercel-original-url":
						"https://hobo-cd.vercel.app/v1/cd/freight?x=1",
				},
			} as never),
		);
		expect(path).toBe("/v1/cd/freight?x=1");
	});

	it("uses the invoke path of the /api/cd destination, keeping the query", () => {
		const path = withVercel("1", () =>
			incomingRequestPath({
				url: "/api/cd?x=1",
				headers: { "x-vercel-invoke-path": "/v1/cd/freight" },
			} as never),
		);
		expect(path).toBe("/v1/cd/freight?x=1");
		const probe = withVercel("1", () =>
			incomingRequestPath({
				url: "/api/cd",
				headers: { "x-vercel-invoke-path": "healthz" },
			} as never),
		);
		expect(probe).toBe("/healthz");
	});

	it("ignores Vercel path headers outside Vercel", () => {
		const original = withVercel(undefined, () =>
			incomingRequestPath({
				url: "/api/cd?x=1",
				headers: {
					"x-vercel-original-url": "https://spoofed.example/v1/cd/freight?x=1",
				},
			} as never),
		);
		expect(original).toBe("/api/cd?x=1");
		const invoke = withVercel(undefined, () =>
			incomingRequestPath({
				url: "/api/cd?x=1",
				headers: { "x-vercel-invoke-path": "/v1/cd/freight" },
			} as never),
		);
		expect(invoke).toBe("/api/cd?x=1");
		const otherValue = withVercel("0", () =>
			incomingRequestPath({
				url: "/api/cd",
				headers: { "x-vercel-invoke-path": "/readyz" },
			} as never),
		);
		expect(otherValue).toBe("/api/cd");
	});

	it("answers /healthz with the build's commit without composing CD", async () => {
		let composed = 0;
		const origin = await serve(
			createCdHttpEntry(
				async () => {
					composed += 1;
					throw new Error("must not compose");
				},
				{ commit: "abc123" },
			),
		);
		const res = await fetch(`${origin}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, commit: "abc123" });
		expect(composed).toBe(0);
	});

	it("answers HEAD /healthz without composing CD", async () => {
		let composed = 0;
		const origin = await serve(
			createCdHttpEntry(
				async () => {
					composed += 1;
					throw new Error("must not compose");
				},
				{ commit: "abc123" },
			),
		);
		const head = await fetch(`${origin}/healthz`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(composed).toBe(0);
		const get = await fetch(`${origin}/healthz`);
		expect(get.status).toBe(head.status);
		expect(await get.json()).toEqual({ ok: true, commit: "abc123" });
		expect(composed).toBe(0);
	});

	it("rejects non-GET probes by method before composing CD", async () => {
		let composed = 0;
		const origin = await serve(
			createCdHttpEntry(async () => {
				composed += 1;
				throw new Error("must not compose");
			}),
		);
		for (const method of ["POST", "PUT", "DELETE"] as const) {
			const health = await fetch(`${origin}/healthz`, { method });
			expect(health.status).toBe(405);
			expect(await health.json()).toMatchObject({
				ok: false,
				code: "cd-probe-method-not-allowed",
			});
			const ready = await fetch(`${origin}/readyz`, { method });
			expect(ready.status).toBe(405);
			expect(await ready.json()).toMatchObject({
				ok: false,
				code: "cd-probe-method-not-allowed",
			});
		}
		expect(composed).toBe(0);
	});

	it("says why it is not ready, by code, while CD cannot compose", async () => {
		const origin = await serve(
			createCdHttpEntry(failing("cd-store-binding-missing")),
		);
		const ready = await fetch(`${origin}/readyz`);
		expect(ready.status).toBe(503);
		expect(await ready.json()).toEqual({
			ready: false,
			started: false,
			code: "cd-store-binding-missing",
		});
		expect((await fetch(`${origin}/v1/cd/openapi.json`)).status).toBe(503);
	});

	it("hands /readyz to the composed host past the operator-read gate", async () => {
		let ready = false;
		const seen: string[] = [];
		const host: CdHost = {
			handle: async (request: { path: string }) => {
				seen.push(request.path);
				return {
					status: ready ? 200 : 503,
					headers: { "content-type": "application/json" },
					body: new TextEncoder().encode(
						JSON.stringify({ ok: ready, readiness: "composed" }),
					),
				};
			},
		} as never;
		const origin = await serve(
			createCdHttpEntry(async () => host, { operatorReads: "deny" }),
		);
		const notReady = await fetch(`${origin}/readyz`);
		expect(notReady.status).toBe(503);
		expect(await notReady.json()).toEqual({
			ok: false,
			readiness: "composed",
		});
		ready = true;
		const readyRes = await fetch(`${origin}/readyz`);
		expect(readyRes.status).toBe(200);
		expect(await readyRes.json()).toEqual({
			ok: true,
			readiness: "composed",
		});
		expect(seen).toEqual(["/readyz", "/readyz"]);
		const denied = await fetch(`${origin}/v1/cd/pipelines/main`);
		expect(denied.status).toBe(401);
		expect(seen).toEqual(["/readyz", "/readyz"]);
	});

	it("hands every other request to the CD mount", async () => {
		const seen: string[] = [];
		const host: CdHost = {
			handle: async (request: { path: string }) => {
				seen.push(request.path);
				return {
					status: 202,
					headers: { "content-type": "text/plain" },
					body: new TextEncoder().encode("ok"),
				};
			},
		} as never;
		const origin = await serve(createCdHttpEntry(async () => host));
		const res = await fetch(`${origin}/v1/cd/freight?x=1`);
		expect(res.status).toBe(202);
		expect(await res.text()).toBe("ok");
		expect(seen).toEqual(["/v1/cd/freight?x=1"]);
	});

	it("does not expose internal errors to HTTP clients", async () => {
		const secret = "fixture-sensitive-value";
		const host: CdHost = {
			handle: async () => {
				throw new Error(`provider failed with ${secret}`);
			},
		} as never;
		const origin = await serve(createCdHttpEntry(async () => host));
		const response = await fetch(`${origin}/v1/cd/freight`);
		expect(response.status).toBe(500);
		const body = await response.text();
		expect(body).not.toContain(secret);
		expect(JSON.parse(body)).toMatchObject({
			ok: false,
			code: "cd-serve-error",
		});
	});

	it("denies operator reads on the production entry", async () => {
		const host: CdHost = {
			handle: async () => ({
				status: 200,
				headers: {},
				body: new Uint8Array(),
			}),
		} as never;
		const origin = await serve(
			createCdHttpEntry(async () => host, { operatorReads: "deny" }),
		);
		const response = await fetch(`${origin}/v1/cd/pipelines/main`);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			code: "cd-operator-read-denied",
		});
	});

	it("denies operator reads by default", async () => {
		let handled = 0;
		const host: CdHost = {
			handle: async () => {
				handled += 1;
				return { status: 200, headers: {}, body: new Uint8Array() };
			},
		} as never;
		const origin = await serve(createCdHttpEntry(async () => host));
		const response = await fetch(`${origin}/v1/cd/pipelines/main`);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			code: "cd-operator-read-denied",
		});
		expect(handled).toBe(0);
	});

	it("denies requests the read parser refuses", async () => {
		let handled = 0;
		const host: CdHost = {
			handle: async () => {
				handled += 1;
				return { status: 200, headers: {}, body: new Uint8Array() };
			},
		} as never;
		const origin = await serve(createCdHttpEntry(async () => host));
		const response = await fetch(`${origin}/v1/cd/pipelines/main`, {
			method: "POST",
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			ok: false,
			code: "cd-operator-read-denied",
		});
		expect(handled).toBe(0);
	});

	it("composes once, and tries again after a failure", async () => {
		let calls = 0;
		const host = {} as CdHost;
		const load = memoizedCdHost(async () => {
			calls += 1;
			if (calls === 1) throw new Error("store briefly unreachable");
			return host;
		});
		await expect(load()).rejects.toThrow("briefly");
		expect(await load()).toBe(host);
		expect(await load()).toBe(host);
		expect(calls).toBe(2);
	});
});

describe("the owner's store, and the journal fleet in it", () => {
	const binding = {
		kind: "infisical-cloud-attach",
		endpoint: "https://app.infisical.com",
		projectId: "00000000-0000-4000-8000-000000000001",
		environment: "prod",
		secretPath: "/hobo-cd",
		relayIdentityId: "00000000-0000-4000-8000-000000000002",
	};

	it("reads the committed coordinates, and refuses a malformed binding", () => {
		const parsed = parseCdStoreCoordinates(JSON.stringify(binding));
		expect(parsed.binding.siteUrl).toBe("https://app.infisical.com");
		expect(parsed.binding.projectId).toBe(binding.projectId);
		expect(parsed.binding.environment).toBe("prod");
		expect(parsed.binding.secretPath).toBe("/hobo-cd");
		expect(parsed.identityId).toBe(binding.relayIdentityId);
		expect(() => parseCdStoreCoordinates("{}")).toThrow(
			expect.objectContaining({ code: "cd-store-binding-invalid" }),
		);
	});

	it("treats a blank journal fleet env as not provisioned", () => {
		expect(journalFleetEnvProvisioned({ HOBO_CD_POSTGRES_FLEET: "  " })).toBe(
			false,
		);
		expect(journalFleetEnvProvisioned({ HOBO_CD_POSTGRES_FLEET: "f1" })).toBe(
			true,
		);
	});

	it("says no binding is committed until hobo cd up writes one", () => {
		expect(() =>
			readCdStoreCoordinates(new URL("file:///nowhere/binding.json")),
		).toThrow(expect.objectContaining({ code: "cd-store-binding-missing" }));
	});

	it("names each composition by deployment and a fresh holder id", () => {
		const first = holderIdOf({ VERCEL_DEPLOYMENT_ID: "dpl_123" });
		const second = holderIdOf({ VERCEL_DEPLOYMENT_ID: "dpl_123" });
		expect(first).toMatch(/^hobo-cd-vercel:dpl_123:[0-9a-f-]{36}$/u);
		expect(second).toMatch(/^hobo-cd-vercel:dpl_123:[0-9a-f-]{36}$/u);
		expect(first).not.toBe(second);
		const unsetFirst = holderIdOf({});
		const unsetSecond = holderIdOf({});
		expect(unsetFirst).toMatch(/^hobo-cd-vercel:[^:]*:[0-9a-f-]{36}$/u);
		expect(unsetSecond).toMatch(/^hobo-cd-vercel:[^:]*:[0-9a-f-]{36}$/u);
		expect(unsetFirst).not.toBe(unsetSecond);
	});

	it("refuses a non-production deployment before opening the store", async () => {
		let opened = 0;
		await expect(
			composeVercelCdHost({
				env: { VERCEL_ENV: "preview" },
				cwd: "/tmp",
				open: () => {
					opened += 1;
					throw new Error("must not open");
				},
			}),
		).rejects.toMatchObject({ code: "cd-non-production-deployment" });
		expect(opened).toBe(0);
	});

	it("refuses an unset VERCEL_ENV before opening the store", async () => {
		let opened = 0;
		await expect(
			composeVercelCdHost({
				env: {},
				cwd: "/tmp",
				open: () => {
					opened += 1;
					throw new Error("must not open");
				},
			}),
		).rejects.toMatchObject({ code: "cd-non-production-deployment" });
		expect(opened).toBe(0);
	});

	it("refuses an unset VERCEL_ENV even with the allowance flag set", async () => {
		let opened = 0;
		await expect(
			composeVercelCdHost({
				env: { HOBO_CD_ALLOW_UNSET_VERCEL_ENV: "1" },
				cwd: "/tmp",
				open: () => {
					opened += 1;
					throw new Error("must not open");
				},
			}),
		).rejects.toMatchObject({ code: "cd-non-production-deployment" });
		expect(opened).toBe(0);
	});

	it("refuses a preview deployment even with the allowance flag set", async () => {
		let opened = 0;
		await expect(
			composeVercelCdHost({
				env: {
					VERCEL_ENV: "preview",
					HOBO_CD_ALLOW_UNSET_VERCEL_ENV: "1",
				},
				cwd: "/tmp",
				open: () => {
					opened += 1;
					throw new Error("must not open");
				},
			}),
		).rejects.toMatchObject({ code: "cd-non-production-deployment" });
		expect(opened).toBe(0);
	});

	it("refuses to start on a store with no journal fleet, never on SQLite", async () => {
		let opened = 0;
		await expect(
			composeVercelCdHost({
				env: { VERCEL_ENV: "production" },
				cwd: "/tmp",
				open: () => {
					opened += 1;
					return {
						id: "infisical",
						port: createMemorySecretsPort({ id: "memory" }),
						reference: (name) => `infisical://test/${name}`,
					};
				},
			}),
		).rejects.toMatchObject({ code: "cd-journal-not-provisioned" });
		expect(opened).toBe(1);
	});

	it("loadCdHost refuses a non-production deployment before reading the binding", async () => {
		await expect(loadCdHost()).rejects.toMatchObject({
			code: "cd-non-production-deployment",
		});
	});

	it("reads the topology files a deployment declares", () => {
		expect(topologyFilesOf({ HOBO_CD_TOPOLOGY: " a.ts, ,b.ts" })).toEqual([
			"a.ts",
			"b.ts",
		]);
		expect(topologyFilesOf({})).toEqual([]);
	});
});
