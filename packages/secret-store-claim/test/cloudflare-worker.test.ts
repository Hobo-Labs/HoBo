/**
 * The Cloudflare experiment with HoBo's config-service Worker: the account,
 * the upload, the real Worker (in memory) answering health and taking its
 * single seed, the claim link sealed, the token destroyed; and finalize's
 * verification by the Worker still serving after the deadline.
 */
import { Buffer } from "node:buffer";
import { createOneTimeActionStore } from "@hobo/claims";
import {
	configServiceWorkerModules,
	createInMemoryConfigService,
	type InMemoryConfigService,
} from "@hobo/config-service-worker";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	type TemporaryAccountHttpRequest,
	type TemporaryAccountTransportPort,
} from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_DELETION_GRACE_MS,
	CLOUDFLARE_PROVIDER_ID,
	claimScopeFor,
	provisionCloudflareTemporaryStore,
	verifyCloudflareTemporaryClaim,
} from "../src/index.js";

// Obviously fake material; nothing here reaches Cloudflare.
const FAKE_TOKEN = "FAKE-cf-temporary-api-token-DO-NOT-USE-0000000000";
const FAKE_CLAIM_URL =
	"https://dash.cloudflare.com/claim-preview?claimToken=FAKE-CLAIM-TOKEN-0000000000";
// The Worker reads the real clock for its bootstrap deadline, so these do too.
const NOW = new Date();
const CLAIM_BY = NOW.getTime() + 60 * 60_000;
const ACCOUNT = "fake0000000040008000cloudflareacct";

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };
/** The `result` of a Cloudflare v4 envelope. */
type CloudflareResult = { readonly [key: string]: Json };
const passthrough = {
	seal: (value: string) => Buffer.from(value).toString("base64"),
	open: (value: string) => Buffer.from(value, "base64").toString("utf8"),
};
const consent = {
	subjectRef: "hobo-owner-session-1",
	termsUrl: CLOUDFLARE_TERMS_URL,
	privacyUrl: CLOUDFLARE_PRIVACY_URL,
	acceptedAtMs: NOW.getTime() - 1000,
	acceptanceMethod: "cli-confirmation",
};
const binding = {
	vercelTeamSlug: "hobo-team",
	vercelTeamId: "team_fixture",
	vercelProjectName: "hobo-ci",
	vercelProjectId: "prj_fixture",
	repository: "Hobo-Labs/HoBo",
};

/** The `HOBO_CONFIG_BINDING` text out of a multipart upload's metadata part. */
function uploadedBinding(body: string): string {
	const metadata =
		/name="metadata"[^]*?\r\n\r\n(\{[^\r]*\})\r\n/u.exec(body)?.[1] ?? "{}";
	const parsed: { bindings?: { name: string; text?: string }[] } =
		JSON.parse(metadata);
	return (
		parsed.bindings?.find((entry) => entry.name === "HOBO_CONFIG_BINDING")
			?.text ?? ""
	);
}

function cloudflare(options: Readonly<{ uploadStatus?: number }> = {}) {
	const requests: TemporaryAccountHttpRequest[] = [];
	let worker: InMemoryConfigService | undefined;
	const ok = (result: CloudflareResult) => ({
		status: 200,
		headers: {},
		body: JSON.stringify({ success: true, result, errors: [], messages: [] }),
	});
	const transport: TemporaryAccountTransportPort = {
		async send(request) {
			requests.push(request);
			const path = new URL(request.url).pathname;
			if (path.endsWith("/previews/challenge"))
				return ok({
					challengeToken: "FAKE-CHALLENGE-TOKEN",
					seed: Buffer.alloc(32, 7).toString("base64url"),
					k: 2,
					g: 2,
				});
			if (path.endsWith("/provisioning/previews"))
				return ok({
					account: {
						id: ACCOUNT,
						apiToken: FAKE_TOKEN,
						expiresAt: new Date(CLAIM_BY).toISOString(),
					},
					claim: {
						url: FAKE_CLAIM_URL,
						expiresAt: new Date(CLAIM_BY).toISOString(),
					},
				});
			if (request.method === "PUT") {
				if (options.uploadStatus !== undefined)
					return { status: options.uploadStatus, headers: {}, body: "{}" };
				worker = createInMemoryConfigService(
					{ HOBO_CONFIG_BINDING: uploadedBinding(request.body ?? "") },
					async () => new Response(null, { status: 404 }),
				);
				return ok({ id: "script" });
			}
			if (path.endsWith("/subdomain") && request.method === "POST")
				return ok({ enabled: true });
			if (path.endsWith("/workers/subdomain"))
				return ok({ subdomain: "hobo-test" });
			return { status: 404, headers: {}, body: "{}" };
		},
	};
	const workerFetch: typeof fetch = async (input, init) =>
		worker === undefined
			? new Response(null, { status: 404 })
			: worker.fetch(input, init);
	return { transport, requests, workerFetch, worker: () => worker };
}

