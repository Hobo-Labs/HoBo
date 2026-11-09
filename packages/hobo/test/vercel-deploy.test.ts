import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IacProgram } from "@hobo/cloud";
import type { EventStore } from "@hobo/core";
import { first } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	createVercelClient,
	createVercelDeployProvider,
	selectIacProvider,
	type VercelFetch,
	type VercelFetchResponse,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

// Request-formation + provider-selection + fallback tests for the REAL Vercel
// deploy path. NO network: `fetch` is injected/mocked throughout. The live call
// activates only when a real `VERCEL_TOKEN` reaches the client and is NOT
// exercised here — this file proves the request SHAPE (grounded in Vercel's
// Create Deployment API, POST /v13/deployments), the outputs mapping, and the
// env-gated selection with the in-memory fallback intact.

const ARTIFACT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"deploy",
	"vercel",
);

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

// A mocked `VercelFetch` that records the outbound request and returns a canned
// Create-Deployment success body. No socket is opened.
function mockFetch(responseBody: JsonObject, status = 200) {
	const calls: RecordedCall[] = [];
	const fetch: VercelFetch = async (url, init) => {
		calls.push({
			url,
			method: init.method,
			headers: init.headers,
			body: init.body,
		});
		const response: VercelFetchResponse = {
			ok: status >= 200 && status < 300,
			status,
			async text() {
				return JSON.stringify(responseBody);
			},
			async json() {
				return responseBody;
			},
		};
		return response;
	};
	return { fetch, calls };
}

function programFor(deploymentId: string, resourceId: string): IacProgram {
	return {
		programId: `prog-${resourceId}`,
		deploymentId,
		resourceId,
		provider: "vercel",
		driver: "vercel",
		action: "apply",
		stackName: `stack-${resourceId}`,
	};
}

describe("fixture deployment boundary and confirmed cleanup", () => {
	it("does not substitute the committed hello fixture for a production artifact", async () => {
		const fx = mockFetch({ id: "unused", url: "unused.vercel.app" });
		const provider = createVercelDeployProvider({
			token: "fixture-token",
			fetch: fx.fetch,
		});
		await expect(provider.apply(programFor("deploy", "app"))).rejects.toThrow(
			"fixtureArtifact:true",
		);
		expect(fx.calls).toEqual([]);
	});
	it("rejects a successful DELETE followed by a still-present deployment", async () => {
		const fx = mockFetch({ id: "dpl_pinned", url: "pinned.vercel.app" });
		const client = createVercelClient({
			token: "fixture-token",
			fetch: fx.fetch,
			teamId: "team_pinned",
		});
		await expect(client.deleteDeployment("dpl_pinned")).rejects.toThrow(
			"unconfirmed",
		);
		expect(fx.calls.map((call) => call.method)).toEqual(["DELETE", "GET"]);
		expect(
			fx.calls.every((call) =>
				call.url.includes("dpl_pinned?teamId=team_pinned"),
			),
		).toBe(true);
	});
});

describe("createVercelClient.createDeployment (mocked fetch, no network)", () => {
	it("POSTs to /v13/deployments with Bearer auth, the artifact file payload, and target", async () => {
		const { fetch, calls } = mockFetch({
			id: "dpl_test123",
			url: "hobo-hello-bindle-abc.vercel.app",
			readyState: "QUEUED",
		});
		const client = createVercelClient({ token: "tok_secret", fetch });

		const indexHtml = readFileSync(join(ARTIFACT_DIR, "index.html"));
		const files = [
			{
				file: "index.html",
				data: indexHtml.toString("base64"),
				encoding: "base64" as const,
			},
		];

		const result = await client.createDeployment({
			name: "hobo-hello-bindle",
			files,
			target: "production",
		});

		expect(calls.length).toBe(1);
		const call = first(calls);
		// Correct endpoint + method (Vercel Create Deployment).
		expect(call.url).toBe("https://api.vercel.com/v13/deployments");
		expect(call.method).toBe("POST");
		// Auth header shape.
		expect(call.headers.Authorization).toBe("Bearer tok_secret");
		expect(call.headers["Content-Type"]).toBe("application/json");

		// SAFETY: assertion required at this I/O or test boundary.
		const sent = JSON.parse(call.body) as {
			name: string;
			project: string;
			target: string;
			projectSettings: JsonObject;
			files: Array<{ file: string; data: string; encoding: string }>;
		};
		expect(sent.name).toBe("hobo-hello-bindle");
		expect(sent.project).toBe("hobo-hello-bindle");
		expect(sent.target).toBe("production");
		expect(sent.projectSettings).toEqual({ framework: null });
		// The files payload carries the exact artifact bytes, base64-encoded.
		expect(sent.files).toHaveLength(1);
		expect(first(sent.files).file).toBe("index.html");
		expect(first(sent.files).encoding).toBe("base64");
		expect(
			Buffer.from(first(sent.files).data, "base64").toString("utf-8"),
		).toBe(indexHtml.toString("utf-8"));

		// Response parsing: URL normalized to include the scheme; id surfaced.
		expect(result.url).toBe("https://hobo-hello-bindle-abc.vercel.app");
		expect(result.id).toBe("dpl_test123");
		expect(result.readyState).toBe("QUEUED");
	});

	it("passes teamId as a query parameter and throws on a non-2xx response", async () => {
		const okCall = mockFetch({ id: "dpl_1", url: "x.vercel.app" });
		const client = createVercelClient({
			token: "t",
			fetch: okCall.fetch,
			teamId: "team_42",
		});
		await client.createDeployment({ name: "n", files: [] });
		expect(first(okCall.calls).url).toBe(
			"https://api.vercel.com/v13/deployments?teamId=team_42",
		);

		const bad = mockFetch({ error: { message: "forbidden" } }, 403);
		const failClient = createVercelClient({ token: "t", fetch: bad.fetch });
		await expect(
			failClient.createDeployment({ name: "n", files: [] }),
		).rejects.toThrow(/HTTP 403/);
	});
});

