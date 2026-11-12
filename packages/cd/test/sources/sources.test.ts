// FreightSources end to end over recorded fixtures: every Accept bullet of
// WP2 (plan 0024 §9) and the §10 rows WP2 owns are named tests here.
import { createHmac } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { HttpTransport, JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	AssemblyRule,
	FreightSourceRecordSchema,
	FreightSubject,
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS, SOURCE_SCHEMA } from "../../src/events.js";
import type { CiEventReader, FeedRequest, SubscriptionDriver } from "../../src/ports.js";
import {
	createFreightSources,
	createSubscriptionDrivers,
	discoveryOutcome,
	SOURCE_METRIC,
	webhookSecretRef,
} from "../../src/sources/index.js";
import { encode } from "../../src/sources/json.js";
import { gitExchanges, gitFixture } from "./git-fixtures.js";
import { COMMIT_B, DIGESTS, OCI_FIXTURES } from "./oci-fixtures.js";
import { PACKAGE_FIXTURES } from "./package-fixtures.js";
import {
	asLedger,
	clock,
	context,
	digestOf,
	type Exchange,
	FakeAuthorizer,
	FakeLedger,
	FakeProvenance,
	FixtureTransport,
	json,
	MemoryEventStore,
	railReader,
	RecordingTelemetry,
	type SourceInit,
	StaticCredentials,
	type SubscriptionInit,
	TENANT,
} from "./support.js";

const WEBHOOK_SECRET = "hook-secret";
const secrets = new StaticCredentials({
	[webhookSecretRef("github")]: { secret: WEBHOOK_SECRET },
	[webhookSecretRef("harbor")]: { token: "harbor-token" },
	[webhookSecretRef("gitlab")]: { token: "gl-token" },
	[webhookSecretRef("dockerhub")]: { token: "dh-token" },
	[webhookSecretRef("cloudevents")]: { token: "ce-token" },
});

type Harness = ReturnType<typeof harness>;

function harness(
	exchanges: readonly Exchange[] = [],
	options: Readonly<{ readCiEvents?: CiEventReader; readRailEvents?: Parameters<typeof railReader>[0]; drivers?: readonly SubscriptionDriver[] }> = {},
) {
	const time = clock();
	const store = new MemoryEventStore();
	const ledger = new FakeLedger();
	const provenance = new FakeProvenance();
	const authorizer = new FakeAuthorizer();
	const telemetry = new RecordingTelemetry();
	let fixture = new FixtureTransport(exchanges);
	const http: HttpTransport = (request) => fixture.http(request);
	const drivers =
		options.drivers ??
		createSubscriptionDrivers({
			http,
			credentials: new StaticCredentials({}),
			...(options.readCiEvents ? { readCiEvents: options.readCiEvents, readCiArtifact: async () => encode("wasm") } : {}),
			...(options.readRailEvents ? { readRailEvents: railReader(options.readRailEvents) } : {}),
		});
	const sources = createFreightSources({
		store,
		tenant: TENANT,
		now: time.now,
		ledger: asLedger(ledger),
		drivers,
		provenance,
		authorizer,
		webhookSecrets: secrets,
		telemetry,
	});
	return {
		time,
		store,
		ledger,
		provenance,
		authorizer,
		telemetry,
		sources,
		ctx: context(time.now),
		get fixture() {
			return fixture;
		},
		/** Swap the recorded upstream (the registry/Git host moves on). */
		upstream(next: readonly Exchange[]) {
			fixture = new FixtureTransport(next);
		},
	};
}

function sub(init: SubscriptionInit) {
	return create(SubscriptionRecordSchema, init);
}

function source(name: string, bindle: string, subscriptions: ReturnType<typeof sub>[], extra: SourceInit = {}) {
	return create(FreightSourceRecordSchema, { name, bindle, subscriptions, automatic: true, ...extra });
}

const image = sub({ name: "image", kind: SubscriptionKind.OCI_REPOSITORY, locator: "registry.example.com/team/app" });

