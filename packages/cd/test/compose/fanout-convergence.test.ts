/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test ids are literal branded ids (Camp, Freight, Reconciler). */
// Fan-out drives convergence through the composed PromotionService (plan
// 0024 D20/D21, WP18). The composition wires the placed-Camps reader (the
// recorded placement decision) and the fan-out aggregate gate (Rail
// max_fanout_camps, Station entitlement and budget) into the promotion
// service, so a PROGRESSIVE_PER_GROUP fan-out over placed Camps writes each
// Camp's Set through the ordinary promotion path: lineage, gate, Delta,
// rollout (convergence observed from a reconciler), verification,
// qualification. Every module is the real one from `defaultCdFactories`; only
// host-owned adapters (Matching resolver, deploy gate, conductor realizer,
// pricing and budget) are doubles, over the SQLite journal held in memory.
import { create, fromJson } from "@bufbuild/protobuf";
import {
	createResolvedDeploymentSet,
	DEPLOYMENT_PLAN_SCHEMA,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import type { HttpTransport } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteDriver,
	SqliteJournal,
} from "../../../storage-sqlite/src/index.js";
import {
	CampSetRecordSchema,
	DeltaRecordSchema,
	FanoutState,
	FreightManifestRecordSchema,
	type FreightRecord,
	PipelineRecordSchema,
	PlacementRecordSchema,
	ReconcileObservationRecordSchema,
	ReconcilerMode,
	ReconcileStatus,
	SetOrigin,
	TaintEffect,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createCdBaselinePack } from "../../src/authz/rules.js";
import { composeContinuousDelivery } from "../../src/compose/compose.js";
import type {
	CdComposeAdapters,
	ComposedContinuousDelivery,
	FanoutCostAuthority,
} from "../../src/compose/wire.js";
import { createPlacementEngine } from "../../src/placement/index.js";
import type {
	CampId,
	CampTopology,
	CdContext,
	DeployGate,
	FanoutId,
	FreightId,
	Realizer,
	ReconcilerId,
	SetResolver,
} from "../../src/ports.js";
import {
	createA2HApprover,
	deltaIdFor,
	diffResolvedSets,
} from "../../src/promotion/index.js";
import { createDriftPolicy } from "../../src/reconcile/index.js";
import { createHarnessRolloutEngine } from "../../src/rollout/index.js";
import { clock, OPERATOR, T0, TENANT } from "../promotion/store.js";
import { fakeTopology, recordingSink, staticCatalog } from "./fakes.js";

const STATION = "st1";
const PIPELINE = "fleet";
const NODE = "fleet";
const SET = "fleet-hosts";
const BINDLE = "acme/fleet";
const PILOT = "fleet/pilot-1" as CampId;
const HOST_A = "fleet/host-a" as CampId;
const HOST_B = "fleet/host-b" as CampId;
const CAMPS = [PILOT, HOST_A, HOST_B] as const;
const SOAK_MS = 60_000;
const HEALTH = "https://fleet.test/health";

function host(campId: CampId, ring: string): CampTopology {
	return {
		campId,
		yardId: "yard-1",
		stationId: STATION,
		provider: "self-hosted",
		regions: ["us-east-1"],
		envType: "production",
		labels: { "acme/fleet": "true", "acme/ring": ring },
		management: 1,
	};
}

const MANIFESTS = new Map(
	["v1", "v2"].map((release) => {
		const body = JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			annotations: { "org.opencontainers.image.version": release },
		});
		return [release, body] as const;
	}),
);

async function sha256(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hash)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** A registry that serves only the recorded manifests (offline). */
async function registryOf(): Promise<HttpTransport> {
	const byUrl = new Map<string, { digest: string; body: string }>();
	for (const body of MANIFESTS.values()) {
		const digest = `sha256:${await sha256(body)}`;
		byUrl.set(`https://ghcr.io/v2/acme/fleet/manifests/${digest}`, {
			digest,
			body,
		});
	}
	return async (request) => {
		if (request.url === HEALTH) return { status: 200, headers: {}, body: "ok" };
		const found = byUrl.get(request.url);
		return found
			? {
					status: 200,
					headers: {
						"content-type": "application/vnd.oci.image.manifest.v1+json",
						"docker-content-digest": found.digest,
					},
					body: found.body,
				}
			: { status: 404, headers: {}, body: "" };
	};
}

