import { describe, expect, it } from "vitest";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createTrustedPublisherVerifier, INGEST_METRIC, INGEST_REASON } from "../../src/ingest/index.js";
import { AGENT, clock, context, FakeAuthorizer, MemoryEventStore, RecordingTelemetry, TENANT } from "../freight/fakes.js";
import {
	AUDIENCE,
	GITHUB_ISSUER,
	GITLAB_ISSUER,
	githubClaims,
	githubPublisher,
	gitlabClaims,
	gitlabPublisher,
	OidcTransport,
	rsaKey,
	signJwt,
} from "./oidc.js";

const githubKey = rsaKey("gh-1");
const gitlabKey = rsaKey("gl-1");
const strangerKey = rsaKey("gh-1");

async function harness(options: { cacheControl?: string } = {}) {
	const store = new MemoryEventStore();
	const time = clock();
	const oidc = new OidcTransport();
	oidc.issuer(GITHUB_ISSUER, [githubKey], "/.well-known/jwks", options.cacheControl);
	oidc.issuer(GITLAB_ISSUER, [gitlabKey], "/oauth/discovery/keys", options.cacheControl);
	const authorizer = new FakeAuthorizer();
	const telemetry = new RecordingTelemetry();
	const publishers = createTrustedPublisherVerifier({
		store,
		tenant: TENANT,
		now: time.now,
		http: oidc.transport,
		authorizer,
		telemetry,
	});
	const ctx = context(time.now);
	for (const record of [githubPublisher(), gitlabPublisher()]) {
		const trusted = await publishers.trust(record, ctx);
		if (!trusted.ok) throw new Error(JSON.stringify(trusted.reasons));
	}
	return { store, time, oidc, publishers, authorizer, telemetry, ctx };
}

function code(outcome: { ok: boolean; reasons?: readonly { code: string }[] }): string | undefined {
	return outcome.ok ? undefined : outcome.reasons?.[0]?.code;
}

describe("createTrustedPublisherVerifier: OIDC trusted publishing (D3)", () => {
	it("GitHub and GitLab OIDC fixtures pass and map to workload principals", async () => {
		const { publishers, ctx, telemetry } = await harness();
		const github = await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx);
		expect(github.ok).toBe(true);
		if (!github.ok) return;
		expect(github.value.publisher).toBe("github-shop");
		expect(github.value.principal).toEqual({ kind: "service", id: "workload:github-shop:repo:acme/shop:environment:release" });
		expect(github.value.claims.repository).toBe("acme/shop");

		const gitlab = await publishers.verify(signJwt(gitlabKey, gitlabClaims(ctx.now())), ctx);
		expect(gitlab.ok && gitlab.value.publisher).toBe("gitlab-shop");
		expect(gitlab.ok && gitlab.value.principal.id).toBe("workload:gitlab-shop:project_path:acme/shop:ref_type:branch:ref:main");
		expect(telemetry.count(INGEST_METRIC.publisherVerified)).toBe(2);
	});

	it("OIDC token from an unconfigured issuer is refused (§10)", async () => {
		const { publishers, ctx, oidc } = await harness();
		const token = signJwt(githubKey, githubClaims(ctx.now(), { iss: "https://token.evil.example" }));
		expect(code(await publishers.verify(token, ctx))).toBe(INGEST_REASON.publisherIssuer);
		expect(oidc.calls.filter((url) => url.includes("evil"))).toEqual([]);
	});

	it("a wrong audience is refused", async () => {
		const { publishers, ctx } = await harness();
		const token = signJwt(githubKey, githubClaims(ctx.now(), { aud: "https://other.example" }));
		expect(code(await publishers.verify(token, ctx))).toBe(INGEST_REASON.publisherAudience);
	});

	it("a missing or different required claim is refused", async () => {
		const { publishers, ctx } = await harness();
		const missing = githubClaims(ctx.now());
		delete missing.environment;
		const outcome = await publishers.verify(signJwt(githubKey, missing), ctx);
		expect(code(outcome)).toBe(INGEST_REASON.publisherClaims);
		expect(!outcome.ok && outcome.reasons[0]?.message).toContain("environment");
		const fork = signJwt(githubKey, githubClaims(ctx.now(), { repository: "mallory/shop" }));
		expect(code(await publishers.verify(fork, ctx))).toBe(INGEST_REASON.publisherClaims);
		const numeric = signJwt(gitlabKey, gitlabClaims(ctx.now(), { ref_protected: true }));
		expect(code(await publishers.verify(numeric, ctx))).toBe(INGEST_REASON.publisherClaims);
	});

	it("refuses a forged signature, alg none and malformed tokens", async () => {
		const { publishers, ctx } = await harness();
		expect(code(await publishers.verify(signJwt(strangerKey, githubClaims(ctx.now())), ctx))).toBe(INGEST_REASON.publisherToken);
		const [head, body] = signJwt(githubKey, githubClaims(ctx.now()), { alg: "none" }).split(".");
		expect(code(await publishers.verify(`${head}.${body}.`, ctx))).toBe(INGEST_REASON.publisherToken);
		expect(code(await publishers.verify("not-a-jwt", ctx))).toBe(INGEST_REASON.publisherToken);
		expect(code(await publishers.verify("x".repeat(20_000), ctx))).toBe(INGEST_REASON.publisherToken);
	});

	it("checks exp and nbf with the injected clock skew", async () => {
		const { publishers, ctx } = await harness();
		const now = Math.floor(ctx.now() / 1000);
		const justExpired = signJwt(githubKey, githubClaims(ctx.now(), { nbf: now - 90, exp: now - 30 }));
		expect((await publishers.verify(justExpired, ctx)).ok).toBe(true);
		const expired = signJwt(githubKey, githubClaims(ctx.now(), { nbf: now - 200, exp: now - 120 }));
		expect(code(await publishers.verify(expired, ctx))).toBe(INGEST_REASON.publisherExpired);
		const early = signJwt(githubKey, githubClaims(ctx.now(), { nbf: now + 30 }));
		expect((await publishers.verify(early, ctx)).ok).toBe(true);
		const future = signJwt(githubKey, githubClaims(ctx.now(), { nbf: now + 600, exp: now + 900 }));
		expect(code(await publishers.verify(future, ctx))).toBe(INGEST_REASON.publisherExpired);
		const noNbf = githubClaims(ctx.now());
		delete noNbf.nbf;
		expect(code(await publishers.verify(signJwt(githubKey, noNbf), ctx))).toBe(INGEST_REASON.publisherToken);
	});

	it("caches discovery and JWKS per Cache-Control max-age and refetches on rotation", async () => {
		const { publishers, ctx, oidc, time } = await harness({ cacheControl: "public, max-age=60" });
		const jwks = `${GITHUB_ISSUER}/.well-known/jwks`;
		await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx);
		await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx);
		expect(oidc.count(jwks)).toBe(1);
		time.advance(61_000);
		await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx);
		expect(oidc.count(jwks)).toBe(2);
		const rotated = rsaKey("gh-2");
		oidc.setJwks(jwks, [githubKey, rotated], "max-age=60");
		const outcome = await publishers.verify(signJwt(rotated, githubClaims(ctx.now())), ctx);
		expect(outcome.ok).toBe(true);
		expect(oidc.count(jwks)).toBe(3);
	});

	it("does not cache a JWKS served with no-store", async () => {
		const { publishers, ctx, oidc } = await harness({ cacheControl: "no-store" });
		await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx);
		await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx);
		expect(oidc.count(`${GITHUB_ISSUER}/.well-known/jwks`)).toBe(2);
	});

	it("fails closed when discovery is unreachable or names another issuer", async () => {
		const { publishers, ctx, oidc } = await harness();
		oidc.routes.delete(`${GITLAB_ISSUER}/.well-known/openid-configuration`);
		expect(code(await publishers.verify(signJwt(gitlabKey, gitlabClaims(ctx.now())), ctx))).toBe(INGEST_REASON.publisherDiscovery);
		oidc.routes.set(`${GITLAB_ISSUER}/.well-known/openid-configuration`, {
			status: 200,
			headers: {},
			body: JSON.stringify({ issuer: "https://gitlab.evil.example", jwks_uri: `${GITLAB_ISSUER}/oauth/discovery/keys` }),
		});
		expect(code(await publishers.verify(signJwt(gitlabKey, gitlabClaims(ctx.now())), ctx))).toBe(INGEST_REASON.publisherDiscovery);
	});
});

