/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: CdHost stubs exercise only handle(); other fields are never read. */
import { createServer, type Server } from "node:http";
import type { CdHost } from "@hobo/hobo/cd-platform";
import { createMemorySecretsPort } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
	CdStoreBindingError,
	composeVercelCdHost,
	createCdHttpEntry,
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

describe("the CD function's HTTP entry", () => {
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
		projectId: "d08a4752-b0e7-4784-b869-ada54f20f4e6",
		environment: "prod",
		secretPath: "/hobo-cd",
		relayIdentityId: "65814a06-a335-43b7-9653-3135a704c4f8",
	};

	it("reads the committed coordinates, and refuses a malformed binding", () => {
		const parsed = parseCdStoreCoordinates(JSON.stringify(binding));
		expect(parsed.identityId).toBe(binding.relayIdentityId);
		expect(() => parseCdStoreCoordinates("{}")).toThrow(
			expect.objectContaining({ code: "cd-store-binding-invalid" }),
		);
	});

	it("says no binding is committed until hobo cd up writes one", () => {
		expect(() =>
			readCdStoreCoordinates(new URL("file:///nowhere/binding.json")),
		).toThrow(expect.objectContaining({ code: "cd-store-binding-missing" }));
	});

	it("refuses to start on a store with no journal fleet, never on SQLite", async () => {
		await expect(
			composeVercelCdHost({
				env: {},
				cwd: "/tmp",
				open: () => ({
					id: "infisical",
					port: createMemorySecretsPort({ id: "memory" }),
					reference: (name) => `infisical://test/${name}`,
				}),
			}),
		).rejects.toMatchObject({ code: "cd-journal-not-provisioned" });
	});

	it("reads the topology files a deployment declares", () => {
		expect(topologyFilesOf({ HOBO_CD_TOPOLOGY: " a.ts, ,b.ts" })).toEqual([
			"a.ts",
			"b.ts",
		]);
		expect(topologyFilesOf({})).toEqual([]);
	});
});
