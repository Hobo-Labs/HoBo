/**
 * The Netlify API client's status mapping and the deploy idempotency store.
 *
 * The store exists because `netlify deploy` is **not** an idempotent API call.
 * A retry after an ambiguous failure creates a *second site* rather than
 * converging on the first — so the operator ends up paying for an orphan
 * nobody knows about, and the retry looks like it worked. The key is therefore
 * recorded *before* the CLI runs, and a repeat of the same key refuses to
 * deploy again and hands back whatever was observed the first time. That is
 * either a site to adopt or nothing, and both beat a silent orphan.
 *
 * `probeSiteAccess` is the other half of the same story: after an ambiguous
 * deploy, the caller has to ask whether the site exists and whether this token
 * can see it. Its three answers are deliberately distinct — a `forbidden` read
 * as `absent` would tell a recovery path to create a replacement for a site
 * that is already there.
 */
import { describe, expect, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createNetlifyClient,
} from "../src/client.js";
import { NetlifyProviderError } from "../src/provider-errors.js";

const SITE_ID = "abc123def456";

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

/** A client whose transport answers every request with one canned response. */
function clientAnswering(status: number, body = "{}") {
	return createNetlifyClient({
		transport: { request: async () => ({ status, headers: {}, body }) },
		resolver: { resolve: async () => ({ expose: () => "token" }) as never },
	} as never);
}

/** Every call carries its own token ref; the client holds none. */
const REF = "hobo-secret://vault/netlify/token" as never;

const SITE_BODY = JSON.stringify({
	id: SITE_ID,
	name: "my-site",
	account_id: "acct-1",
	url: "https://my-site.netlify.app",
});

