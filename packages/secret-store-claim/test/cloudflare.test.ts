import { Buffer } from "node:buffer";
import { createOneTimeActionStore } from "@hobo/claims";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	type TemporaryAccountHttpRequest,
	type TemporaryAccountTransportPort,
} from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_PROVIDER_ID,
	claimScopeFor,
	provisionCloudflareTemporaryStore,
} from "../src/index.js";

// Obviously fake material; nothing here reaches Cloudflare.
const FAKE_TOKEN = "FAKE-cf-temporary-api-token-DO-NOT-USE-0000000000";
const FAKE_CLAIM_URL =
	"https://dash.cloudflare.com/claim-preview?claimToken=FAKE-CLAIM-TOKEN-0000000000";
const NOW = new Date("2026-11-12T10:00:00.000Z");
const CLAIM_BY = NOW.getTime() + 60 * 60_000;
const passthrough = {
	seal: (value: string) => Buffer.from(value).toString("base64"),
	open: (value: string) => Buffer.from(value, "base64").toString("utf8"),
};

function stubCloudflare(): TemporaryAccountTransportPort & {
	readonly requests: TemporaryAccountHttpRequest[];
} {
	const requests: TemporaryAccountHttpRequest[] = [];
	return {
		requests,
		async send(request) {
			requests.push(request);
			const body = request.url.endsWith("/previews/challenge")
				? {
						success: true,
						result: {
							challengeToken: "FAKE-CHALLENGE-TOKEN",
							seed: Buffer.alloc(32, 7).toString("base64url"),
							k: 2,
							g: 2,
						},
						errors: [],
						messages: [],
					}
				: {
						success: true,
						result: {
							account: {
								id: "fake0000-0000-4000-8000-cloudflareacct",
								name: "fake-temporary-account",
								type: "standard",
								apiToken: FAKE_TOKEN,
								tokenId: "FAKE-TOKEN-ID",
								expiresAt: new Date(CLAIM_BY).toISOString(),
							},
							claim: {
								token: "FAKE-CLAIM-TOKEN-0000000000",
								url: FAKE_CLAIM_URL,
								expiresAt: new Date(CLAIM_BY).toISOString(),
							},
						},
						errors: [],
						messages: [],
					};
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			};
		},
	};
}

const consent = {
	subjectRef: "hobo-owner-session-1",
	termsUrl: CLOUDFLARE_TERMS_URL,
	privacyUrl: CLOUDFLARE_PRIVACY_URL,
	acceptedAtMs: NOW.getTime() - 1000,
	acceptanceMethod: "cli-confirmation",
};

describe("a Cloudflare temporary account as the secret store", () => {
	it("creates nothing until the owner accepts Cloudflare's terms", async () => {
		const transport = stubCloudflare();
		await expect(
			provisionCloudflareTemporaryStore({
				transport,
				consent: undefined,
				deploymentRef: "ci-vercel",
				store: createOneTimeActionStore(passthrough),
				scope: claimScopeFor("ci-vercel", {}),
				now: NOW,
			}),
		).rejects.toMatchObject({ code: "SECRET_STORE_CONSENT_REQUIRED" });
		expect(transport.requests).toHaveLength(0);
	});

	it("seals Cloudflare's claim URL into the HoBo claim, with Cloudflare's deadline", async () => {
		const transport = stubCloudflare();
		const store = createOneTimeActionStore(passthrough);
		const scope = claimScopeFor("ci-vercel", {});
		const { receipt, bundle } = await provisionCloudflareTemporaryStore({
			transport,
			consent,
			deploymentRef: "ci-vercel",
			store,
			scope,
			now: NOW,
		});
		expect(transport.requests.map((r) => r.url)).toEqual([
			"https://api.cloudflare.com/client/v4/provisioning/previews/challenge",
			"https://api.cloudflare.com/client/v4/provisioning/previews",
		]);
		const created = JSON.parse(transport.requests[1]?.body ?? "{}");
		expect(created).toMatchObject({
			termsOfService: CLOUDFLARE_TERMS_URL,
			privacyPolicy: CLOUDFLARE_PRIVACY_URL,
			acceptTermsOfService: "yes",
		});
		expect(receipt.claimDeadlineMs).toBe(CLAIM_BY);
		const [item] = bundle.items;
		expect(item).toMatchObject({
			providerId: CLOUDFLARE_PROVIDER_ID,
			mode: "account-claim",
			deadline: CLAIM_BY,
			creatorAuthorityAfterClaim: "reauthorization-required",
		});
		expect(bundle.earliestDeadline).toBe(CLAIM_BY);

		const visible = JSON.stringify({ receipt, bundle });
		expect(visible).not.toContain("FAKE-CLAIM-TOKEN");
		expect(visible).not.toContain(FAKE_TOKEN);

		const opened = await store.redeem({
			id: item?.oneTimeActionRef ?? "",
			...scope,
			audience: CLOUDFLARE_PROVIDER_ID,
			now: NOW.getTime() + 1000,
		});
		expect(opened.value).toBe(FAKE_CLAIM_URL);
		// After Cloudflare's deadline the claim cannot be opened.
		const late = createOneTimeActionStore(passthrough);
		const again = await provisionCloudflareTemporaryStore({
			transport: stubCloudflare(),
			consent,
			deploymentRef: "ci-vercel",
			store: late,
			scope,
			now: NOW,
		});
		await expect(
			late.redeem({
				id: again.bundle.items[0]?.oneTimeActionRef ?? "",
				...scope,
				audience: CLOUDFLARE_PROVIDER_ID,
				now: CLAIM_BY + 1,
			}),
		).rejects.toMatchObject({ code: "ONE_TIME_ACTION_EXPIRED" });
	});

	it("reports a refused account by Cloudflare's code, not its body", async () => {
		const transport: TemporaryAccountTransportPort = {
			async send() {
				return {
					status: 429,
					headers: {},
					body: JSON.stringify({ errors: [{ message: FAKE_TOKEN }] }),
				};
			},
		};
		const error = await provisionCloudflareTemporaryStore({
			transport,
			consent,
			deploymentRef: "ci-vercel",
			store: createOneTimeActionStore(passthrough),
			scope: claimScopeFor("ci-vercel", {}),
			now: NOW,
		}).catch((caught: Error) => caught);
		expect(error).toMatchObject({ code: "SECRET_STORE_PROVIDER_FAILED" });
		expect(String(error)).not.toContain(FAKE_TOKEN);
	});
});