describe("trusting a publisher is governed and parsed", () => {
	it("appends publisher.Trusted once and authorizes publisher.trust", async () => {
		const { store, publishers, ctx, authorizer } = await harness();
		expect((await publishers.trust(githubPublisher(), ctx)).ok).toBe(true);
		expect(store.events(CD_STREAMS.publisher("github-shop")).map((event) => event.type)).toEqual([CD_EVENTS.PublisherTrusted]);
		expect(authorizer.calls.map((call) => call.action)).toEqual(["publisher.trust", "publisher.trust"]);
	});

	it.each([
		["a non-https issuer", { issuer: "http://token.actions.githubusercontent.com" }],
		["an empty audience", { audience: "" }],
		["no required claims", { requiredClaims: {} }],
		["no bindles", { bindles: [] }],
		["a bad name", { name: "GitHub Shop" }],
	])("refuses %s", async (_name, overrides) => {
		const { publishers, ctx } = await harness();
		expect(code(await publishers.trust(githubPublisher(overrides), ctx))).toBe(INGEST_REASON.publisherRecordInvalid);
	});

	it("an agent can only propose trust, and no authorizer fails closed", async () => {
		const { publishers, time } = await harness();
		expect(code(await publishers.trust(githubPublisher({ name: "agent-pub" }), context(time.now, AGENT)))).toBe(INGEST_REASON.proposalOnly);
		const ungoverned = createTrustedPublisherVerifier({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: time.now,
			http: new OidcTransport().transport,
		});
		expect(code(await ungoverned.trust(githubPublisher(), context(time.now)))).toBe(INGEST_REASON.ungoverned);
	});

	it("a later trust record for the same name replaces the earlier one", async () => {
		const { publishers, ctx } = await harness();
		const narrowed = githubPublisher({ requiredClaims: { repository: "acme/shop", environment: "prod" } });
		expect((await publishers.trust(narrowed, ctx)).ok).toBe(true);
		expect(code(await publishers.verify(signJwt(githubKey, githubClaims(ctx.now())), ctx))).toBe(INGEST_REASON.publisherClaims);
	});
});