async function defineOk(h: Harness, record: ReturnType<typeof source>) {
	const outcome = await h.sources.define(record, h.ctx);
	if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
	return outcome.value;
}

async function pollOk(h: Harness, name: string) {
	const outcome = await h.sources.poll(name, h.ctx);
	if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
	return outcome.value;
}

function discoveries(h: Harness, name: string) {
	return h.store
		.events(CD_STREAMS.source(name))
		.filter((event) => event.type === CD_EVENTS.SourceArtifactDiscovered)
		.map((event) => ({ data: event.data as JsonObject, ...discoveryOutcome(event) }));
}

function githubPush(repository: string, secret = WEBHOOK_SECRET): FeedRequest {
	const body = encode(json({ ref: "refs/tags/v1.2.0", repository: { clone_url: repository } }));
	return {
		method: "POST",
		path: "/v1/cd/sources/nudge/github",
		headers: {
			"X-GitHub-Event": "push",
			"X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		},
		body,
	};
}

function harborPush(token: string): FeedRequest {
	return {
		method: "POST",
		path: "/v1/cd/sources/nudge/harbor",
		headers: { Authorization: token },
		body: encode(json({ type: "PUSH_ARTIFACT", event_data: { resources: [{ resource_url: "registry.example.com/team/app:1.2.0" }] } })),
	};
}

describe("define", () => {
	it("normalizes defaults (SemVer, INDEPENDENT, frozen poll interval and limit) and records source.Defined once", async () => {
		const h = harness();
		const defined = await defineOk(h, source("app", "web", [image]));
		expect(defined.schemaVersion).toBe(SOURCE_SCHEMA);
		expect(defined.assembly).toBe(AssemblyRule.INDEPENDENT);
		expect(defined.pollIntervalMs).toBe(BigInt(CD_DEFAULTS.sourcePollIntervalMs));
		expect(defined.subscriptions[0]?.selection).toBe(SelectionStrategy.SEMVER);
		expect(defined.subscriptions[0]?.discoveryLimit).toBe(CD_DEFAULTS.sourceDiscoveryLimit);
		await defineOk(h, source("app", "web", [image]));
		expect(h.store.events(CD_STREAMS.source("app")).length).toBe(1);
		expect((await h.sources.list()).map((item) => item.name)).toEqual(["app"]);
		expect(h.authorizer.calls).toContain("source.define");
	});

	it("refuses invalid sources with typed reasons and remediation", async () => {
		const h = harness();
		const outcome = await h.sources.define(
			source("App!", "web", [
				sub({ name: "a", kind: SubscriptionKind.GIT_REPOSITORY, locator: "https://user:pw@git.example.com/x.git", requireProvenance: true }),
				sub({ name: "a", kind: SubscriptionKind.HTTP_INDEX, locator: "https://x.example.com/i.json", allowPattern: "(" }),
			], { pollIntervalMs: 1_000n }),
			h.ctx,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		const codes = new Set(outcome.reasons.map((item) => item.code));
		expect(codes).toEqual(new Set(["source-invalid", "source-provenance-unsupported"]));
		expect(outcome.reasons.every((item) => item.remediation !== "")).toBe(true);
		const subjects = outcome.reasons.map((item) => item.subject);
		for (const subject of ["name", "pollIntervalMs", "subscriptions", "subscriptions[1].allowPattern", "subscriptions[0].requireProvenance"]) {
			expect(subjects).toContain(subject);
		}
	});

	it("refuses an unauthorized definition", async () => {
		const h = harness();
		const denied = createFreightSources({
			store: h.store,
			tenant: TENANT,
			now: h.time.now,
			ledger: asLedger(h.ledger),
			drivers: createSubscriptionDrivers({ http: h.fixture.http, credentials: new StaticCredentials({}) }),
			provenance: h.provenance,
			authorizer: new FakeAuthorizer(new Set(["source.define"])),
			webhookSecrets: secrets,
		});
		const outcome = await denied.define(source("app", "web", [image]), h.ctx);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe("source-unauthorized");
	});
});

describe("discovery against recorded fixtures for every kind", () => {
	it("OCI: records one Freight per new tag with the image digest", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("app", "web", [image]));
		const freight = await pollOk(h, "app");
		expect(freight.map((item) => item.manifest?.artifacts[0]?.digest)).toEqual([DIGESTS["1.0.0"], DIGESTS["1.1.0"], DIGESTS["1.2.0"]]);
		expect(freight[0]?.manifest?.labels["hobo.cd/source"]).toBe("app");
		expect(h.telemetry.count(SOURCE_METRIC.freightRecorded)).toBe(3);
	});

	it("Git: records Freight whose declaration hash is the filtered tree digest", async () => {
		const h = harness(gitExchanges("t3"));
		const decl = sub({ name: "decl", kind: SubscriptionKind.GIT_REPOSITORY, locator: gitFixture.base, branch: "main", includePaths: ["deploy"] });
		await defineOk(h, source("decl", "web", [decl]));
		const [freight] = await pollOk(h, "decl");
		expect(freight?.manifest?.declarationHash).toBe(freight?.manifest?.artifacts[0]?.digest);
		expect(freight?.manifest?.source?.commit).toBe(gitFixture.commits.c3);
		expect(freight?.manifest?.source?.repository).toBe(gitFixture.base);
	});

	it("package registries: records Freight for npm, PyPI, crates, RubyGems, NuGet and Maven", async () => {
		const h = harness(PACKAGE_FIXTURES);
		const cases = [
			["npm", "@acme/web"],
			["pypi", "acme-web"],
			["cargo", "acme-web"],
			["rubygems", "acme-web"],
			["nuget", "Acme.Web"],
			["maven", "com.acme:web"],
		] as const;
		for (const [ecosystem, locator] of cases) {
			await defineOk(h, source(`pkg-${ecosystem}`, "web", [sub({ name: "pkg", kind: SubscriptionKind.PACKAGE_REGISTRY, ecosystem, locator })]));
			const freight = await pollOk(h, `pkg-${ecosystem}`);
			expect(freight.length, ecosystem).toBeGreaterThan(0);
			expect(freight[0]?.manifest?.artifacts[0]?.ecosystem).toBe(ecosystem);
		}
	});

	it("HTTP index: records Freight from the index", async () => {
		const index = "https://downloads.example.com/web/index.json";
		const h = harness([{ url: index, response: json([{ version: "1.0.0", url: "https://downloads.example.com/web/1.tgz", digest: digestOf("one") }]) }]);
		await defineOk(h, source("assets", "web", [sub({ name: "assets", kind: SubscriptionKind.HTTP_INDEX, locator: index, artifactKind: ArtifactKind.STATIC_ASSETS })]));
		const freight = await pollOk(h, "assets");
		expect(freight.map((item) => item.manifest?.artifacts[0]?.digest)).toEqual([digestOf("one")]);
	});

	it("HOBO_CI: records Freight with origin HOBO_CI and the CI run id", async () => {
		const wasm = encode("wasm");
		const lease = { pipelineId: "web-build", result: { id: "run-9", status: "passed", artifacts: [{ path: "dist/web.wasm", sha256: digestOf(wasm).slice(7) }] } };
		const reader: CiEventReader = async function* () {
			yield { cursor: "1", type: "ci.PipelineResultObserved", data: { detail: JSON.stringify(lease) } };
		};
		const h = harness([], { readCiEvents: reader });
		await defineOk(
			h,
			source("ci", "web", [sub({ name: "wasm", kind: SubscriptionKind.HOBO_CI, locator: "web-build", artifactName: "dist/web.wasm", artifactKind: ArtifactKind.WASM_COMPONENT })]),
		);
		const [freight] = await pollOk(h, "ci");
		expect(freight?.origin).toBe(5);
		expect(freight?.manifest?.source?.ciRunId).toBe("run-9");
	});
});