async function experiment(options: Readonly<{ uploadStatus?: number }> = {}) {
	const cf = cloudflare(options);
	const store = createOneTimeActionStore(passthrough);
	const scope = claimScopeFor("ci-vercel", {});
	const result = await provisionCloudflareTemporaryStore({
		transport: cf.transport,
		consent,
		deploymentRef: "ci-vercel",
		store,
		scope,
		now: NOW,
		worker: {
			modules: await configServiceWorkerModules(),
			binding,
			fetch: cf.workerFetch,
			healthAttempts: 2,
			sleep: async () => undefined,
		},
	});
	return { ...cf, store, scope, ...result };
}

describe("the Cloudflare experiment with the config-service Worker", () => {
	it("uploads the Worker with its account token, seeds it once, seals the claim link", async () => {
		const run = await experiment();
		expect(
			run.requests.map(
				(request) => `${request.method} ${new URL(request.url).pathname}`,
			),
		).toEqual([
			"POST /client/v4/provisioning/previews/challenge",
			"POST /client/v4/provisioning/previews",
			expect.stringMatching(
				/^PUT \/client\/v4\/accounts\/[^/]+\/workers\/scripts\/hobo-config-[a-z0-9]{12}$/u,
			),
			expect.stringMatching(/^POST .*\/subdomain$/u),
			"GET /client/v4/accounts/fake0000000040008000cloudflareacct/workers/subdomain",
		]);
		const worker = run.receipt.worker;
		expect(worker).toMatchObject({ outcome: "serving" });
		if (worker?.outcome !== "serving")
			throw new Error("expected a serving Worker");
		expect(worker.origin).toMatch(
			/^https:\/\/hobo-config-[a-z0-9]{12}\.hobo-test\.workers\.dev$/u,
		);
		// The seed burned the bootstrap credential.
		expect(run.worker()?.storage.has("meta:bootstrap")).toBe(true);
		const [item] = run.bundle.items;
		expect(item?.verificationRef).toBe(
			`cloudflare-worker:${worker.storeId}:${worker.origin}`,
		);
		const visible = JSON.stringify({
			receipt: run.receipt,
			bundle: run.bundle,
		});
		expect(visible).not.toContain("FAKE-CLAIM-TOKEN");
		expect(visible).not.toContain(FAKE_TOKEN);
		const opened = await run.store.redeem({
			id: item?.oneTimeActionRef ?? "",
			...run.scope,
			audience: CLOUDFLARE_PROVIDER_ID,
			now: NOW.getTime() + 1000,
		});
		expect(opened.value).toBe(FAKE_CLAIM_URL);
	});

	it("still hands over the claim link when the Worker step fails, and says where it failed", async () => {
		const run = await experiment({ uploadStatus: 403 });
		expect(run.receipt.worker).toEqual({
			outcome: "failed",
			stage: "upload",
			code: "PROVIDER_AUTH_FAILED",
		});
		expect(run.bundle.items[0]?.verificationRef).toBe(
			`cloudflare-account:${ACCOUNT}`,
		);
	});
});

describe("finalize for a Cloudflare claim", () => {
	it("passes only after the deadline, when the Worker still answers with its store id", async () => {
		const run = await experiment();
		const item = run.bundle.items[0];
		const verificationRef = item?.verificationRef ?? "";
		const deadlineMs = item?.deadline;
		const after = (deadlineMs ?? 0) + CLOUDFLARE_DELETION_GRACE_MS + 1;
		await expect(
			verifyCloudflareTemporaryClaim({
				verificationRef,
				deadlineMs,
				nowMs: (deadlineMs ?? 0) + 1,
				fetch: run.workerFetch,
			}),
		).rejects.toMatchObject({ code: "SECRET_STORE_CLAIM_UNVERIFIED" });
		expect(
			await verifyCloudflareTemporaryClaim({
				verificationRef,
				deadlineMs,
				nowMs: after,
				fetch: run.workerFetch,
			}),
		).toMatchObject({ verified: true });
		// Deleted with the unclaimed account: nothing answers.
		expect(
			await verifyCloudflareTemporaryClaim({
				verificationRef,
				deadlineMs,
				nowMs: after,
				fetch: async () => new Response(null, { status: 404 }),
			}),
		).toMatchObject({ verified: false });
	});

	it("refuses, saying why, when there is no Worker to observe", async () => {
		await expect(
			verifyCloudflareTemporaryClaim({
				verificationRef: `cloudflare-account:${ACCOUNT}`,
				deadlineMs: CLAIM_BY,
				nowMs: CLAIM_BY + CLOUDFLARE_DELETION_GRACE_MS + 1,
			}),
		).rejects.toThrow(/no claim-status endpoint/u);
	});
});
