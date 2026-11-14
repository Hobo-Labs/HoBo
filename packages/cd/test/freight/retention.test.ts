import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FreightOrigin,
	FreightSubject,
	PolicyBindingRecordSchema,
	PromotionRecordSchema,
	PromotionState,
	RetentionPolicyRecordSchema,
	SetOrigin,
	SetRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	createFreightLedger,
	FREIGHT_METRIC,
	planRetention,
} from "../../src/freight/index.js";
import { artifact, manifest } from "./builders.js";
import {
	camp,
	clock,
	context,
	DAY,
	digestOf,
	FakeAuthorizer,
	fid,
	HOUR,
	MapArtifactVerifier,
	MemoryEventStore,
	OPERATOR,
	RecordingTelemetry,
	TENANT,
} from "./fakes.js";

function harness() {
	const store = new MemoryEventStore();
	const time = clock();
	const telemetry = new RecordingTelemetry();
	const artifacts = new MapArtifactVerifier();
	const ledger = createFreightLedger({
		store,
		tenant: TENANT,
		now: time.now,
		artifacts,
		telemetry,
		authorizer: new FakeAuthorizer(),
	});
	let version = 0;
	const record = async (
		labels: Record<string, string> = {},
		subject = FreightSubject.BINDLE,
	) => {
		version += 1;
		const item = artifact("api", `api-${version}`);
		artifacts.register(item.coordinate, item.digest);
		// A Rail is identified by its declaration hash and carries no artifacts.
		const rail = subject === FreightSubject.RAIL;
		const outcome = await ledger.record(
			{
				manifest: manifest({
					artifacts: rail ? [] : [item],
					labels,
					provenance: [],
					subject,
					declarationHash: digestOf(
						rail ? `rail-${version}` : "shop-declaration-v1",
					),
				}),
				origin: FreightOrigin.MANIFEST,
			},
			context(time.now),
		);
		if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
		return fid(outcome.value.freightId);
	};
	const deploy = async (campId: string, freightId: string) => {
		const stream = CD_STREAMS.campSpec(campId);
		const seq = store.events(stream).length;
		const set = create(SetRecordSchema, {
			schemaVersion: "hobo.cd.set/v1",
			setId: `set-${campId}-${seq + 1}`,
			tenant: TENANT,
			campId,
			freightId,
			origin: SetOrigin.PROMOTION,
			resolvedSetDigest: digestOf(`${campId}-${seq}`),
		});
		await store.append(
			stream,
			[{ type: CD_EVENTS.SetCreated, data: toJson(SetRecordSchema, set) }],
			{
				expectedSeq: seq,
				actor: OPERATOR,
				tenant: TENANT,
			},
		);
	};
	const bind = async (campId: string, freightId: string, data?: JsonValue) => {
		const stream = CD_STREAMS.campSpec(campId);
		const seq = store.events(stream).length;
		const binding = create(PolicyBindingRecordSchema, {
			campId,
			enforcedRailDigest: digestOf(`rail-${seq}`),
			freightId,
			promotionId: `p-rail-${seq}`,
		});
		await store.append(
			stream,
			[
				{
					type: CD_EVENTS.PolicyBindingChanged,
					data: data ?? toJson(PolicyBindingRecordSchema, binding),
				},
			],
			{ expectedSeq: seq, actor: OPERATOR, tenant: TENANT },
		);
	};
	const policy = (
		overrides: Partial<{
			keepPerCamp: number;
			legalHoldLabels: string[];
			bindle: string;
		}> = {},
	) =>
		create(RetentionPolicyRecordSchema, {
			bindle: "shop",
			keepPerCamp: 2,
			keepUnpromotedMs: BigInt(CD_DEFAULTS.retentionKeepUnpromotedMs),
			legalHoldLabels: ["legal-hold"],
			...overrides,
		});
	return { store, time, telemetry, ledger, record, deploy, bind, policy };
}