/** The Set a Camp resolves to: one compute row pinning the Freight's image. */
function resolvedFor(campId: string, image: string): ResolvedDeploymentSet {
	return createResolvedDeploymentSet({
		tenant: TENANT,
		environment: "production",
		campId,
		plan: {
			schema: DEPLOYMENT_PLAN_SCHEMA,
			resources: [
				{
					name: "agent",
					port: "compute",
					provider: "self-hosted",
					deps: [],
					productId: "acme.fleet-agent/v1",
					realizationParameters: { image },
				},
			],
			dependencyOrder: ["agent"],
			objective: "pinned",
		},
		matches: [
			{
				resource: "agent",
				providerId: "self-hosted",
				port: "compute",
				rationale: "the host's own engine",
			},
		],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "pending",
			obligations: [],
			decidedAt: new Date(T0).toISOString(),
		},
	});
}

/** Matching double: the Freight's one OCI image, pinned by digest, per Camp. */
function imageResolver(
	desired: () => ComposedContinuousDelivery["desired"],
	freightImage: (f: FreightRecord) => string,
): SetResolver {
	return {
		async resolve(input, ctx) {
			const base = input.base ?? (await desired().current(input.campId));
			const before = base ? await desired().resolved(base) : undefined;
			const resolved = resolvedFor(input.campId, freightImage(input.freight));
			const delta = create(DeltaRecordSchema, {
				deltaId: deltaIdFor({
					campId: input.campId,
					freightId: input.freight.freightId,
					intent: input.intent,
					baseSetId: base?.setId ?? "",
					contentHash: resolved.contentHash,
				}),
				campId: input.campId,
				baseSetId: base?.setId ?? "",
				freightId: input.freight.freightId,
				changes: diffResolvedSets(before, resolved),
				openedBy: `${ctx.principal.kind}:${ctx.principal.id}`,
				intent: input.intent,
			});
			return { ok: true, value: { resolved, delta } };
		},
	};
}

/** Deploy gate double: allows every Camp and records what it was asked. */
function allowGate(asked: string[]): DeployGate {
	return {
		async evaluate(input, ctx) {
			asked.push(input.delta.campId);
			return {
				decisionId: `gate-${input.delta.campId}-${ctx.now()}`,
				effect: "allow",
				obligations: [],
				reasons: [],
			};
		},
	};
}

/** A host whose engine runs what its Set pins; convergence is observed, never assumed. */
class FakeHosts {
	readonly running = new Map<string, string>();
	readonly converges: string[] = [];
	realizer(): Realizer {
		const observed = (
			input: Parameters<Realizer["converge"]>[0],
			ctx: CdContext,
		) => {
			const image = input.resolved.plan.resources[0]?.realizationParameters
				?.image as string | undefined;
			const ok =
				image !== undefined && this.running.get(input.campId) === image;
			return create(ReconcileObservationRecordSchema, {
				campId: input.campId,
				setId: ok ? input.desired.setId : "",
				reconcilerId: input.reconcilerId,
				fenceToken: input.fence.toString(10),
				status: ok ? ReconcileStatus.CONVERGED : ReconcileStatus.CONVERGING,
				observedAt: new Date(ctx.now()).toISOString(),
			});
		};
		return {
			converge: async (input, ctx) => {
				const image = input.resolved.plan.resources[0]?.realizationParameters
					?.image as string | undefined;
				if (image !== undefined) {
					this.running.set(input.campId, image);
					this.converges.push(`${input.campId}@${image}`);
				}
				return observed(input, ctx);
			},
			observe: async (input, ctx) => observed(input, ctx),
		};
	}
}