describe("createVercelDeployProvider (mocked fetch, no network)", () => {
	it("apply deploys the committed artifact tree and maps the URL into IacOutputs", async () => {
		const { fetch, calls } = mockFetch({
			id: "dpl_apply",
			url: "hobo-hello-bindle-xyz.vercel.app",
		});
		const provider = createVercelDeployProvider({
			fixtureArtifact: true,
			token: "tok",
			fetch,
		});

		const outputs = await provider.apply(programFor("dep-1", "service"));

		expect(calls.length).toBe(1);
		expect(outputs.url).toBe("https://hobo-hello-bindle-xyz.vercel.app");
		expect(outputs.deploymentId).toBe("dpl_apply");
		expect(outputs.provider).toBe("vercel");
		expect(outputs.target).toBe("production");

		// The deploy payload is the committed artifact tree (the known-good source
		// of truth): the three core files are present as base64 inline files.
		// SAFETY: assertion required at this I/O or test boundary.
		const sent = JSON.parse(first(calls).body) as {
			files: Array<{ file: string; encoding: string }>;
		};
		const names = sent.files.map((f) => f.file).sort();
		expect(names).toContain("index.html");
		expect(names).toContain("api/hello.js");
		expect(names).toContain("vercel.json");
		for (const f of sent.files) expect(f.encoding).toBe("base64");
	});

	it("apply is memoized per deploymentId (one real Vercel deployment per plan)", async () => {
		const { fetch, calls } = mockFetch({ id: "dpl_memo", url: "m.vercel.app" });
		const provider = createVercelDeployProvider({
			fixtureArtifact: true,
			token: "tok",
			fetch,
		});

		const a = await provider.apply(programFor("dep-2", "service"));
		const b = await provider.apply(programFor("dep-2", "sessions"));
		const c = await provider.apply(programFor("dep-2", "assets"));

		// Executor drives the port once per resource; only ONE deployment is created.
		expect(calls.length).toBe(1);
		expect(a).toEqual(b);
		expect(b).toEqual(c);
	});

	it("preview is a dry run and does not call fetch", async () => {
		const { fetch, calls } = mockFetch({ id: "d", url: "d.vercel.app" });
		const provider = createVercelDeployProvider({
			fixtureArtifact: true,
			token: "tok",
			fetch,
		});
		const diff = await provider.preview(programFor("dep-3", "service"));
		expect(calls.length).toBe(0);
		expect(diff.changes).toBeGreaterThan(0);
		expect(diff.summary).toMatch(/dry-run/);
	});
});

describe("selectIacProvider env-gated selection (fallback intact)", () => {
	// Construction of the Pulumi-backed provider does not touch the store/providers
	// (it reads them lazily on apply), so a light stand-in suffices for a
	// selection-only assertion.
	const pulumiDeps = {
		// SAFETY: assertion required at this I/O or test boundary.
		store: {} as EventStore,
		providers: [],
	};
	const { fetch } = mockFetch({ id: "d", url: "d.vercel.app" });

	let savedToken: string | undefined;
	afterEach(() => {
		if (savedToken === undefined) delete process.env.VERCEL_TOKEN;
		else process.env.VERCEL_TOKEN = savedToken;
	});

	it("selects the REAL Vercel provider when VERCEL_TOKEN is set (via process.env)", () => {
		savedToken = process.env.VERCEL_TOKEN;
		process.env.VERCEL_TOKEN = "tok_from_env";
		const provider = selectIacProvider({ ...pulumiDeps, vercelFetch: fetch });
		expect(provider.id).toMatch(/^resolver-backed:/);
	});

	it("falls back to the in-memory Pulumi-backed provider when VERCEL_TOKEN is absent", () => {
		savedToken = process.env.VERCEL_TOKEN;
		delete process.env.VERCEL_TOKEN;
		const provider = selectIacProvider(pulumiDeps);
		expect(provider.id).toMatch(/^pulumi-backed:/);
	});

	it("also selects via an injected env snapshot (no global mutation)", () => {
		const vercel = selectIacProvider({
			...pulumiDeps,
			env: { VERCEL_TOKEN: "tok_injected" },
			vercelFetch: fetch,
		});
		expect(vercel.id).toMatch(/^resolver-backed:/);
		const pulumi = selectIacProvider({ ...pulumiDeps, env: {} });
		expect(pulumi.id).toMatch(/^pulumi-backed:/);
	});

	it("a Pulumi adapter override forces the Pulumi lane even with VERCEL_TOKEN set", () => {
		const provider = selectIacProvider({
			...pulumiDeps,
			env: { VERCEL_TOKEN: "tok" },
			adapter: {
				id: "spy",
				async preview() {
					return { changes: [], dirty: false };
				},
				async apply() {
					return { resources: {} };
				},
				async destroy() {
					return undefined;
				},
				async refresh() {
					return { drifted: false };
				},
			},
		});
		expect(provider.id).toMatch(/^pulumi-backed:/);
	});
});
