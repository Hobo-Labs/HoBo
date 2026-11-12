import { describe, expect, it } from "vitest";
import {
	FreightOrigin,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	createFreightLedger,
	FREIGHT_METRIC,
	FREIGHT_REASON,
} from "../../src/freight/index.js";
import type { FreightLedger } from "../../src/ports.js";
import { manifest, verification } from "./builders.js";
import {
	AGENT,
	camp,
	clock,
	context,
	FakeAuthorizer,
	fid,
	HOUR,
	MapArtifactVerifier,
	MemoryEventStore,
	RecordingTelemetry,
	TENANT,
} from "./fakes.js";

const PROD = camp("prod-eu");

function harness(options: { authorizer?: FakeAuthorizer | null } = {}) {
	const store = new MemoryEventStore();
	const time = clock();
	const telemetry = new RecordingTelemetry();
	const artifacts = new MapArtifactVerifier();
	for (const item of manifest().artifacts)
		artifacts.register(item.coordinate, item.digest);
	const authorizer =
		options.authorizer === null
			? undefined
			: (options.authorizer ?? new FakeAuthorizer());
	const base = { store, tenant: TENANT, now: time.now, artifacts, telemetry };
	const ledger = createFreightLedger(
		authorizer ? { ...base, authorizer } : base,
	);
	return {
		store,
		time,
		telemetry,
		artifacts,
		authorizer,
		ledger,
		ctx: context(time.now),
	};
}

async function recorded(
	ledger: FreightLedger,
	ctx: ReturnType<typeof context>,
) {
	const outcome = await ledger.record(
		{ manifest: manifest(), origin: FreightOrigin.MANIFEST },
		ctx,
	);
	if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
	return outcome.value;
}