describe("retention sweep (D18)", () => {
	it("retention sweep with Freight deployed in prod keeps prod Freight (§10)", async () => {
		const h = harness();
		const prod = await h.record();
		const stale = await h.record();
		await h.deploy("prod-eu", prod);
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		const retired = await h.ledger.retire(h.policy(), context(h.time.now));
		expect(retired.map((record) => record.freightId)).toEqual([stale]);
		expect(await h.ledger.isUsable(prod)).toBe(true);
		expect(await h.ledger.isUsable(stale)).toBe(false);
		expect(h.telemetry.count(FREIGHT_METRIC.retired)).toBe(1);
	});

	it("retention never retires Freight deployed anywhere, inside rollback depth, or under legal hold", async () => {
		const h = harness();
		const v1 = await h.record();
		const v2 = await h.record();
		const v3 = await h.record();
		const v4 = await h.record();
		const held = await h.record({ "legal-hold": "case-17" });
		const loose = await h.record();
		for (const freight of [v1, v2, v3, v4]) await h.deploy("prod-eu", freight);
		await h.deploy("staging", v1);
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		const retired = await h.ledger.retire(
			h.policy({ keepPerCamp: 2 }),
			context(h.time.now),
		);
		// prod-eu: v4 current, v3 and v2 within rollback depth 2; staging: v1 current.
		expect(retired.map((record) => record.freightId)).toEqual([loose]);
		for (const kept of [v1, v2, v3, v4, held])
			expect(await h.ledger.isUsable(kept)).toBe(true);
	});

	it("retention keeps Rail Freight bound to a Camp (D18/D24)", async () => {
		const h = harness();
		const app = await h.record();
		const r1 = await h.record({}, FreightSubject.RAIL);
		const r2 = await h.record({}, FreightSubject.RAIL);
		const r3 = await h.record({}, FreightSubject.RAIL);
		const r4 = await h.record({}, FreightSubject.RAIL);
		await h.deploy("prod-eu", app);
		for (const rail of [r1, r2, r3, r4]) await h.bind("prod-eu", rail);
		// A restore that names no Freight adds nothing to the history.
		await h.bind("prod-eu", "");
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		const retired = await h.ledger.retire(
			h.policy({ keepPerCamp: 2 }),
			context(h.time.now),
		);
		// prod-eu#rail: r4 bound, r3 and r2 within rollback depth; the Set
		// history (app) is separate and does not push the Rail out.
		expect(retired.map((record) => record.freightId)).toEqual([r1]);
		for (const kept of [app, r2, r3, r4])
			expect(await h.ledger.isUsable(kept)).toBe(true);
	});

	it("fails closed on an unreadable binding or a Set that names no Camp", async () => {
		const h = harness();
		const rail = await h.record({}, FreightSubject.RAIL);
		await h.bind("prod-eu", rail, "garbage");
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		expect(await h.ledger.retire(h.policy(), context(h.time.now))).toEqual([]);
		expect(h.telemetry.count(FREIGHT_METRIC.retentionAborted)).toBe(1);

		const g = harness();
		const freight = await g.record();
		await g.store.append(
			"cd-elsewhere",
			[
				{
					type: CD_EVENTS.SetCreated,
					data: toJson(
						SetRecordSchema,
						create(SetRecordSchema, { setId: "s-1", freightId: freight }),
					),
				},
			],
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		g.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		expect(await g.ledger.retire(g.policy(), context(g.time.now))).toEqual([]);
		expect(await g.ledger.isUsable(freight)).toBe(true);
		expect(g.telemetry.count(FREIGHT_METRIC.retentionAborted)).toBe(1);
	});

	it("a Set naming no Freight does not displace the deployed Freight", async () => {
		const h = harness();
		const v1 = await h.record();
		const v2 = await h.record();
		const v3 = await h.record();
		for (const freight of [v1, v2, v3, ""]) await h.deploy("prod-eu", freight);
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		const retired = await h.ledger.retire(
			h.policy({ keepPerCamp: 1 }),
			context(h.time.now),
		);
		// v3 stays current and v2 the one rollback step; only v1 goes.
		expect(retired.map((record) => record.freightId)).toEqual([v1]);
	});

	it("keeps Freight younger than keep_unpromoted_ms and is idempotent", async () => {
		const h = harness();
		const young = await h.record();
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs - HOUR);
		expect(await h.ledger.retire(h.policy(), context(h.time.now))).toEqual([]);
		h.time.advance(2 * HOUR);
		expect(
			(await h.ledger.retire(h.policy(), context(h.time.now))).map(
				(r) => r.freightId,
			),
		).toEqual([young]);
		expect(await h.ledger.retire(h.policy(), context(h.time.now))).toEqual([]);
	});

	it("only sweeps the policy's Bindle; an empty bindle covers every Bindle", async () => {
		const h = harness();
		await h.record();
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		expect(
			await h.ledger.retire(h.policy({ bindle: "other" }), context(h.time.now)),
		).toHaveLength(0);
		expect(
			await h.ledger.retire(h.policy({ bindle: "" }), context(h.time.now)),
		).toHaveLength(1);
	});

	it("keeps Freight with an in-flight promotion or an unexpired approval", async () => {
		const h = harness();
		const promoting = await h.record();
		const approved = await h.record();
		const promotion = create(PromotionRecordSchema, {
			promotionId: "p-1",
			freightId: promoting,
			targetCampIds: ["prod-eu"],
			state: PromotionState.QUEUED,
		});
		await h.store.append(
			CD_STREAMS.promotion("p-1"),
			[
				{
					type: CD_EVENTS.EnvPromoteRequested,
					data: toJson(PromotionRecordSchema, promotion),
				},
			],
			{ expectedSeq: 0, actor: OPERATOR, tenant: TENANT },
		);
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		const ctx = context(h.time.now);
		const approval = await h.ledger.approve(
			{
				freightId: approved,
				campId: camp("prod-eu"),
				reason: "hold",
				expiresAtMs: ctx.now() + HOUR,
			},
			ctx,
		);
		expect(approval.ok).toBe(true);
		expect(await h.ledger.retire(h.policy(), ctx)).toEqual([]);
		await h.store.append(
			CD_STREAMS.promotion("p-1"),
			[
				{
					type: CD_EVENTS.EnvPromoteRejected,
					data: toJson(PromotionRecordSchema, {
						...promotion,
						state: PromotionState.REJECTED,
					}),
				},
			],
			{ expectedSeq: 1, actor: OPERATOR, tenant: TENANT },
		);
		expect(
			(await h.ledger.retire(h.policy(), ctx)).map((r) => r.freightId),
		).toEqual([promoting]);
	});

	it("fails closed when a desired-state event cannot be read", async () => {
		const h = harness();
		const freight = await h.record();
		await h.store.append(
			CD_STREAMS.campSpec("prod-eu"),
			[{ type: CD_EVENTS.SetCreated, data: "garbage" }],
			{
				expectedSeq: 0,
				actor: OPERATOR,
				tenant: TENANT,
			},
		);
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		expect(await h.ledger.retire(h.policy(), context(h.time.now))).toEqual([]);
		expect(await h.ledger.isUsable(freight)).toBe(true);
		expect(h.telemetry.count(FREIGHT_METRIC.retentionAborted)).toBe(1);
	});

	it("retirement keeps the yank evidence and provenance in the journal (release-artifact-provenance-retention)", async () => {
		const h = harness();
		const freight = await h.record();
		const ctx = context(h.time.now);
		expect(
			(
				await h.ledger.yank(
					freight,
					"unretained-yank-evidence must never happen",
					ctx,
				)
			).ok,
		).toBe(true);
		h.time.advance(CD_DEFAULTS.retentionKeepUnpromotedMs + DAY);
		expect(await h.ledger.retire(h.policy(), context(h.time.now))).toHaveLength(
			1,
		);
		expect(
			h.store.events(CD_STREAMS.freight(freight)).map((event) => event.type),
		).toEqual([
			CD_EVENTS.FreightRecorded,
			CD_EVENTS.FreightYanked,
			CD_EVENTS.FreightRetired,
		]);
		expect((await h.ledger.get(freight))?.manifest?.source?.builderId).toBe(
			"https://ci.example.com/builders/default",
		);
	});
});