describe("readSite", () => {
	it("parses a 200 response into a site record", async () => {
		const site = await clientAnswering(200, SITE_BODY).readSite({
			siteId: SITE_ID,
			tokenRef: REF,
		} as never);
		expect(site.id).toBe(SITE_ID);
		expect(site.name).toBe("my-site");
	});

	it("throws a typed provider error for a non-200 status", async () => {
		// Not a bare Error: the caller dispatches on the code to decide whether
		// to retry, re-authenticate, or stop.
		for (const status of [400, 401, 403, 404, 500, 503]) {
			await expect(
				clientAnswering(status, "{}").readSite({
					siteId: SITE_ID,
					tokenRef: REF,
				} as never),
			).rejects.toBeInstanceOf(NetlifyProviderError);
		}
	});

	it("distinguishes an auth failure from a server failure", async () => {
		// The two demand opposite responses — re-authenticate versus back off and
		// retry — so collapsing them into one code would make every recovery
		// path guess.
		const unauthorized = await clientAnswering(401)
			.readSite({ siteId: SITE_ID, tokenRef: REF } as never)
			.catch((error) => error);
		const serverError = await clientAnswering(503)
			.readSite({ siteId: SITE_ID, tokenRef: REF } as never)
			.catch((error) => error);
		expect(codeOf(unauthorized)).not.toBe(codeOf(serverError));
	});

	it("refuses a malformed site id before making a request", async () => {
		// `assertSiteId` runs while building the URL. An unvalidated id would be
		// interpolated into the path, so a value containing `/` or `..` would
		// address a different API resource entirely.
		let requested = false;
		const client = createNetlifyClient({
			transport: {
				request: async () => {
					requested = true;
					return { status: 200, headers: {}, body: SITE_BODY };
				},
			},
			resolver: { resolve: async () => ({ expose: () => "token" }) as never },
		} as never);
		for (const siteId of ["", "../other", "a/b", "has space"]) {
			await expect(
				client.readSite({ siteId, tokenRef: REF } as never),
			).rejects.toBeInstanceOf(NetlifyProviderError);
		}
		expect(requested).toBe(false);
	});

	it("refuses a response body that is not a site", async () => {
		// The API is outside this package's control, so its shape is parsed
		// rather than trusted. A contract change that dropped `id` would
		// otherwise produce a site record nothing downstream can address.
		for (const body of ["not json", "[]", "7", "{}", '{"id":7}']) {
			await expect(
				clientAnswering(200, body).readSite({
					siteId: SITE_ID,
					tokenRef: REF,
				} as never),
			).rejects.toBeInstanceOf(NetlifyProviderError);
		}
	});

	it("refuses a site that names no owning account", async () => {
		// The load-bearing half of the parse. Without an owning account there is
		// no ownership fact to compare against, and a post-claim verification
		// that cannot compare must not pass — otherwise "the site is yours"
		// would be asserted on the strength of the site merely existing.
		try {
			await clientAnswering(200, JSON.stringify({ id: SITE_ID })).readSite({
				siteId: SITE_ID,
				tokenRef: REF,
			} as never);
			expect.unreachable("a site with no owning account must be refused");
		} catch (error) {
			expect(codeOf(error)).toBe("PROVIDER_CONTRACT_CHANGED");
			expect(
				(error as { detail?: { haveId?: boolean; haveAccount?: boolean } })
					.detail,
			).toEqual({ haveId: true, haveAccount: false });
		}
	});

	it("accepts account_slug as the owning account when account_id is absent", async () => {
		// Two spellings because the API uses both. Supporting one would make an
		// otherwise-verifiable site look unverifiable.
		const site = await clientAnswering(
			200,
			JSON.stringify({ id: SITE_ID, account_slug: "my-team" }),
		).readSite({ siteId: SITE_ID, tokenRef: REF } as never);
		expect(site.accountId).toBe("my-team");
		expect(site.accountSlug).toBe("my-team");
	});

	it("prefers account_id over account_slug when both are present", async () => {
		// The id is stable; the slug is renameable. Comparing ownership on a
		// renameable handle would make a legitimate rename look like a takeover.
		const site = await clientAnswering(
			200,
			JSON.stringify({ id: SITE_ID, account_id: "acct-1", account_slug: "s" }),
		).readSite({ siteId: SITE_ID, tokenRef: REF } as never);
		expect(site.accountId).toBe("acct-1");
		expect(site.accountSlug).toBe("s");
	});

	it("falls back to the id when the site has no name", async () => {
		// A name is a label; the id is the address. Reporting an empty name would
		// render as a blank row in every listing.
		const site = await clientAnswering(
			200,
			JSON.stringify({ id: SITE_ID, account_id: "acct-1" }),
		).readSite({ siteId: SITE_ID, tokenRef: REF } as never);
		expect(site.name).toBe(SITE_ID);
	});

	it("prefers the ssl_url over the plain url", async () => {
		// The https URL is the one a user should be handed. Preferring the plain
		// one would send them to a redirect at best.
		const site = await clientAnswering(
			200,
			JSON.stringify({
				id: SITE_ID,
				account_id: "acct-1",
				url: "http://site.netlify.app",
				ssl_url: "https://site.netlify.app",
			}),
		).readSite({ siteId: SITE_ID, tokenRef: REF } as never);
		expect(site.url).toBe("https://site.netlify.app");
	});

	it("omits the url entirely when the site reports neither", async () => {
		// Absent, not an empty string — a caller has to be able to tell "no URL
		// yet" (a site mid-provision) from "the URL is blank".
		const site = await clientAnswering(
			200,
			JSON.stringify({ id: SITE_ID, account_id: "acct-1" }),
		).readSite({ siteId: SITE_ID, tokenRef: REF } as never);
		expect(Object.hasOwn(site, "url")).toBe(false);
	});

	it("distinguishes a non-json body from a non-object one", async () => {
		// Different messages for different contract breaks, so an operator knows
		// whether the API returned HTML (a proxy interstitial) or a JSON array.
		const notJson = await clientAnswering(200, "<html>")
			.readSite({ siteId: SITE_ID, tokenRef: REF } as never)
			.catch((error: Error) => error.message);
		const notObject = await clientAnswering(200, "[]")
			.readSite({ siteId: SITE_ID, tokenRef: REF } as never)
			.catch((error: Error) => error.message);
		expect(notJson).toContain("not json");
		expect(notObject).toContain("not an object");
	});
});

describe("probeSiteAccess", () => {
	it("reports readable with the site on 200", async () => {
		const result = await clientAnswering(200, SITE_BODY).probeSiteAccess({
			siteId: SITE_ID,
			tokenRef: REF,
		} as never);
		expect(result.kind).toBe("readable");
		if (result.kind !== "readable") throw new Error("unreachable");
		expect(result.site.id).toBe(SITE_ID);
	});

	it("reports forbidden for 401 and 403", async () => {
		// "The site may well exist; this token cannot see it." A recovery path
		// that read this as `absent` would create a replacement for a site that
		// is already there — the exact double-creation the store above prevents.
		for (const status of [401, 403]) {
			expect(
				(
					await clientAnswering(status).probeSiteAccess({
						siteId: SITE_ID,
						tokenRef: REF,
					} as never)
				).kind,
			).toBe("forbidden");
		}
	});

	it("reports absent for 404 and 410", async () => {
		// 410 as well as 404: a site deleted after an ambiguous deploy answers
		// Gone, and treating that as an error would strand the recovery.
		for (const status of [404, 410]) {
			expect(
				(
					await clientAnswering(status).probeSiteAccess({
						siteId: SITE_ID,
						tokenRef: REF,
					} as never)
				).kind,
			).toBe("absent");
		}
	});

	it("throws for a status it cannot interpret", async () => {
		// A 500 is not an answer about the site's existence, and returning any
		// of the three verdicts for it would be a guess presented as a fact.
		for (const status of [500, 502, 429, 418]) {
			await expect(
				clientAnswering(status).probeSiteAccess({
					siteId: SITE_ID,
					tokenRef: REF,
				} as never),
			).rejects.toBeInstanceOf(NetlifyProviderError);
		}
	});
});