type Station = Readonly<{
	cd: ComposedContinuousDelivery;
	store: SqliteJournal;
	clock: ReturnType<typeof clock>;
	ctx: CdContext;
	hosts: FakeHosts;
	gateAsked: string[];
	budgetAsked: string[];
	freightImage: Map<string, string>;
}>;

async function station(
	cost: FanoutCostAuthority | undefined,
	rail: Readonly<{ maxFanoutCamps: number }> = { maxFanoutCamps: 10 },
): Promise<Station> {
	const c = clock(T0);
	// The durable SQLite journal (subscription leases, stream-head CAS).
	const store = new SqliteJournal(
		createNodeSqliteDriver({ path: ":memory:" }),
		{
			clock: { now: () => new Date(c.now()).toISOString() },
		},
	);
	const base = { store, tenant: TENANT, now: c.now };
	const hosts = new FakeHosts();
	const gateAsked: string[] = [];
	const budgetAsked: string[] = [];
	const freightImage = new Map<string, string>();
	const topology = fakeTopology([
		host(PILOT, "pilot"),
		host(HOST_A, "fleet"),
		host(HOST_B, "fleet"),
	]);
	const adapters: CdComposeAdapters = {
		gate: () => allowGate(gateAsked),
		resolver: (s) =>
			imageResolver(
				() => s.desired,
				(f) => freightImage.get(f.freightId) ?? "unknown",
			),
		approvals: (s) =>
			createA2HApprover({
				store: s.base.store,
				tenant: s.base.tenant,
				now: s.base.now,
				notify: s.notify,
				authorizer: s.authorizer,
				telemetry: s.telemetry,
			}),
		rolloutEngine: (s) => createHarnessRolloutEngine({ ...s.base }),
		drift: () => createDriftPolicy({}),
		realizer: (mode) =>
			mode === ReconcilerMode.CONDUCTOR ? hosts.realizer() : undefined,
		resolvePack: async () => ({}) as never,
		packs: async () => [],
		...(cost
			? {
					fanoutCost: () => ({
						...cost,
						budget: async (stationId: string) => {
							budgetAsked.push(stationId);
							return cost.budget(stationId);
						},
					}),
				}
			: undefined),
	};
	const cd = composeContinuousDelivery({
		base,
		factories: {
			createPlacementEngine: (deps) =>
				createPlacementEngine({
					...deps,
					approvedProviders: async () => ["self-hosted"],
				}),
		},
		adapters,
		http: await registryOf(),
		credentials: {
			async resolve() {
				throw new Error("no credential is needed offline");
			},
		},
		artifactStore: { backend: "memory" },
		trustPolicy: {},
		policyPack: createCdBaselinePack(),
		topology,
		railCatalog: staticCatalog([
			{
				railId: "rail-1",
				railDigest: `sha256:${"r".repeat(64)}` as never,
				stationId: STATION,
				status: "active",
				delivery: { campSets: [SET], maxFanoutCamps: rail.maxFanoutCamps },
			},
		]),
		telemetry: recordingSink(),
	});
	return {
		cd,
		store,
		clock: c,
		ctx: { tenant: TENANT, principal: OPERATOR, now: c.now },
		hosts,
		gateAsked,
		budgetAsked,
		freightImage,
	};
}