describe("forward-only discovery", () => {
	it("never discovers an older tag after a newer one", async () => {
		const h = harness(OCI_FIXTURES.filter((item) => !item.url.includes("last=1.1.0")).map((item) =>
			item.url.endsWith("tags/list?n=1000") && item.status === undefined
				? { ...item, responseHeaders: {}, response: json({ tags: ["1.2.0"] }) }
				: item,
		));
		await defineOk(h, source("app", "web", [image]));
		expect((await pollOk(h, "app")).length).toBe(1);
		// The registry now also lists older tags (e.g. a backfill push): none is discovered.
		h.upstream(OCI_FIXTURES);
		expect(await pollOk(h, "app")).toEqual([]);
		expect(discoveries(h, "app").map((item) => (item.data.version))).toEqual(["1.2.0"]);
	});

	it("a repeated poll records nothing twice (idempotent)", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("app", "web", [image]));
		await pollOk(h, "app");
		const before = h.ledger.calls.length;
		expect(await pollOk(h, "app")).toEqual([]);
		expect(h.ledger.calls.length).toBe(before);
	});
});

describe("assembly", () => {
	it("SAME_COMMIT pairs an image and a declaration from one commit", async () => {
		// Image 1.2.0 carries revision COMMIT_B; a declaration index lists the same commit.
		const index = "https://decl.example.com/web/index.json";
		const exchanges: Exchange[] = [
			...OCI_FIXTURES,
			{
				url: index,
				response: json([
					{ version: "d1", url: "https://decl.example.com/d1.tgz", digest: digestOf("decl-a"), commit: "a".repeat(40) },
					{ version: "d2", url: "https://decl.example.com/d2.tgz", digest: digestOf("decl-b"), commit: COMMIT_B },
				]),
			},
		];
		const h = harness(exchanges);
		const declaration = sub({ name: "decl", kind: SubscriptionKind.HTTP_INDEX, locator: index, artifactKind: ArtifactKind.SOURCE_TREE, selection: SelectionStrategy.LEXICAL });
		await defineOk(h, source("paired", "web", [image, declaration], { assembly: AssemblyRule.SAME_COMMIT }));
		const freight = await pollOk(h, "paired");
		const pairs = freight.map((item) => ({
			commit: item.manifest?.source?.commit,
			declaration: item.manifest?.declarationHash,
			digests: item.manifest?.artifacts.map((artifact) => artifact.digest).sort(),
		}));
		// 1.0.0 and 1.1.0 were both built from commit a…: each pairs with d1.
		expect(pairs).toEqual([
			{ commit: "a".repeat(40), declaration: digestOf("decl-a"), digests: [DIGESTS["1.0.0"], digestOf("decl-a")].sort() },
			{ commit: "a".repeat(40), declaration: digestOf("decl-a"), digests: [DIGESTS["1.1.0"], digestOf("decl-a")].sort() },
			{ commit: COMMIT_B, declaration: digestOf("decl-b"), digests: [DIGESTS["1.2.0"], digestOf("decl-b")].sort() },
		]);
	});

	it("INDEPENDENT waits until every subscription has an artifact", async () => {
		const index = "https://decl.example.com/empty.json";
		const h = harness([...OCI_FIXTURES, { url: index, response: "[]" }]);
		const declaration = sub({ name: "decl", kind: SubscriptionKind.HTTP_INDEX, locator: index, artifactKind: ArtifactKind.SOURCE_TREE });
		await defineOk(h, source("waits", "web", [image, declaration]));
		expect(await pollOk(h, "waits")).toEqual([]);
		const outcomes = discoveries(h, "waits");
		expect(outcomes.every((item) => item.outcome === "deferred")).toBe(true);
		expect(outcomes[0]?.reasons[0]?.message).toContain("waiting for decl");
	});
});