describe("planRetention is pure and order independent (I8)", () => {
	it("returns the same decision for shuffled inputs", () => {
		const candidates = [
			{ freightId: "sha256:a", bindle: "shop", recordedAtMs: 0, labels: {} },
			{ freightId: "sha256:b", bindle: "shop", recordedAtMs: 0, labels: {} },
			{
				freightId: "sha256:c",
				bindle: "shop",
				recordedAtMs: 0,
				labels: { "legal-hold": "y" },
			},
		];
		const deployments = [
			{ campId: "x", freightIds: ["sha256:b"] },
			{ campId: "y", freightIds: [] },
		];
		const input = {
			policy: {
				bindle: "shop",
				keepPerCamp: 1,
				keepUnpromotedMs: 10,
				legalHoldLabels: ["legal-hold"],
			},
			nowMs: 100,
			candidates,
			deployments,
			pinned: [],
		};
		const forward = planRetention(input);
		const backward = planRetention({
			...input,
			candidates: [...candidates].reverse(),
			deployments: [...deployments].reverse(),
		});
		expect(forward).toEqual(backward);
		expect(forward.retire).toEqual(["sha256:a"]);
		expect(forward.kept).toEqual([
			{ freightId: "sha256:b", reason: "deployed" },
			{ freightId: "sha256:c", reason: "legal-hold" },
		]);
	});
});
