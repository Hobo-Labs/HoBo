import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IacProgram } from "@hobo/cloud";

import type { EventStore } from "@hobo/core";
import { at, first } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CloudflareFetch,
	type CloudflareFetchResponse,
	createCloudflareClient,
	createCloudflareDeployProvider,
	selectIacProvider,
} from "../src/index.js";

// Request-formation + provider-selection + fallback tests for the REAL Cloudflare
// Workers deploy path. NO network: `fetch` is injected/mocked throughout. The live
// call activates only when a real `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
// reach the client and is NOT exercised here — this file proves the request SHAPE
// (grounded in Cloudflare's Workers Script Upload API,
// PUT /accounts/{account_id}/workers/scripts/{script_name}, multipart module
// upload), the workers.dev URL derivation, and the env-gated selection with the
// Vercel + in-memory fallbacks intact.

const WORKER_MODULE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"deploy",
	"cloudflare",
	"worker.mjs",
);

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: FormData | string;
}

// A mocked `CloudflareFetch` that records each outbound request and returns a canned
// success body per endpoint (upload / enable-subdomain / get-subdomain). No socket
// is opened. `subdomain` is the account workers.dev subdomain surfaced by the
// GET /workers/subdomain response.
function mockFetch(subdomain = "acme", status = 200) {
	const calls: RecordedCall[] = [];
	const fetch: CloudflareFetch = async (url, init) => {
		calls.push({
			url,
			method: init.method,
			headers: init.headers,
			...(init.body !== undefined ? { body: init.body } : undefined),
		});
		const body = url.endsWith("/workers/subdomain")
			? { result: { subdomain }, success: true }
			: { success: true, result: {} };
		const response: CloudflareFetchResponse = {
			ok: status >= 200 && status < 300,
			status,
			async text() {
				return JSON.stringify(body);
			},
			async json() {
				return body;
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
		provider: "cloudflare",
		driver: "cloudflare",
		action: "apply",
		stackName: `stack-${resourceId}`,
	};
}

describe("fixture deployment boundary and confirmed cleanup", () => {
	it("does not substitute the committed hello fixture for a production artifact", async () => {
		const fx = mockFetch();
		const provider = createCloudflareDeployProvider({
			token: "fixture-token",
			accountId: "account",
			fetch: fx.fetch,
		});
		await expect(provider.apply(programFor("deploy", "app"))).rejects.toThrow(
			"fixtureArtifact:true",
		);
		expect(fx.calls).toEqual([]);
	});
	it("does not treat a DELETE acknowledgement as confirmed retirement", async () => {
		const fx = mockFetch();
		const client = createCloudflareClient({
			token: "fixture-token",
			accountId: "account",
			fetch: fx.fetch,
		});
		await expect(client.deleteWorker("worker")).rejects.toThrow("unconfirmed");
		expect(fx.calls.map((call) => call.method)).toEqual(["DELETE", "GET"]);
	});
});

describe("createCloudflareClient.uploadWorker (mocked fetch, no network)", () => {
	it("PUTs the script-upload URL with Bearer auth + a multipart body naming the ESM module", async () => {
		const { fetch, calls } = mockFetch("acme");
		const client = createCloudflareClient({
			token: "cf_secret",
			accountId: "acct_123",
			fetch,
		});

		const result = await client.uploadWorker({
			scriptName: "hobo-hello-bindle",
			moduleContent:
				"export default { async fetch() { return new Response('ok'); } };",
		});

		// Three calls: PUT upload, POST enable-subdomain, GET account subdomain.
		expect(calls.length).toBe(3);

		// 1) Correct endpoint + method (Workers Script Upload).
		const upload = first(calls);
		expect(upload.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct_123/workers/scripts/hobo-hello-bindle",
		);
		expect(upload.method).toBe("PUT");
		expect(upload.headers.Authorization).toBe("Bearer cf_secret");
		// The transport sets multipart Content-Type + boundary; the client must NOT.
		expect(upload.headers["Content-Type"]).toBeUndefined();

		// The multipart body: a metadata part naming the ESM main_module + the module
		// file part typed application/javascript+module.
		expect(upload.body).toBeInstanceOf(FormData);
		// SAFETY: assertion required at this I/O or test boundary.
		const form = upload.body as FormData;
		const metadataPart = form.get("metadata");
		expect(metadataPart).toBeInstanceOf(Blob);
		// SAFETY: assertion required at this I/O or test boundary.
		const metadata = JSON.parse(await (metadataPart as Blob).text()) as {
			main_module: string;
			compatibility_date: string;
		};
		expect(metadata.main_module).toBe("worker.mjs");
		expect(metadata.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const modulePart = form.get("worker.mjs");
		expect(modulePart).toBeInstanceOf(Blob);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((modulePart as Blob).type).toBe("application/javascript+module");
		// SAFETY: assertion required at this I/O or test boundary.
		expect(await (modulePart as Blob).text()).toContain("export default");

		// 2) Enable workers.dev route for the script.
		const enable = at(calls, 1);
		expect(enable.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct_123/workers/scripts/hobo-hello-bindle/subdomain",
		);
		expect(enable.method).toBe("POST");
		expect(enable.headers.Authorization).toBe("Bearer cf_secret");
		// SAFETY: assertion required at this I/O or test boundary.
		expect(JSON.parse(enable.body as string)).toEqual({ enabled: true });

		// 3) Derive the deployed URL from the account subdomain.
		const sub = at(calls, 2);
		expect(sub.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct_123/workers/subdomain",
		);
		expect(sub.method).toBe("GET");

		// The workers.dev URL is <script>.<subdomain>.workers.dev.
		expect(result.url).toBe("https://hobo-hello-bindle.acme.workers.dev");
		expect(result.scriptName).toBe("hobo-hello-bindle");
	});

	it("skips route-enable + URL derivation when enableSubdomain is false, and throws on non-2xx", async () => {
		const ok = mockFetch("acme");
		const client = createCloudflareClient({
			token: "t",
			accountId: "a",
			fetch: ok.fetch,
		});
		const res = await client.uploadWorker({
			scriptName: "n",
			moduleContent: "export default {};",
			enableSubdomain: false,
		});
		// Only the upload PUT happened; no subdomain calls.
		expect(ok.calls.length).toBe(1);
		expect(res.url).toBe("");

		const bad = mockFetch("acme", 403);
		const failClient = createCloudflareClient({
			token: "t",
			accountId: "a",
			fetch: bad.fetch,
		});
		await expect(
			failClient.uploadWorker({ scriptName: "n", moduleContent: "x" }),
		).rejects.toThrow(/HTTP 403/);
	});
});

describe("createCloudflareClient.scriptExists (mocked fetch, no network)", () => {
	function getMock(status: number) {
		const calls: RecordedCall[] = [];
		const fetch: CloudflareFetch = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body !== undefined ? { body: init.body } : undefined),
			});
			const response: CloudflareFetchResponse = {
				ok: status >= 200 && status < 300,
				status,
				async text() {
					return "{}";
				},
				async json() {
					return {};
				},
			};
			return response;
		};
		return { fetch, calls };
	}

	it("GETs the script and returns true on 2xx", async () => {
		const { fetch, calls } = getMock(200);
		const client = createCloudflareClient({
			token: "t",
			accountId: "a",
			fetch,
		});
		await expect(client.scriptExists("hobo-hello-bindle")).resolves.toBe(true);
		expect(first(calls).method).toBe("GET");
		expect(first(calls).url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/hobo-hello-bindle",
		);
		expect(first(calls).headers.Authorization).toBe("Bearer t");
	});

	it("returns false on 404 (deleted out of band = drift)", async () => {
		const { fetch } = getMock(404);
		const client = createCloudflareClient({
			token: "t",
			accountId: "a",
			fetch,
		});
		await expect(client.scriptExists("gone")).resolves.toBe(false);
	});

	it("throws on a non-404 error status", async () => {
		const { fetch } = getMock(500);
		const client = createCloudflareClient({
			token: "t",
			accountId: "a",
			fetch,
		});
		await expect(client.scriptExists("n")).rejects.toThrow(/HTTP 500/);
	});
});