describe("require_provenance", () => {
	const signed = sub({
		name: "image",
		kind: SubscriptionKind.OCI_REPOSITORY,
		locator: "registry.example.com/team/app",
		requireProvenance: true,
		trustedBuilderIds: ["https://ci.example/builder"],
	});

	it("unsigned images are skipped with a reason; the signed one is recorded with verified provenance", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("signed", "web", [signed]));
		const freight = await pollOk(h, "signed");
		expect(freight.map((item) => item.manifest?.artifacts[0]?.digest)).toEqual([DIGESTS["1.2.0"]]);
		expect(freight[0]?.manifest?.provenance[0]?.verified).toBe(true);
		const skipped = discoveries(h, "signed").filter((item) => item.outcome === "skipped");
		expect(skipped.map((item) => [item.data.version, item.reasons[0]?.code])).toEqual([
			["1.0.0", "source-provenance-missing"],
			["1.1.0", "source-provenance-missing"],
		]);
		expect(h.provenance.calls[0]?.builders).toEqual(["https://ci.example/builder"]);
	});

	it("an attestation from an unpinned builder is rejected with the verifier's reasons", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("pinned", "web", [create(SubscriptionRecordSchema, { ...signed, trustedBuilderIds: ["https://other.example/builder"] })]));
		expect(await pollOk(h, "pinned")).toEqual([]);
		const rejected = discoveries(h, "pinned").find((item) => item.data.version === "1.2.0");
		expect(rejected?.reasons.map((item) => item.code)).toEqual(["source-provenance-rejected", "provenance-untrusted"]);
	});
});