describe("createInMemoryIdempotencyStore", () => {
	it("reports a first attempt as fresh", async () => {
		const store = createInMemoryIdempotencyStore();
		expect(await store.begin("deploy-1")).toEqual({
			key: "deploy-1",
			state: "fresh",
		});
	});

	it("reports a repeat of the same key as replayed", async () => {
		// The guarantee. `netlify deploy` creates a second site on retry, so a
		// repeated key must not reach the CLI again — the caller sees `replayed`
		// and stops rather than orphaning a site nobody is tracking.
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		expect((await store.begin("deploy-1")).state).toBe("replayed");
	});

	it("records the key before the deploy runs, so an ambiguous failure still replays", async () => {
		// `begin` writes immediately rather than on success. That is the whole
		// design: the dangerous case is a deploy that *may* have created a site
		// and then failed to report it, and a store that only recorded on
		// completion would let exactly that case retry.
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		// No `complete` — the deploy died mid-flight.
		const second = await store.begin("deploy-1");
		expect(second.state).toBe("replayed");
		expect(second.siteId).toBeUndefined();
	});

	it("hands back the observed site id once the deploy completed", async () => {
		// The good outcome of a replay: there *is* a site, and the caller can
		// adopt it instead of creating another.
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		await store.complete("deploy-1", SITE_ID);
		const replayed = await store.begin("deploy-1");
		expect(replayed.state).toBe("replayed");
		expect(replayed.siteId).toBe(SITE_ID);
	});

	it("omits siteId rather than reporting it undefined", async () => {
		// Conditional spread. A present-but-undefined `siteId` would read to a
		// caller as "there is a site and I could not name it", which is the
		// opposite of what an incomplete record means.
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		expect(Object.hasOwn(await store.begin("deploy-1"), "siteId")).toBe(false);
	});

	it("keeps keys independent", async () => {
		// Two concurrent deploys must not block each other, and one completing
		// must not make the other look replayed.
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		await store.complete("deploy-1", SITE_ID);
		expect((await store.begin("deploy-2")).state).toBe("fresh");
	});

	it("returns undefined from get for a key it has never seen", async () => {
		// Distinct from a recorded-but-incomplete attempt, which returns a record
		// with no siteId. A caller has to be able to tell "never started" from
		// "started and we do not know how it ended".
		expect(await createInMemoryIdempotencyStore().get("nope")).toBeUndefined();
	});

	it("reports a known key from get as replayed", async () => {
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		expect(await store.get("deploy-1")).toEqual({
			key: "deploy-1",
			state: "replayed",
		});
	});

	it("carries the site id through get once completed", async () => {
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		await store.complete("deploy-1", SITE_ID);
		expect(await store.get("deploy-1")).toEqual({
			key: "deploy-1",
			siteId: SITE_ID,
			state: "replayed",
		});
	});

	it("lets a later complete overwrite an earlier one", async () => {
		// Pinned rather than guarded. `complete` is a plain write, so a second
		// call for the same key replaces the recorded site id. That is benign
		// for the intended single-deploy flow, but it means the store offers no
		// protection against a caller that completes the same key twice with
		// different sites — the first site would become unreferenced. Recorded
		// so a store implementation with real durability knows whether to keep
		// this behaviour.
		const store = createInMemoryIdempotencyStore();
		await store.begin("deploy-1");
		await store.complete("deploy-1", "first");
		await store.complete("deploy-1", "second");
		expect((await store.get("deploy-1"))?.siteId).toBe("second");
	});

	it("accepts complete for a key that was never begun", async () => {
		// Also pinned: `complete` does not require a prior `begin`. Harmless for
		// the intended flow and worth knowing before a durable implementation
		// decides to enforce the ordering.
		const store = createInMemoryIdempotencyStore();
		await store.complete("never-begun", SITE_ID);
		expect((await store.get("never-begun"))?.siteId).toBe(SITE_ID);
	});

	it("gives each store its own records", async () => {
		const first = createInMemoryIdempotencyStore();
		await first.begin("deploy-1");
		expect(
			(await createInMemoryIdempotencyStore().begin("deploy-1")).state,
		).toBe("fresh");
	});
});