async function define(s: Station): Promise<void> {
	const { cd, ctx } = s;
	// Inventory scans the journal from where it starts (cold start).
	await cd.inventory.tick(ctx);
	const set = await cd.inventory.defineSet(
		fromJson(CampSetRecordSchema, {
			name: SET,
			selector: { labels: { "acme/fleet": "true" } },
		}),
		ctx,
	);
	if (!set.ok) throw new Error(set.reasons[0]?.message);
	const placement = await cd.placement.define(
		fromJson(PlacementRecordSchema, {
			schemaVersion: "hobo.cd.placement/v1",
			name: SET,
			campSets: [SET],
			count: 0,
			groups: [
				{
					name: "pilot",
					selector: { labels: { "acme/ring": "pilot" } },
					maxSize: 1,
				},
				{ name: "fleet", selector: { labels: { "acme/ring": "fleet" } } },
			],
		}),
		ctx,
	);
	if (!placement.ok) throw new Error(placement.reasons[0]?.message);
	const pipeline = await cd.pipelines.apply(
		fromJson(PipelineRecordSchema, {
			schemaVersion: "hobo.cd.pipeline/v1",
			name: PIPELINE,
			bindle: BINDLE,
			nodes: [
				{
					name: NODE,
					placement: SET,
					fromSources: ["origin:manifest"],
					// No traffic to shift: a host swaps in place.
					strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
					// Each host's health is probed after it converges; only PASS qualifies.
					verification: {
						windowMs: "30000",
						requiredObservations: 3,
						progressDeadlineMs: "600000",
						failOnNoData: true,
						probes: [
							{
								name: "health",
								urlRef: HEALTH,
								expectStatus: 200,
								intervalMs: "10000",
								minSuccessRatio: 1,
							},
						],
					},
					fanout: {
						strategy: "FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP",
						maxConcurrency: 1,
						minSuccessMs: String(SOAK_MS),
						progressDeadlineMs: String(3_600_000),
						maxFailures: 1,
						mandatoryGroups: ["pilot"],
					},
				},
			],
		}),
		ctx,
	);
	if (!pipeline.ok) throw new Error(pipeline.reasons[0]?.message);
}

async function recordFreight(s: Station, release: string) {
	const body = MANIFESTS.get(release) ?? "";
	const digest = `sha256:${await sha256(body)}`;
	const image = `ghcr.io/acme/fleet@${digest}`;
	const recorded = await s.cd.ingest.manifest(
		{
			manifest: fromJson(FreightManifestRecordSchema, {
				schemaVersion: "hobo.freight-manifest/v1",
				bindle: BINDLE,
				declarationHash: `sha256:${await sha256(`${BINDLE}@${release}`)}`,
				artifacts: [
					{
						name: "fleet-agent",
						kind: "ARTIFACT_KIND_OCI_IMAGE",
						digest,
						coordinate: image,
						ecosystem: "oci",
					},
				],
			}),
		},
		s.ctx,
	);
	if (!recorded.ok) throw new Error(recorded.reasons[0]?.message);
	s.freightImage.set(recorded.value.freightId, image);
	return { freight: recorded.value, image };
}

/** The baseline every host runs today, adopted as its first Set (the hosts report before they are placed). */
async function adopt(
	s: Station,
	conductor: ReturnType<Station["cd"]["createReconciler"]>,
) {
	const { freight, image } = await recordFreight(s, "v1");
	for (const campId of CAMPS) {
		const deltaId = `delta_baseline_${campId.replace("/", "_")}`;
		const resolved = resolvedFor(campId, image);
		const delta = await s.cd.deltas.open(
			create(DeltaRecordSchema, {
				deltaId,
				campId,
				freightId: freight.freightId,
				intent: "promote",
				changes: diffResolvedSets(undefined, resolved),
			}),
			s.ctx,
		);
		if (!delta.ok) throw new Error(delta.reasons[0]?.message);
		const applied = await s.cd.deltas.apply(
			{
				deltaId: delta.value.deltaId as never,
				gateDecisionId: `baseline-${campId}`,
				resolved,
				origin: SetOrigin.UP,
			},
			s.ctx,
		);
		if (!applied.ok) throw new Error(applied.reasons[0]?.message);
		const observed = await conductor.reconcileOnce(campId, s.ctx);
		expect(
			ReconcileStatus[observed.status],
			observed.reasons.map((r) => `${r.code}: ${r.message}`).join("; "),
		).toBe("CONVERGED");
	}
	await s.cd.inventory.tick(s.ctx);
	return image;
}

/** One control-loop pass: fan-out, promotions, every host's reconciler, inventory. */
async function pass(
	s: Station,
	conductor: ReturnType<Station["cd"]["createReconciler"]>,
	advanceMs: number,
) {
	await s.cd.fanout.tick(s.ctx);
	await s.cd.promotions.tick(s.ctx);
	await s.cd.rollouts.tick(s.ctx);
	await s.cd.verification.tick(s.ctx);
	for (const campId of CAMPS) await conductor.reconcileOnce(campId, s.ctx);
	await s.cd.inventory.tick(s.ctx);
	await s.cd.promotions.tick(s.ctx);
	s.clock.advance(advanceMs);
}