describe("webhooks only nudge (I15)", () => {
	it("§10 forged registry webhook: refused, no poll scheduled", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("app", "web", [image]));
		const response = await h.sources.nudge(harborPush("wrong-token"), h.ctx);
		expect(response.status).toBe(401);
		await h.sources.tick(h.ctx); // first tick polls on interval; clear that effect
		const before = h.ledger.calls.length;
		h.time.advance(1_000);
		await h.sources.tick(h.ctx);
		expect(h.ledger.calls.length).toBe(before);
		const forgedGithub = await h.sources.nudge(githubPush("https://github.com/acme/web.git", "not-the-secret"), h.ctx);
		expect(forgedGithub.status).toBe(401);
		expect(h.telemetry.count(SOURCE_METRIC.nudges, { outcome: "401" })).toBe(2);
	});

	it("a valid webhook creates no Freight by itself; it schedules a poll", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("app", "web", [image], { automatic: false }));
		const response = await h.sources.nudge(harborPush("harbor-token"), h.ctx);
		expect(response.status).toBe(202);
		expect(JSON.parse(new TextDecoder().decode(response.body as Uint8Array))).toEqual({ receiver: "harbor", scheduled: ["app"] });
		expect(h.ledger.calls).toEqual([]);
		expect(h.fixture.requests).toEqual([]);
		await h.sources.tick(h.ctx);
		expect(h.ledger.calls.length).toBe(3);
	});

	it("§10 valid webhook for an unsigned image under require_provenance: poll runs, image skipped with reason", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("signed", "web", [sub({ name: "image", kind: SubscriptionKind.OCI_REPOSITORY, locator: "registry.example.com/team/app", requireProvenance: true, semverRange: "<1.2.0" })], { automatic: false }));
		expect((await h.sources.nudge(harborPush("harbor-token"), h.ctx)).status).toBe(202);
		await h.sources.tick(h.ctx);
		expect(h.fixture.requests.length).toBeGreaterThan(0);
		expect(h.ledger.calls).toEqual([]);
		const skipped = discoveries(h, "signed");
		expect(skipped.map((item) => [item.data.version, item.outcome, item.reasons[0]?.code])).toEqual([
			["1.0.0", "skipped", "source-provenance-missing"],
			["1.1.0", "skipped", "source-provenance-missing"],
		]);
	});

	it("maps GitHub, GitLab, Docker Hub and CDEvents payloads to the matching sources only", async () => {
		const h = harness();
		await defineOk(h, source("decl", "web", [sub({ name: "decl", kind: SubscriptionKind.GIT_REPOSITORY, locator: "https://github.com/acme/web.git", branch: "main" })], { automatic: false }));
		await defineOk(h, source("hub", "web", [sub({ name: "image", kind: SubscriptionKind.OCI_REPOSITORY, locator: "docker.io/acme/web" })], { automatic: false }));
		await defineOk(h, source("npm", "web", [sub({ name: "pkg", kind: SubscriptionKind.PACKAGE_REGISTRY, ecosystem: "npm", locator: "@acme/web" })], { automatic: false }));
		const scheduled = async (request: FeedRequest) =>
			JSON.parse(new TextDecoder().decode((await h.sources.nudge(request, h.ctx)).body as Uint8Array)).scheduled;
		expect(await scheduled(githubPush("https://github.com/Acme/Web"))).toEqual(["decl"]);
		expect(
			await scheduled({ method: "POST", path: "/nudge/gitlab", headers: { "X-Gitlab-Token": "gl-token" }, body: encode(json({ project: { git_http_url: "https://github.com/acme/web.git" } })) }),
		).toEqual(["decl"]);
		expect(
			await scheduled({ method: "POST", path: "/nudge/dockerhub?token=dh-token", headers: {}, body: encode(json({ repository: { repo_name: "acme/web" } })) }),
		).toEqual(["hub"]);
		expect(
			await scheduled({
				method: "POST",
				path: "/nudge/cloudevents",
				headers: { authorization: "Bearer ce-token" },
				body: encode(json({ specversion: "1.0", type: "dev.cdevents.artifact.published.0.2.0", data: { subject: { id: "pkg:npm/%40acme/web@1.0.0" } } })),
			}),
		).toEqual(["npm"]);
		expect(h.ledger.calls).toEqual([]);
	});

	it("unknown receivers and non-POST requests are refused", async () => {
		const h = harness();
		expect((await h.sources.nudge({ method: "POST", path: "/nudge/nope", headers: {}, body: new Uint8Array() }, h.ctx)).status).toBe(404);
		expect((await h.sources.nudge({ method: "GET", path: "/nudge/github", headers: {}, body: new Uint8Array() }, h.ctx)).status).toBe(405);
	});
});