describe("createFreightLedger record", () => {
	it("records verified Freight once and finds it by id, alias and list", async () => {
		const { ledger, ctx, store, telemetry } = harness();
		const first = await recorded(ledger, ctx);
		const again = await recorded(ledger, ctx);
		expect(again).toEqual(first);
		const id = fid(first.freightId);
		expect(
			store.events(CD_STREAMS.freight(id)).map((event) => event.type),
		).toEqual([CD_EVENTS.FreightRecorded]);
		expect(await ledger.get(id)).toEqual(first);
		expect(await ledger.getByAlias(first.alias)).toEqual(first);
		expect(await ledger.list({ bindle: "shop" })).toEqual([first]);
		expect(await ledger.list({ bindle: "other" })).toEqual([]);
		expect(await ledger.list({ labels: { team: "storefront" } })).toEqual([
			first,
		]);
		expect(await ledger.isUsable(id)).toBe(true);
		expect(first.recordedBy).toBe("user:ops@acme");
		expect(first.recordedAt).toBe(new Date(ctx.now()).toISOString());
		expect(telemetry.count(FREIGHT_METRIC.recorded)).toBe(1);
	});

	it("a fresh ledger over the same journal rebuilds the same state (replay)", async () => {
		const { ledger, ctx, store, artifacts, telemetry, time } = harness();
		const record = await recorded(ledger, ctx);
		const replayed = createFreightLedger({
			store,
			tenant: TENANT,
			now: time.now,
			artifacts,
			telemetry,
		});
		expect(await replayed.getByAlias(record.alias)).toEqual(record);
		expect(await replayed.list()).toEqual([record]);
	});

	it("unverified or mismatched digests are refused with typed reasons", async () => {
		const { ledger, ctx, store, artifacts, telemetry } = harness();
		artifacts.known.delete("store://web");
		artifacts.register(
			"store://api",
			"sha256:0000000000000000000000000000000000000000000000000000000000000000",
		);
		const outcome = await ledger.record(
			{ manifest: manifest(), origin: FreightOrigin.MANIFEST },
			ctx,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reasons.map((reason) => reason.code)).toEqual([
			FREIGHT_REASON.artifactsUnverified,
			"artifact-digest-mismatch",
			"artifact-unverified",
		]);
		expect(outcome.reasons[0]?.remediation).not.toBe("");
		expect(store.appendCalls).toBe(0);
		expect(telemetry.count(FREIGHT_METRIC.refused)).toBe(1);
	});

	it("refuses an invalid manifest before calling the artifact verifier", async () => {
		const { ledger, ctx, artifacts } = harness();
		const outcome = await ledger.record(
			{
				manifest: manifest({ declarationHash: "nope" }),
				origin: FreightOrigin.MANIFEST,
			},
			ctx,
		);
		expect(outcome.ok).toBe(false);
		expect(artifacts.calls).toBe(0);
	});

	it("refuses an UNSPECIFIED origin", async () => {
		const { ledger, ctx } = harness();
		const outcome = await ledger.record(
			{ manifest: manifest(), origin: FreightOrigin.UNSPECIFIED },
			ctx,
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe(
			FREIGHT_REASON.originInvalid,
		);
	});
});

describe("yank (I13)", () => {
	it("a yanked Freight is unusable and can be neither qualified nor approved", async () => {
		const { ledger, ctx, store } = harness();
		const record = await recorded(ledger, ctx);
		const id = fid(record.freightId);
		const yanked = await ledger.yank(id, "CVE-2026-0001", ctx);
		expect(yanked.ok).toBe(true);
		expect(await ledger.isUsable(id)).toBe(false);
		const again = await ledger.yank(id, "CVE-2026-0001", ctx);
		expect(again.ok).toBe(true);
		expect(
			store.events(CD_STREAMS.freight(id)).map((event) => event.type),
		).toEqual([CD_EVENTS.FreightRecorded, CD_EVENTS.FreightYanked]);
		const qualified = await ledger.qualify(
			{
				freightId: id,
				campId: PROD,
				pipeline: "shop",
				node: "prod",
				result: verification(id, PROD),
			},
			ctx,
		);
		expect(!qualified.ok && qualified.reasons[0]?.code).toBe(
			FREIGHT_REASON.yanked,
		);
		const approved = await ledger.approve(
			{
				freightId: id,
				campId: PROD,
				reason: "hotfix",
				expiresAtMs: ctx.now() + HOUR,
			},
			ctx,
		);
		expect(!approved.ok && approved.reasons[0]?.code).toBe(
			FREIGHT_REASON.yanked,
		);
	});

	it("refuses to yank unknown Freight or without a reason", async () => {
		const { ledger, ctx } = harness();
		const missing = await ledger.yank(fid("sha256:nope"), "x", ctx);
		expect(!missing.ok && missing.reasons[0]?.code).toBe(
			FREIGHT_REASON.notFound,
		);
		const record = await recorded(ledger, ctx);
		const blank = await ledger.yank(fid(record.freightId), "  ", ctx);
		expect(!blank.ok && blank.reasons[0]?.code).toBe(
			FREIGHT_REASON.reasonRequired,
		);
	});

	it("an agent principal can only propose a yank", async () => {
		const { ledger, ctx, time } = harness();
		const record = await recorded(ledger, ctx);
		const outcome = await ledger.yank(
			fid(record.freightId),
			"suspicious",
			context(time.now, AGENT),
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe(
			FREIGHT_REASON.proposalOnly,
		);
		expect(await ledger.isUsable(fid(record.freightId))).toBe(true);
	});
});

describe("qualify accepts only PASS", () => {
	it.each([
		VerificationVerdict.FAIL,
		VerificationVerdict.INCONCLUSIVE,
		VerificationVerdict.UNSPECIFIED,
	])("refuses verdict %s", async (verdict) => {
		const { ledger, ctx } = harness();
		const id = fid((await recorded(ledger, ctx)).freightId);
		const outcome = await ledger.qualify(
			{
				freightId: id,
				campId: PROD,
				pipeline: "shop",
				node: "prod",
				result: verification(id, PROD, verdict),
			},
			ctx,
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe(
			FREIGHT_REASON.verificationNotPass,
		);
		expect(await ledger.qualifications(id)).toEqual([]);
	});

	it("refuses a PASS for another Freight or Camp", async () => {
		const { ledger, ctx } = harness();
		const id = fid((await recorded(ledger, ctx)).freightId);
		const other = await ledger.qualify(
			{
				freightId: id,
				campId: PROD,
				pipeline: "shop",
				node: "prod",
				result: verification("sha256:other", PROD),
			},
			ctx,
		);
		expect(!other.ok && other.reasons[0]?.code).toBe(
			FREIGHT_REASON.verificationMismatch,
		);
		const camp = await ledger.qualify(
			{
				freightId: id,
				campId: PROD,
				pipeline: "shop",
				node: "prod",
				result: verification(id, "staging"),
			},
			ctx,
		);
		expect(!camp.ok && camp.reasons[0]?.code).toBe(
			FREIGHT_REASON.verificationMismatch,
		);
	});

	it("records a PASS qualification once", async () => {
		const { ledger, ctx, telemetry } = harness();
		const id = fid((await recorded(ledger, ctx)).freightId);
		const input = {
			freightId: id,
			campId: PROD,
			pipeline: "shop",
			node: "prod",
			result: verification(id, PROD),
		};
		const first = await ledger.qualify(input, ctx);
		const second = await ledger.qualify(input, ctx);
		expect(first.ok && second.ok).toBe(true);
		const list = await ledger.qualifications(id);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			campId: PROD,
			pipeline: "shop",
			node: "prod",
			verificationId: `ver-${PROD}`,
		});
		expect(telemetry.count(FREIGHT_METRIC.qualified)).toBe(1);
	});
});

describe("approve (expiring, governed hotfix bypass)", () => {
	it("records an expiring approval with the policy decision id", async () => {
		const { ledger, ctx, authorizer } = harness();
		const id = fid((await recorded(ledger, ctx)).freightId);
		const outcome = await ledger.approve(
			{
				freightId: id,
				campId: PROD,
				reason: "hotfix INC-12",
				expiresAtMs: ctx.now() + 2 * HOUR,
			},
			ctx,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.decisionId).toBe("dec-1");
		expect(outcome.value.expiresAt).toBe(
			new Date(ctx.now() + 2 * HOUR).toISOString(),
		);
		expect(authorizer?.calls.map((call) => call.action)).toEqual([
			"freight.approve",
		]);
		expect(await ledger.approvals(id)).toEqual([outcome.value]);
	});

	it("refuses expiry in the past or beyond the hotfix maximum", async () => {
		const { ledger, ctx } = harness();
		const id = fid((await recorded(ledger, ctx)).freightId);
		const past = await ledger.approve(
			{ freightId: id, campId: PROD, reason: "x", expiresAtMs: ctx.now() },
			ctx,
		);
		expect(!past.ok && past.reasons[0]?.code).toBe(
			FREIGHT_REASON.approvalExpiry,
		);
		const long = await ledger.approve(
			{
				freightId: id,
				campId: PROD,
				reason: "x",
				expiresAtMs: ctx.now() + CD_DEFAULTS.hotfixApprovalMaxMs + 1,
			},
			ctx,
		);
		expect(!long.ok && long.reasons[0]?.code).toBe(
			FREIGHT_REASON.approvalExpiry,
		);
	});

	it("fails closed without an authorizer and for proposal-only principals", async () => {
		const ungoverned = harness({ authorizer: null });
		const id = fid(
			(await recorded(ungoverned.ledger, ungoverned.ctx)).freightId,
		);
		const outcome = await ungoverned.ledger.approve(
			{
				freightId: id,
				campId: PROD,
				reason: "x",
				expiresAtMs: ungoverned.ctx.now() + HOUR,
			},
			ungoverned.ctx,
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe(
			FREIGHT_REASON.ungoverned,
		);

		const governed = harness();
		const gid = fid((await recorded(governed.ledger, governed.ctx)).freightId);
		const agent = await governed.ledger.approve(
			{
				freightId: gid,
				campId: PROD,
				reason: "x",
				expiresAtMs: governed.ctx.now() + HOUR,
			},
			context(governed.time.now, AGENT),
		);
		expect(!agent.ok && agent.reasons[0]?.code).toBe(
			FREIGHT_REASON.proposalOnly,
		);
		governed.authorizer?.denied.add("freight.approve");
		const denied = await governed.ledger.approve(
			{
				freightId: gid,
				campId: PROD,
				reason: "x",
				expiresAtMs: governed.ctx.now() + HOUR,
			},
			governed.ctx,
		);
		expect(!denied.ok && denied.reasons.map((reason) => reason.code)).toEqual([
			FREIGHT_REASON.unauthorized,
			"policy-denied",
		]);
		expect(await governed.ledger.approvals(gid)).toEqual([]);
	});
});