describe("createCloudflareDeployProvider (mocked fetch, no network)", () => {
	it("apply uploads the committed worker.mjs and maps the workers.dev URL into IacOutputs", async () => {
		const { fetch, calls } = mockFetch("acme");
		const provider = createCloudflareDeployProvider({
			fixtureArtifact: true,
			token: "tok",
			accountId: "acct",
			fetch,
		});

		const outputs = await provider.apply(programFor("dep-1", "service"));

		// The upload carried the exact committed module bytes.
		const upload = first(calls);
		// SAFETY: assertion required at this I/O or test boundary.
		const form = upload.body as FormData;
		// SAFETY: assertion required at this I/O or test boundary.
		const uploaded = await (form.get("worker.mjs") as Blob).text();
		expect(uploaded).toBe(readFileSync(WORKER_MODULE, "utf-8"));

		expect(outputs.url).toBe("https://hobo-hello-bindle.acme.workers.dev");
		expect(outputs.scriptName).toBe("hobo-hello-bindle");
		expect(outputs.provider).toBe("cloudflare");
		expect(outputs.target).toBe("production");
	});

	it("apply is memoized per deploymentId (one real Worker upload per plan)", async () => {
		const { fetch, calls } = mockFetch("acme");
		const provider = createCloudflareDeployProvider({
			fixtureArtifact: true,
			token: "tok",
			accountId: "acct",
			fetch,
		});

		const a = await provider.apply(programFor("dep-2", "service"));
		const b = await provider.apply(programFor("dep-2", "sessions"));
		const c = await provider.apply(programFor("dep-2", "assets"));

		// Executor drives the port once per resource; only ONE upload flow runs (the
		// 3-call upload/enable/derive sequence for the first resource).
		expect(calls.length).toBe(3);
		expect(a).toEqual(b);
		expect(b).toEqual(c);
	});

	it("preview is a dry run and does not call fetch", async () => {
		const { fetch, calls } = mockFetch("acme");
		const provider = createCloudflareDeployProvider({
			fixtureArtifact: true,
			token: "tok",
			accountId: "acct",
			fetch,
		});
		const diff = await provider.preview(programFor("dep-3", "service"));
		expect(calls.length).toBe(0);
		expect(diff.changes).toBeGreaterThan(0);
		expect(diff.summary).toMatch(/dry-run/);
	});
});

