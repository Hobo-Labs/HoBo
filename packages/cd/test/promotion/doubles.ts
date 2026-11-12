// Test doubles for the frozen ports the promotion saga composes. Each models
// its port's documented contract; none is reachable from production code.
import { create } from "@bufbuild/protobuf";
import {
	createResolvedDeploymentSet,
	DEPLOYMENT_PLAN_SCHEMA,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import type { JsonObject, PrincipalRef } from "@hobo/core";
import {
	type DeltaRecord,
	DeltaRecordSchema,
	type FreightApprovedRecord,
	FreightApprovedRecordSchema,
	type FreightAvailabilityRecord,
	FreightAvailabilityRecordSchema,
	type FreightQualifiedRecord,
	FreightQualifiedRecordSchema,
	type FreightRecord,
	FreightRecordSchema,
	FreightSubject,
	type PipelineNodeRecord,
	PipelineNodeRecordSchema,
	type PipelineRecord,
	PipelineRecordSchema,
	type PolicyBindingRecord,
	PolicyBindingRecordSchema,
	PolicyMode,
	type ProvenanceRef,
	type RolloutPlanRecord,
	RolloutPlanRecordSchema,
	type SetRecord,
	SetRecordSchema,
	type VerificationResultRecord,
	VerificationResultRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { deltaIdFor, diffResolvedSets } from "../../src/adapters/planning.js";
import type {
	CampId,
	CampPolicy,
	CdAction,
	CdAuthorizer,
	CdContext,
	DeltaId,
	DeltaLedger,
	DeployGate,
	DesiredStateReader,
	FreightId,
	FreightLedger,
	GateVerdict,
	NotificationPort,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	PipelineController,
	RolloutId,
	RolloutOrchestrator,
	RolloutSnapshot,
	RolloutStatus,
	RunbookExecutor,
	SetId,
	SetResolver,
	TelemetrySink,
	VerificationEngine,
	VerificationId,
	VerifyPort,
	WindowEvaluation,
} from "../../src/ports.js";
import { reason } from "../../src/promotion/reasons.js";
import { T0 } from "./store.js";

const iso = (ms: number) => new Date(ms).toISOString();

export class RecordingTelemetry implements TelemetrySink {
	readonly points: OtelMetricPoint[] = [];
	async spans(_spans: readonly OtelSpan[]): Promise<void> {}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
	named(name: string): OtelMetricPoint[] {
		return this.points.filter((point) => point.name === name);
	}
}

export class RecordingAuthorizer implements CdAuthorizer {
	readonly calls: {
		action: CdAction;
		subject: JsonObject;
		principal: PrincipalRef;
	}[] = [];
	readonly deny = new Set<CdAction>();
	async authorize(action: CdAction, subject: JsonObject, ctx: CdContext) {
		this.calls.push({ action, subject, principal: ctx.principal });
		if (this.deny.has(action))
			return {
				ok: false as const,
				reasons: [
					reason("authz-denied", `${action} denied`, "ask for the grant"),
				],
			};
		return {
			ok: true as const,
			value: {
				decisionId: `authz-${this.calls.length}`,
				proposalOnly: ctx.principal.kind === "agent",
			},
		};
	}
}

export function digest(seed: string): `sha256:${string}` {
	return `sha256:${seed.padEnd(64, "0").slice(0, 64)}`;
}

export class FakeFreight implements FreightLedger {
	readonly records = new Map<string, FreightRecord>();
	readonly unusable = new Set<string>();
	readonly approvalList: FreightApprovedRecord[] = [];
	readonly qualifiedList: FreightQualifiedRecord[] = [];

	add(
		id: string,
		options: {
			subject?: FreightSubject;
			labels?: Record<string, string>;
			provenance?: ProvenanceRef[];
			bindle?: string;
			artifactDigest?: string;
			declarationHash?: string;
		} = {},
	): FreightRecord {
		const record = create(FreightRecordSchema, {
			freightId: id,
			alias: `alias-${id}`,
			recordedAt: iso(T0),
			manifest: {
				bindle: options.bindle ?? "acme/shop",
				declarationHash:
					options.declarationHash ?? digest(`d${id.replace(/[^0-9a-f]/g, "")}`),
				subject: options.subject ?? FreightSubject.BINDLE,
				labels: options.labels ?? {},
				provenance: options.provenance ?? [],
				artifacts:
					options.subject === FreightSubject.RAIL
						? []
						: [
								{
									name: "web",
									digest:
										options.artifactDigest ??
										digest(`a${id.replace(/[^0-9a-f]/g, "")}`),
									coordinate: `oci://registry.example/web@${options.artifactDigest ?? digest(`a${id.replace(/[^0-9a-f]/g, "")}`)}`,
								},
							],
			},
		});
		this.records.set(id, record);
		return record;
	}

	approveFor(freightId: string, campId: string, expiresAtMs: number): void {
		this.approvalList.push(
			create(FreightApprovedRecordSchema, {
				freightId,
				campId,
				approvedBy: "user:ops",
				expiresAt: iso(expiresAtMs),
			}),
		);
	}

	async record(): Promise<never> {
		throw new Error("not used");
	}
	async yank(): Promise<never> {
		throw new Error("not used");
	}
	async approve(): Promise<never> {
		throw new Error("not used");
	}
	async qualify(
		input: Readonly<{
			freightId: FreightId;
			campId: CampId;
			pipeline: string;
			node: string;
			result: VerificationResultRecord;
		}>,
	): Promise<Outcome<FreightQualifiedRecord>> {
		if (input.result.verdict !== VerificationVerdict.PASS)
			return {
				ok: false,
				reasons: [reason("not-pass", "only PASS qualifies", "verify again")],
			};
		const record = create(FreightQualifiedRecordSchema, {
			freightId: input.freightId,
			campId: input.campId,
			pipeline: input.pipeline,
			node: input.node,
			verificationId: input.result.verificationId,
		});
		this.qualifiedList.push(record);
		return { ok: true, value: record };
	}
	async get(id: FreightId) {
		return this.records.get(id);
	}
	async getByAlias() {
		return undefined;
	}
	async isUsable(id: FreightId) {
		return this.records.has(id) && !this.unusable.has(id);
	}
	async qualifications(id: FreightId) {
		return this.qualifiedList.filter((q) => q.freightId === id);
	}
	async approvals(id: FreightId) {
		return this.approvalList.filter((a) => a.freightId === id);
	}
	async list() {
		return [...this.records.values()];
	}
	async retire() {
		return [];
	}
}

export function pipelineNode(
	name: string,
	fields: Parameters<typeof create<typeof PipelineNodeRecordSchema>>[1] = {},
): PipelineNodeRecord {
	const node = create(PipelineNodeRecordSchema, fields);
	node.name = name;
	return node;
}

export class FakePipelines implements PipelineController {
	readonly pipelines = new Map<string, PipelineRecord>();
	readonly availability = new Map<string, string[]>();

	define(
		name: string,
		nodes: PipelineNodeRecord[],
		subject = FreightSubject.BINDLE,
	): void {
		this.pipelines.set(
			name,
			create(PipelineRecordSchema, {
				name,
				bindle: "acme/shop",
				nodes,
				subject,
			}),
		);
	}
	makeAvailable(pipeline: string, node: string, freightId: string): void {
		const key = `${pipeline}|${node}`;
		this.availability.set(key, [
			...(this.availability.get(key) ?? []),
			freightId,
		]);
	}
	async apply(): Promise<never> {
		throw new Error("not used");
	}
	async get(name: string) {
		return this.pipelines.get(name);
	}
	async list() {
		return [...this.pipelines.values()];
	}
	async available(
		input: Readonly<{ pipeline: string; node: string }>,
	): Promise<readonly FreightAvailabilityRecord[]> {
		return (this.availability.get(`${input.pipeline}|${input.node}`) ?? []).map(
			(freightId) =>
				create(FreightAvailabilityRecordSchema, {
					pipeline: input.pipeline,
					node: input.node,
					freightId,
					via: ["upstream"],
				}),
		);
	}
	async tick() {}
}

type StoredSet = { set: SetRecord; resolved: ResolvedDeploymentSet };

/** DesiredStateReader & DeltaLedger with WP4's documented rules (one open Delta per Camp, diff check, I12). */
export class FakeDesired implements DesiredStateReader, DeltaLedger {
	readonly sets = new Map<string, StoredSet>();
	readonly currentByCamp = new Map<string, string>();
	readonly deltas = new Map<
		string,
		{
			delta: DeltaRecord;
			status: "open" | "applied" | "rejected";
			setId?: string;
		}
	>();
	readonly applied: {
		deltaId: string;
		gateDecisionId: string;
		origin: number;
		resolved: ResolvedDeploymentSet;
	}[] = [];
	private nextSet = 1;

	seed(
		campId: string,
		freightId: string,
		resolved: ResolvedDeploymentSet,
	): SetRecord {
		return this.mint(campId, freightId, resolved, "seed", 1);
	}

	private mint(
		campId: string,
		freightId: string,
		resolved: ResolvedDeploymentSet,
		gateDecisionId: string,
		origin: number,
	): SetRecord {
		const predecessor = this.currentByCamp.get(campId) ?? "";
		const set = create(SetRecordSchema, {
			setId: `set_${this.nextSet}`,
			campId,
			freightId,
			planHash: resolved.planHash,
			contentHash: resolved.contentHash,
			predecessorSetId: predecessor,
			gateDecisionId,
			origin,
		});
		this.nextSet += 1;
		this.sets.set(set.setId, { set, resolved });
		this.currentByCamp.set(campId, set.setId);
		return set;
	}

	async current(campId: CampId) {
		const id = this.currentByCamp.get(campId);
		return id ? this.sets.get(id)?.set : undefined;
	}
	get(setId: SetId): Promise<SetRecord | undefined>;
	get(deltaId: DeltaId): Promise<DeltaRecord | undefined>;
	async get(id: string): Promise<SetRecord | DeltaRecord | undefined> {
		if (id.startsWith("set_")) return this.sets.get(id)?.set;
		return this.deltas.get(id)?.delta;
	}
	async history(campId: CampId) {
		return [...this.sets.values()]
			.filter((s) => s.set.campId === campId)
			.map((s) => s.set);
	}
	async resolved(set: SetRecord) {
		const stored = this.sets.get(set.setId);
		if (!stored) throw new Error(`resolved-set-missing ${set.setId}`);
		return stored.resolved;
	}
	async status() {
		return undefined;
	}
	async *changes(): AsyncIterable<never> {}
	async open(delta: DeltaRecord): Promise<Outcome<DeltaRecord>> {
		const overlapping = [...this.deltas.values()].find(
			(d) =>
				d.delta.campId === delta.campId &&
				d.status === "open" &&
				d.delta.deltaId !== delta.deltaId,
		);
		if (overlapping)
			return {
				ok: false,
				reasons: [
					reason(
						"delta-overlap",
						`Camp ${delta.campId} has open Delta ${overlapping.delta.deltaId}`,
						"apply or reject it",
					),
				],
			};
		if (!this.deltas.has(delta.deltaId))
			this.deltas.set(delta.deltaId, { delta, status: "open" });
		return { ok: true, value: delta };
	}
	async update(delta: DeltaRecord): Promise<Outcome<DeltaRecord>> {
		return { ok: true, value: delta };
	}
	async apply(
		input: Readonly<{
			deltaId: DeltaId;
			gateDecisionId: string;
			resolved: ResolvedDeploymentSet;
			origin: number;
		}>,
	): Promise<Outcome<SetRecord>> {
		const entry = this.deltas.get(input.deltaId);
		if (!entry)
			return {
				ok: false,
				reasons: [reason("delta-unknown", "unknown Delta", "open it")],
			};
		if (entry.status === "applied" && entry.setId)
			return { ok: true, value: (this.sets.get(entry.setId) as StoredSet).set };
		if (entry.status !== "open")
			return {
				ok: false,
				reasons: [reason("delta-closed", "Delta is closed", "open a new one")],
			};
		const base = this.currentByCamp.get(entry.delta.campId);
		const before = base ? this.sets.get(base)?.resolved : undefined;
		const diff = diffResolvedSets(before, input.resolved);
		if (
			JSON.stringify(diff.map((c) => [c.resource, c.kind])) !==
			JSON.stringify(entry.delta.changes.map((c) => [c.resource, c.kind]))
		)
			return {
				ok: false,
				reasons: [
					reason(
						"delta-diff-mismatch",
						"resolved set does not match the Delta",
						"recompute",
					),
				],
			};
		if (input.resolved.gatekeeper.gatekeeperDecisionId !== input.gateDecisionId)
			return {
				ok: false,
				reasons: [
					reason(
						"set-not-approved",
						"resolved set is not sealed by the gate decision",
						"seal it",
					),
				],
			};
		const set = this.mint(
			entry.delta.campId,
			entry.delta.freightId,
			input.resolved,
			input.gateDecisionId,
			input.origin,
		);
		entry.status = "applied";
		entry.setId = set.setId;
		this.applied.push({
			deltaId: input.deltaId,
			gateDecisionId: input.gateDecisionId,
			origin: input.origin,
			resolved: input.resolved,
		});
		return { ok: true, value: set };
	}
	async reject(deltaId: DeltaId) {
		const entry = this.deltas.get(deltaId);
		if (entry && entry.status === "open") entry.status = "rejected";
	}
}

/** Builds resolved sets like Matching would: one `web` resource on the Camp's provider. */
export function resolvedFor(
	campId: string,
	provider: string,
	image = "web",
	tenant = "acme",
): ResolvedDeploymentSet {
	return createResolvedDeploymentSet({
		tenant,
		environment: campId,
		campId,
		plan: {
			schema: DEPLOYMENT_PLAN_SCHEMA,
			resources: [
				{
					name: "web",
					port: "compute",
					provider,
					deps: [],
					realizationParameters: { image },
				},
				{ name: "db", port: "kv", provider, deps: [] },
			],
			dependencyOrder: ["db", "web"],
			objective: image,
		},
		matches: [
			{
				resource: "web",
				providerId: provider,
				port: "compute",
				rationale: `${provider} matched compute`,
			},
			{
				resource: "db",
				providerId: provider,
				port: "kv",
				rationale: `${provider} matched kv`,
			},
		],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "pending",
			obligations: [],
			decidedAt: iso(0),
		},
	});
}

export class FakeResolver implements SetResolver {
	readonly providers = new Map<string, string>();
	readonly calls: { campId: string; intent: string }[] = [];
	refuse: string | undefined;
	constructor(private readonly desired: FakeDesired) {}
	async resolve(input: Parameters<SetResolver["resolve"]>[0], ctx: CdContext) {
		this.calls.push({ campId: input.campId, intent: input.intent });
		if (this.refuse)
			return {
				ok: false as const,
				reasons: [
					reason(this.refuse, "resolver refused", "fix topology", input.campId),
				],
			};
		const base = input.base ?? (await this.desired.current(input.campId));
		const before = base ? await this.desired.resolved(base) : undefined;
		const resolved =
			input.intent === "down"
				? createResolvedDeploymentSet({
						tenant: "acme",
						environment: input.campId,
						campId: input.campId,
						plan: {
							schema: DEPLOYMENT_PLAN_SCHEMA,
							resources: [],
							dependencyOrder: [],
							objective: "x",
						},
						matches: [],
						gatekeeper: {
							decision: "allow",
							gatekeeperDecisionId: "pending",
							obligations: [],
							decidedAt: iso(0),
						},
					})
				: resolvedFor(
						input.campId,
						this.providers.get(input.campId) ?? "alpha",
						input.freight.freightId,
					);
		let infrastructureDiff = [] as ReturnType<typeof diffResolvedSets>;
		if (input.sourceCampId) {
			const source = await this.desired.current(input.sourceCampId);
			if (source)
				infrastructureDiff = diffResolvedSets(
					await this.desired.resolved(source),
					resolved,
				);
		}
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
			infrastructureDiff,
			openedBy: `${ctx.principal.kind}:${ctx.principal.id}`,
			intent: input.intent,
		});
		return { ok: true as const, value: { resolved, delta } };
	}
}

