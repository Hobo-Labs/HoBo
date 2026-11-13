// Golden v1 event bodies for every source fact (append-only upcaster corpus):
// a journal written by this release must fold identically in every later one.
// Changing a body or meta form needs an upcaster plus a new corpus entry,
// never an edit here.
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	createFreightSources,
	createSubscriptionDrivers,
} from "../../src/sources/index.js";
import {
	asLedger,
	clock,
	context,
	digestOf,
	FakeAuthorizer,
	FakeLedger,
	FakeProvenance,
	FixtureTransport,
	json,
	MemoryEventStore,
	OPERATOR,
	StaticCredentials,
	TENANT,
} from "./support.js";

const INDEX = "https://downloads.example.com/web/index.json";

const CORPUS: readonly Readonly<{
	type: string;
	v: 1;
	data: JsonObject;
	meta: JsonObject;
}>[] = [
	{
		type: CD_EVENTS.SourceDefined,
		v: 1,
		data: {
			schemaVersion: "hobo.cd.source/v1",
			name: "assets",
			bindle: "web",
			subscriptions: [
				{
					name: "assets",
					kind: "SUBSCRIPTION_KIND_HTTP_INDEX",
					locator: INDEX,
					selection: "SELECTION_STRATEGY_SEMVER",
					discoveryLimit: 20,
					artifactKind: "ARTIFACT_KIND_STATIC_ASSETS",
				},
			],
			assembly: "ASSEMBLY_RULE_INDEPENDENT",
			automatic: true,
			pollIntervalMs: "300000",
			definedBy: "ops@acme",
		},
		meta: {
			idempotencyKey:
				"defined:0000000000000000000000000000000000000000000000000000000000000000",
			decisionId: "decision-1",
		},
	},
	{
		type: CD_EVENTS.SourceArtifactDiscovered,
		v: 1,
		data: {
			source: "assets",
			subscription: "assets",
			artifact: {
				name: "assets",
				kind: "ARTIFACT_KIND_STATIC_ASSETS",
				digest: digestOf("1.1.0"),
				coordinate: "https://downloads.example.com/web/1.1.0.tgz",
				ecosystem: "http",
			},
			version: "1.1.0",
			discoveredAt: "2026-11-12T12:00:00.000Z",
		},
		meta: {
			idempotencyKey: `discovered:${"1".repeat(64)}`,
			cursor: '{"hw":"1.1.0"}',
			outcome: "recorded",
			reasons: [],
			freightIds: [digestOf("freight-1.1.0")],
			decisionId: "decision-2",
		},
	},
	{
		type: CD_EVENTS.SourceArtifactDiscovered,
		v: 1,
		data: {
			source: "assets",
			subscription: "assets",
			artifact: {
				name: "assets",
				kind: "ARTIFACT_KIND_STATIC_ASSETS",
				digest: digestOf("0.9.0"),
				coordinate: "https://downloads.example.com/web/0.9.0.tgz",
				ecosystem: "http",
			},
			version: "0.9.0",
			discoveredAt: "2026-11-12T12:00:00.000Z",
		},
		meta: {
			idempotencyKey: `discovered:${"2".repeat(64)}`,
			cursor: '{"hw":"1.1.0"}',
			outcome: "skipped",
			reasons: [
				{
					code: "source-older-than-high-water",
					message: "0.9.0 is not newer than a version already discovered",
					remediation: "discovery is forward-only; publish a newer version",
					subject: "0.9.0",
				},
			],
			freightIds: [],
			decisionId: "decision-2",
		},
	},
];

describe("golden source journal (v1 corpus)", () => {
	it("folds the corpus: definition listed, cursor resumed, history kept, nothing rediscovered", async () => {
		const time = clock();
		const store = new MemoryEventStore();
		await store.append(
			CD_STREAMS.source("assets"),
			CORPUS.map((entry) => ({
				type: entry.type,
				v: entry.v,
				data: entry.data,
				meta: entry.meta,
			})),
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		const fixture = new FixtureTransport([
			{
				url: INDEX,
				response: json([
					{
						version: "1.0.0",
						url: "https://downloads.example.com/web/1.0.0.tgz",
						digest: digestOf("1.0.0"),
					},
					{
						version: "1.1.0",
						url: "https://downloads.example.com/web/1.1.0.tgz",
						digest: digestOf("1.1.0"),
					},
					{
						version: "1.2.0",
						url: "https://downloads.example.com/web/1.2.0.tgz",
						digest: digestOf("1.2.0"),
					},
				]),
			},
		]);
		const ledger = new FakeLedger();
		const sources = createFreightSources({
			store,
			tenant: TENANT,
			now: time.now,
			ledger: asLedger(ledger),
			drivers: createSubscriptionDrivers({
				http: fixture.http,
				credentials: new StaticCredentials({}),
			}),
			provenance: new FakeProvenance(),
			authorizer: new FakeAuthorizer(),
			webhookSecrets: new StaticCredentials({}),
		});
		const listed = await sources.list();
		expect(
			listed.map((item) => [item.name, item.bindle, item.pollIntervalMs]),
		).toEqual([["assets", "web", 300_000n]]);
		const polled = await sources.poll("assets", context(time.now));
		if (!polled.ok) throw new Error(JSON.stringify(polled.reasons));
		// Only 1.2.0 is above the journaled high-water mark.
		expect(ledger.calls.map((item) => item.artifacts[0]?.digest)).toEqual([
			digestOf("1.2.0"),
		]);
		expect(store.events(CD_STREAMS.source("assets")).length).toBe(
			CORPUS.length + 1,
		);
	});
});