async function progressOf(s: Station, fanoutId: string) {
	const out: { campId: string; outcome: string; code: string }[] = [];
	for await (const event of s.store.read(`cd-fanout-${fanoutId}`))
		if (event.type === "fanout.Progressed") {
			const data = event.data as {
				campId?: string;
				outcome?: string;
				reasons?: { code?: string }[];
			};
			out.push({
				campId: data.campId ?? "",
				outcome: data.outcome ?? "",
				code: data.reasons?.[0]?.code ?? "",
			});
		}
	return out;
}

/** The delivery journal as one line per event: the failure message when an expectation misses. */
async function journal(s: Station): Promise<string> {
	const lines: string[] = [];
	for await (const e of s.store.readAll({}))
		if (/promotion|fanout|rollout|verification/.test(e.event.streamId))
			lines.push(
				`${e.event.type} ${JSON.stringify(e.event.data).slice(0, 240)}`,
			);
	return lines.join("\n");
}

async function startFanout(s: Station, freightId: string) {
	const decided = await s.cd.placement.decide(
		{
			placement: SET,
			pipeline: PIPELINE,
			node: NODE,
			stationId: STATION,
			subject: { classifications: [], residency: [] },
		},
		s.ctx,
	);
	if (!decided.ok)
		throw new Error(
			decided.reasons.map((r) => `${r.code} ${r.message}`).join("; "),
		);
	const pipeline = await s.cd.pipelines.get(PIPELINE);
	const node = pipeline?.nodes.find((n) => n.name === NODE);
	if (!node?.fanout) throw new Error("the node has no fan-out");
	const started = await s.cd.fanout.start(
		{
			pipeline: PIPELINE,
			node: NODE,
			freightId: freightId as FreightId,
			decision: decided.value,
			fanout: node.fanout,
			departure: node.departure,
			idempotencyKey: `fanout-${freightId}`,
		},
		s.ctx,
	);
	if (!started.ok) throw new Error(started.reasons[0]?.message);
	return {
		decision: decided.value,
		fanoutId: started.value.fanoutId as FanoutId,
	};
}

const COST: FanoutCostAuthority = {
	quote: async () => 10,
	budget: async () => ({ limit: 100, used: 0 }),
};