describe("selectIacProvider env-gated selection (Cloudflare + Vercel + fallback)", () => {
	// Construction of the Pulumi-backed provider does not touch the store/providers
	// (it reads them lazily on apply), so a light stand-in suffices for a
	// selection-only assertion.
	const pulumiDeps = {
		// SAFETY: assertion required at this I/O or test boundary.
		store: {} as EventStore,
		providers: [],
	};
	const { fetch: cfFetch } = mockFetch("acme");

	let savedCfToken: string | undefined;
	let savedCfAccount: string | undefined;
	const savedVercel = process.env.VERCEL_TOKEN;

	afterEach(() => {
		const restore = (key: string, value: string | undefined): void => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore("CLOUDFLARE_API_TOKEN", savedCfToken);
		restore("CLOUDFLARE_ACCOUNT_ID", savedCfAccount);
		restore("VERCEL_TOKEN", savedVercel);
	});

	it("selects the REAL Cloudflare provider when both CF envs are set (via process.env)", () => {
		savedCfToken = process.env.CLOUDFLARE_API_TOKEN;
		savedCfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
		process.env.CLOUDFLARE_API_TOKEN = "cf_from_env";
		process.env.CLOUDFLARE_ACCOUNT_ID = "acct_from_env";
		const provider = selectIacProvider({
			...pulumiDeps,
			cloudflareFetch: cfFetch,
		});
		expect(provider.id).toMatch(/^resolver-backed:/);
	});

	it("Cloudflare takes precedence over Vercel when both credentials are present", () => {
		const provider = selectIacProvider({
			...pulumiDeps,
			env: {
				CLOUDFLARE_API_TOKEN: "cf",
				CLOUDFLARE_ACCOUNT_ID: "acct",
				VERCEL_TOKEN: "v",
			},
			cloudflareFetch: cfFetch,
		});
		expect(provider.id).toMatch(/^resolver-backed:/);
	});

	it("falls back to Vercel when only VERCEL_TOKEN is set (CF envs absent)", () => {
		const provider = selectIacProvider({
			...pulumiDeps,
			env: { VERCEL_TOKEN: "v" },
		});
		expect(provider.id).toMatch(/^resolver-backed:/);
	});

	it("requires BOTH CF envs — the token alone (no account id) does not select Cloudflare", () => {
		const provider = selectIacProvider({
			...pulumiDeps,
			env: { CLOUDFLARE_API_TOKEN: "cf" },
		});
		expect(provider.id).toMatch(/^pulumi-backed:/);
	});

	it("falls back to the in-memory Pulumi-backed provider when no cloud creds are set", () => {
		const provider = selectIacProvider({ ...pulumiDeps, env: {} });
		expect(provider.id).toMatch(/^pulumi-backed:/);
	});

	it("a Pulumi adapter override forces the Pulumi lane even with CF envs set", () => {
		const provider = selectIacProvider({
			...pulumiDeps,
			env: { CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" },
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