describe("tick", () => {
	it("rate-limit responses back off (Retry-After is a floor) and recover", async () => {
		const limited: Exchange[] = [{ url: "https://registry.example.com/v2/team/app/tags/list?n=1000", status: 429, responseHeaders: { "Retry-After": "120" } }];
		const h = harness(limited);
		await defineOk(h, source("app", "web", [image]));
		await h.sources.tick(h.ctx);
		expect(h.fixture.requests.length).toBe(1);
		const backoff = h.telemetry.points.find((point) => point.name === SOURCE_METRIC.backoff);
		expect(backoff?.value).toBe(120_000);
		h.time.advance(60_000);
		await h.sources.tick(h.ctx);
		expect(h.fixture.requests.length).toBe(1);
		h.upstream(OCI_FIXTURES);
		h.time.advance(60_000);
		await h.sources.tick(h.ctx);
		expect(h.ledger.calls.length).toBe(3);
	});

	it("polls automatic sources on their interval only", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("app", "web", [image]));
		await h.sources.tick(h.ctx);
		const after = h.fixture.requests.length;
		h.time.advance(CD_DEFAULTS.sourcePollIntervalMs - 1);
		await h.sources.tick(h.ctx);
		expect(h.fixture.requests.length).toBe(after);
		h.time.advance(1);
		await h.sources.tick(h.ctx);
		expect(h.fixture.requests.length).toBeGreaterThan(after);
	});

	it("backoff is deterministic and grows exponentially to the cap", async () => {
		const { backoffDelayMs } = await import("../../src/sources/backoff.js");
		expect(backoffDelayMs("app", 3)).toBe(backoffDelayMs("app", 3));
		expect(backoffDelayMs("app", 1)).toBeLessThanOrEqual(CD_DEFAULTS.sourceBackoffBaseMs);
		expect(backoffDelayMs("app", 1)).toBeGreaterThanOrEqual(CD_DEFAULTS.sourceBackoffBaseMs / 2);
		expect(backoffDelayMs("app", 40)).toBeLessThanOrEqual(CD_DEFAULTS.sourceBackoffMaxMs);
		expect(backoffDelayMs("app", 40, 3_600_000)).toBe(3_600_000);
	});
});