describe("fan-out drives convergence through the composed promotion service (D20, D21)", () => {
	it("pilot converges first, the next group starts only after the pilot qualifies, a deferred host catches up", {
		timeout: 60_000,
	}, async () => {
		const s = await station(COST);
		await define(s);
		const conductor = s.cd.createReconciler({
			mode: ReconcilerMode.CONDUCTOR,
			reconcilerId: "conductor:test" as ReconcilerId,
			campIds: CAMPS,
			holderId: "test",
		});
		const baseline = await adopt(s, conductor);
		const { freight, image } = await recordFreight(s, "v2");
		const { decision, fanoutId } = await startFanout(s, freight.freightId);
		expect(decision.groups.map((g) => [g.name, [...g.campIds]])).toEqual([
			["pilot", [PILOT]],
			["fleet", [HOST_A, HOST_B]],
		]);
		// host-b goes NO_RUN after placement: it is deferred at its turn.
		const tainted = await s.cd.inventory.taint(
			{
				campId: HOST_B,
				taint: create(TaintRecordSchema, {
					key: "acme/maintenance",
					effect: TaintEffect.NO_RUN,
				}),
			},
			s.ctx,
		);
		expect(tainted.ok).toBe(true);

		// The pilot's promotion runs alone; the fleet group waits.
		for (let i = 0; i < 4; i += 1) await pass(s, conductor, 1_000);
		expect(s.hosts.running.get(PILOT), await journal(s)).toBe(image);
		expect((await s.cd.desired.current(PILOT))?.freightId).toBe(
			freight.freightId,
		);
		expect(s.hosts.running.get(HOST_A)).toBe(baseline);
		expect(
			(await progressOf(s, fanoutId)).filter((p) => p.campId !== PILOT),
		).toEqual([]);
		// The aggregate was checked against the Station budget, and the gate
		// admitted the pilot through the ordinary promotion path.
		expect(s.budgetAsked).toContain(STATION);
		expect(s.gateAsked).toContain(PILOT);

		// Pilot qualifies after its soak; only then does the fleet group start.
		for (let i = 0; i < 30; i += 1) await pass(s, conductor, 10_000);
		const progress = await progressOf(s, fanoutId);
		const pilotSucceeded = progress.findIndex(
			(p) => p.campId === PILOT && p.outcome === "succeeded",
		);
		const firstFleet = progress.findIndex((p) => p.campId !== PILOT);
		expect(pilotSucceeded, await journal(s)).toBeGreaterThanOrEqual(0);
		expect(firstFleet).toBeGreaterThan(pilotSucceeded);
		expect(s.hosts.running.get(HOST_A)).toBe(image);
		expect(progress).toContainEqual({
			campId: HOST_B,
			outcome: "deferred",
			code: "camp-tainted",
		});
		expect(s.hosts.running.get(HOST_B)).toBe(baseline);
		const done = await s.cd.fanout.get(fanoutId);
		expect(FanoutState[done?.state ?? 0]).toBe("COMPLETED");

		// The deferred host recovers and catches up to the qualified Freight.
		const untainted = await s.cd.inventory.untaint(
			{ campId: HOST_B, key: "acme/maintenance", effect: TaintEffect.NO_RUN },
			s.ctx,
		);
		expect(untainted.ok).toBe(true);
		for (let i = 0; i < 30; i += 1) await pass(s, conductor, 10_000);
		expect(s.hosts.running.get(HOST_B)).toBe(image);
		expect((await s.cd.desired.current(HOST_B))?.freightId).toBe(
			freight.freightId,
		);
		const qualified = await s.cd.fanout.qualified({
			pipeline: PIPELINE,
			node: NODE,
		});
		expect([...qualified.qualifiedCampIds].sort()).toEqual([...CAMPS].sort());
	});

	it("refuses the fan-out's promotions before any Camp starts when no pricing authority is composed", async () => {
		const s = await station(undefined);
		await define(s);
		const conductor = s.cd.createReconciler({
			mode: ReconcilerMode.CONDUCTOR,
			reconcilerId: "conductor:test" as ReconcilerId,
			campIds: CAMPS,
			holderId: "test",
		});
		const baseline = await adopt(s, conductor);
		const { freight } = await recordFreight(s, "v2");
		const { fanoutId } = await startFanout(s, freight.freightId);
		for (let i = 0; i < 3; i += 1) await pass(s, conductor, 1_000);
		expect(await progressOf(s, fanoutId)).toContainEqual({
			campId: PILOT,
			outcome: "failed",
			code: "fanout-aggregate-quote-missing",
		});
		expect(s.hosts.running.get(PILOT)).toBe(baseline);
		expect(s.gateAsked).toEqual([]);
	});

	it("refuses a fan-out wider than the Rail's max_fanout_camps before any Camp starts", async () => {
		const s = await station(COST, { maxFanoutCamps: 2 });
		await define(s);
		const conductor = s.cd.createReconciler({
			mode: ReconcilerMode.CONDUCTOR,
			reconcilerId: "conductor:test" as ReconcilerId,
			campIds: CAMPS,
			holderId: "test",
		});
		const baseline = await adopt(s, conductor);
		const { freight } = await recordFreight(s, "v2");
		const { fanoutId } = await startFanout(s, freight.freightId);
		for (let i = 0; i < 3; i += 1) await pass(s, conductor, 1_000);
		expect(await progressOf(s, fanoutId)).toContainEqual({
			campId: PILOT,
			outcome: "failed",
			code: "fanout-budget-exceeded",
		});
		expect(s.hosts.running.get(PILOT)).toBe(baseline);
		expect(s.gateAsked).toEqual([]);
	});
});