export class FakeGate implements DeployGate {
	readonly calls: Parameters<DeployGate["evaluate"]>[0][] = [];
	effect: GateVerdict["effect"] = "allow";
	denyCamps = new Set<string>();
	window: WindowEvaluation = {
		open: true,
		rollbackAllowed: true,
		activeFreezes: [],
		overrides: [],
	};
	async evaluate(
		input: Parameters<DeployGate["evaluate"]>[0],
	): Promise<GateVerdict> {
		this.calls.push(input);
		const effect = this.denyCamps.has(input.delta.campId)
			? "deny"
			: this.effect;
		return {
			decisionId: `gate-${this.calls.length}`,
			effect,
			obligations: [],
			reasons:
				effect === "deny"
					? [
							reason(
								"policy-denied",
								"denied by policy",
								"change the declaration",
								input.delta.campId,
							),
						]
					: [],
			window: this.window,
		};
	}
}

export class FakeRollouts implements RolloutOrchestrator {
	readonly plans: RolloutPlanRecord[] = [];
	readonly rollbacks: string[] = [];
	status: RolloutStatus = "promoted";
	statusByCamp = new Map<string, RolloutStatus>();
	async plan(
		input: Parameters<RolloutOrchestrator["plan"]>[0],
		_ctx?: CdContext,
	): Promise<Outcome<RolloutPlanRecord>> {
		const plan = create(RolloutPlanRecordSchema, {
			rolloutId: `rollout-${this.plans.length + 1}`,
			promotionId: input.promotion.promotionId,
			strategy: input.promotion.strategy,
			stagePercents: [...input.stagePercents],
			targetCampIds: [...input.promotion.targetCampIds],
		});
		this.plans.push(plan);
		return { ok: true, value: plan };
	}
	async run(plan: RolloutPlanRecord): Promise<RolloutSnapshot> {
		return this.snapshot(plan.rolloutId);
	}
	private snapshot(rolloutId: string): RolloutSnapshot {
		const plan = this.plans.find((p) => p.rolloutId === rolloutId);
		const status =
			this.statusByCamp.get(plan?.targetCampIds[0] ?? "") ?? this.status;
		// SAFETY: test rollout ids are minted above.
		return {
			rolloutId: rolloutId as RolloutId,
			status,
			stageIndex: 0,
			percent: status === "promoted" ? 100 : 5,
			reasons: [],
		};
	}
	async rollback(
		input: Readonly<{ rolloutId: RolloutId }>,
	): Promise<RolloutSnapshot> {
		this.rollbacks.push(input.rolloutId);
		return {
			...this.snapshot(input.rolloutId),
			status: "rolled-back",
			percent: 0,
		};
	}
	async get(rolloutId: RolloutId) {
		return this.plans.some((p) => p.rolloutId === rolloutId)
			? this.snapshot(rolloutId)
			: undefined;
	}
	async tick() {}
}