describe("HOBO_RAIL (D24)", () => {
	const railSource = () =>
		source("rail-prod", "rail-prod", [sub({ name: "rail", kind: SubscriptionKind.HOBO_RAIL, locator: "rail-prod" })]);
	const D1 = digestOf("rail-v1");
	const D2 = digestOf("rail-v2");

	it("the same digest approved twice yields one Freight with subject RAIL", async () => {
		const events = [
			{ cursor: "1", railId: "rail-prod", railDigest: D1, status: "approved" as const, stationId: "st" },
			{ cursor: "2", railId: "rail-prod", railDigest: D1, status: "approved" as const, stationId: "st" },
		];
		const h = harness([], { readRailEvents: events });
		await defineOk(h, railSource());
		const first = await pollOk(h, "rail-prod");
		events.push({ cursor: "3", railId: "rail-prod", railDigest: D1, status: "approved", stationId: "st" });
		const second = await pollOk(h, "rail-prod");
		expect(first.length).toBe(1);
		expect(second).toEqual([]);
		expect(h.ledger.recorded.size).toBe(1);
		const manifest = first[0]?.manifest;
		expect(manifest?.subject).toBe(FreightSubject.RAIL);
		expect(manifest?.bindle).toBe("rail-prod");
		expect(manifest?.declarationHash).toBe(D1);
		expect(manifest?.artifacts).toEqual([]);
	});

	it("retired Rails are not discovered", async () => {
		const h = harness([], {
			readRailEvents: [
				{ cursor: "1", railId: "rail-prod", railDigest: D1, status: "approved", stationId: "st" },
				{ cursor: "2", railId: "rail-prod", railDigest: D1, status: "retired", stationId: "st" },
				{ cursor: "3", railId: "rail-prod", railDigest: D2, status: "approved", stationId: "st" },
			],
		});
		await defineOk(h, railSource());
		const freight = await pollOk(h, "rail-prod");
		expect(freight.map((item) => item.manifest?.declarationHash)).toEqual([D2]);
	});

	it("refuses a Rail source whose bindle is not the Rail id", async () => {
		const h = harness([], { readRailEvents: [] });
		const outcome = await h.sources.define(source("rail", "other", [sub({ name: "rail", kind: SubscriptionKind.HOBO_RAIL, locator: "rail-prod" })]), h.ctx);
		expect(!outcome.ok && outcome.reasons.map((item) => item.subject)).toContain("subscriptions[0].locator");
	});
});

describe("ledger refusals", () => {
	it("a refused manifest is recorded with the ledger's reasons and never retried as Freight", async () => {
		const h = harness(OCI_FIXTURES);
		h.ledger.refuseWhen = (manifest) => manifest.artifacts[0]?.digest === DIGESTS["1.1.0"];
		await defineOk(h, source("app", "web", [image]));
		const freight = await pollOk(h, "app");
		expect(freight.length).toBe(2);
		const refused = discoveries(h, "app").find((item) => item.data.version === "1.1.0");
		expect(refused?.outcome).toBe("refused");
		expect(refused?.reasons.map((item) => item.code)).toEqual(["source-freight-refused", "freight-artifact-unverified"]);
		expect(h.telemetry.count(SOURCE_METRIC.freightRefused)).toBe(1);
	});
});

describe("secret-free records (I9)", () => {
	it("never writes a resolved credential into the journal", async () => {
		const h = harness(OCI_FIXTURES);
		await defineOk(h, source("app", "web", [image]));
		await pollOk(h, "app");
		const journal = JSON.stringify(h.store.events(CD_STREAMS.source("app")));
		expect(journal).not.toContain("reg-token");
		expect(journal).not.toContain(WEBHOOK_SECRET);
	});
});