export class FakeVerification implements VerificationEngine {
	readonly started: {
		campId: string;
		freightId: string;
		cohortAware: boolean;
	}[] = [];
	verdict = VerificationVerdict.PASS;
	verdictByCamp = new Map<string, VerificationVerdict>();
	pending = false;
	async start(
		input: Parameters<VerificationEngine["start"]>[0],
	): Promise<VerificationId> {
		this.started.push({
			campId: input.campId,
			freightId: input.freightId,
			cohortAware: input.cohortAware,
		});
		// SAFETY: test verification ids are minted here.
		return `verif-${this.started.length}` as VerificationId;
	}
	async get(id: VerificationId) {
		if (this.pending) return undefined;
		const index = Number(id.slice("verif-".length)) - 1;
		const started = this.started[index];
		if (!started) return undefined;
		return create(VerificationResultRecordSchema, {
			verificationId: id,
			campId: started.campId,
			freightId: started.freightId,
			verdict: this.verdictByCamp.get(started.campId) ?? this.verdict,
			reasons: [],
		});
	}
	async tick() {
		return [];
	}
}

export class FakeRunbooks implements RunbookExecutor {
	readonly runs: { path: string; args: JsonObject }[] = [];
	failing = new Set<string>();
	async run(input: Readonly<{ path: string; args: JsonObject }>) {
		this.runs.push(input);
		if (this.failing.has(input.path))
			return {
				ok: false as const,
				reasons: [
					reason("runbook-step-failed", `${input.path} failed`, "fix it"),
				],
			};
		return { ok: true as const, value: { steps: 1 } };
	}
}

export class FakeSuites implements VerifyPort {
	readonly runs: string[] = [];
	async run(input: Readonly<{ suite: string }>) {
		this.runs.push(input.suite);
		return { ok: true as const, value: {} };
	}
}

export class FakeNotify implements NotificationPort {
	readonly sent: { channel: string; subject: string; body: JsonObject }[] = [];
	async notify(
		input: Readonly<{ channel: string; subject: string; body: JsonObject }>,
	) {
		this.sent.push(input);
	}
}

/** CampPolicy per WP24's contract: INFORM sets the candidate, ENFORCE replaces the enforced digest. */
export class FakeCampPolicy implements CampPolicy {
	readonly bindings = new Map<string, PolicyBindingRecord>();
	readonly previous = new Map<string, string>();
	async binding(campId: CampId) {
		return this.bindings.get(campId);
	}
	async bind(
		input: Readonly<{
			campId: CampId;
			freight: FreightRecord;
			mode: PolicyMode;
			promotionId: string;
		}>,
	) {
		const current =
			this.bindings.get(input.campId) ??
			create(PolicyBindingRecordSchema, { campId: input.campId });
		const digestOf = input.freight.manifest?.declarationHash ?? "";
		const next = create(PolicyBindingRecordSchema, {
			...current,
			freightId: input.freight.freightId,
			promotionId: input.promotionId,
			...(input.mode === PolicyMode.ENFORCE
				? { enforcedRailDigest: digestOf, candidateRailDigest: "" }
				: { candidateRailDigest: digestOf }),
		});
		if (input.mode === PolicyMode.ENFORCE)
			this.previous.set(input.campId, current.enforcedRailDigest);
		this.bindings.set(input.campId, next);
		return { ok: true as const, value: next };
	}
	async restore(input: Readonly<{ campId: CampId }>) {
		const current =
			this.bindings.get(input.campId) ??
			create(PolicyBindingRecordSchema, { campId: input.campId });
		const next = create(PolicyBindingRecordSchema, {
			...current,
			enforcedRailDigest:
				this.previous.get(input.campId) ?? current.enforcedRailDigest,
			candidateRailDigest: "",
		});
		this.bindings.set(input.campId, next);
		return { ok: true as const, value: next };
	}
}
