// SetResolver over the same planner path `hobo up` uses (`yard-client.ts`
// `pureplan`: `plan(bindle, config, registry)` from `@hobo/cloud`). Promote
// re-runs Matching per target Camp over the Freight's own declaration (D2);
// the bytes stay the Freight's, infrastructure may differ, and the
// difference against the source Camp is the Delta's `infrastructure_diff`.
//
// The resolved set returned here is a pre-gate candidate: its Gatekeeper
// field names the plan, not a decision. Promotion re-seals it with the real
// gate decision before `DeltaLedger.apply` (see `sealResolved`).
import { create } from "@bufbuild/protobuf";
import {
	createResolvedDeploymentSet,
	DEPLOYMENT_PLAN_SCHEMA,
	type MatchSelection,
	type PlanConfig,
	type PlannerRegistry,
	plan,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import {
	ChangeKind,
	type DeltaRecord,
	DeltaRecordSchema,
	type FreightRecord,
	type ResourceChange,
	ResourceChangeSchema,
	type SetRecord,
} from "../_generated/cd_pb.js";
import { DELTA_SCHEMA } from "../events.js";
import type {
	CampId,
	CdBase,
	CdContext,
	DeltaIntent,
	DesiredStateReader,
	Digest,
	Outcome,
	SetResolver,
} from "../ports.js";
import { previewSourceOf } from "../promotion/ids.js";
import {
	canonicalJson,
	digestOf,
	iso,
	type Mutable,
	principalName,
	sha256Hex,
} from "../promotion/journal.js";
import { reason } from "../promotion/reasons.js";

/** The declaration type the planner reads (`@hobo/bindles` ManifestV1). */
export type Declaration = Parameters<typeof plan>[0];

export type CampPlanning = Readonly<{
	/** Environment name recorded on the resolved set. */
	environment: string;
	/** Same config `pureplan` builds: region, placement, Yard binding, budget evidence. */
	config: Omit<PlanConfig, "deploymentId">;
}>;

export type PlanningDeps = CdBase & {
	readonly desired: DesiredStateReader;
	readonly registry: PlannerRegistry;
	/** The declaration the Freight's `declaration_hash` names. */
	readonly declaration: (
		freight: FreightRecord,
	) => Promise<Declaration | undefined>;
	/** Per-Camp planning inputs (WP18 builds them from @hobo/camps / @hobo/yards). */
	readonly camp: (campId: CampId) => Promise<CampPlanning | undefined>;
	/** Digest the build used for `declaration_hash`; defaults to canonical-JSON sha256. */
	readonly declarationDigest?: (declaration: Declaration) => Digest;
	/** Ports whose resources hold data and survive a `depart` (ORPHAN_DATA). */
	readonly dataPorts?: readonly string[];
};

// public-contract: refusal codes of the planning resolver.
export const PLANNING_REASON = Object.freeze({
	declarationMissing: "planning-declaration-missing",
	declarationMismatch: "planning-declaration-mismatch",
	campUnknown: "planning-camp-unknown",
	planRejected: "planning-plan-rejected",
	sourceUnresolvable: "planning-source-unresolvable",
} as const);

// public-contract: the default ports whose resources keep their data on `depart`.
export const DEFAULT_DATA_PORTS = Object.freeze([
	"kv",
	"sql",
	"document",
	"object-store",
	"blob",
	"queue",
	"stream",
	"vector",
	"cache",
] as const);

function resourceHash(resolved: ResolvedDeploymentSet, name: string): string {
	const resource = resolved.plan.resources.find((r) => r.name === name);
	const matches = resolved.matches.filter((m) => m.resource === name);
	return `sha256:${sha256Hex(canonicalJson({ resource, matches }))}`;
}

/**
 * Resource-level diff between two resolved sets, sorted by resource name: a
 * resource is updated when its plan node or its Matching selection changed.
 * The same rule the desired-state ledger checks a Delta's `changes` against.
 */
export function diffResolvedSets(
	before: ResolvedDeploymentSet | undefined,
	after: ResolvedDeploymentSet,
): ResourceChange[] {
	const names = new Set<string>([
		...(before?.plan.resources.map((r) => r.name) ?? []),
		...after.plan.resources.map((r) => r.name),
	]);
	const changes: ResourceChange[] = [];
	for (const name of [...names].sort()) {
		const was = before?.plan.resources.find((r) => r.name === name);
		const now = after.plan.resources.find((r) => r.name === name);
		const beforeHash = was && before ? resourceHash(before, name) : "";
		const afterHash = now ? resourceHash(after, name) : "";
		if (beforeHash === afterHash) continue;
		const node = now ?? was;
		const source = now ? after : before;
		changes.push(
			create(ResourceChangeSchema, {
				resource: name,
				kind: !was
					? ChangeKind.ADD
					: !now
						? ChangeKind.REMOVE
						: ChangeKind.UPDATE,
				provider:
					source?.matches.find((m) => m.resource === name)?.providerId ??
					node?.provider ??
					"",
				productId: node?.productId ?? "",
				beforeHash,
				afterHash,
			}),
		);
	}
	return changes;
}

/** Deterministic Delta id (never starts with `set_`). */
export function deltaIdFor(
	input: Readonly<{
		campId: string;
		freightId: string;
		intent: DeltaIntent;
		baseSetId: string;
		contentHash: string;
	}>,
): string {
	return `delta_${sha256Hex(canonicalJson(input)).slice(0, 24)}`;
}

/** Re-seal a resolved set with the gate decision that admitted it. */
export function sealResolved(
	resolved: ResolvedDeploymentSet,
	gate: Readonly<{
		decision: "allow" | "allow-degraded";
		decisionId: string;
		obligations: readonly string[];
		decidedAtMs: number;
	}>,
): ResolvedDeploymentSet {
	const input: Mutable<Parameters<typeof createResolvedDeploymentSet>[0]> = {
		tenant: resolved.tenant,
		environment: resolved.environment,
		campId: resolved.campId,
		plan: resolved.plan,
		matches: resolved.matches,
		gatekeeper: {
			decision: gate.decision,
			gatekeeperDecisionId: gate.decisionId,
			obligations: [...gate.obligations],
			decidedAt: iso(gate.decidedAtMs),
		},
		secretRefs: resolved.secretRefs,
		setId: resolved.setId,
	};
	if (resolved.progressive !== undefined)
		input.progressive = resolved.progressive;
	return createResolvedDeploymentSet(input);
}

function emptyResolved(
	tenant: string,
	environment: string,
	campId: string,
	objective: string,
): ResolvedDeploymentSet {
	return createResolvedDeploymentSet({
		tenant,
		environment,
		campId,
		plan: {
			schema: DEPLOYMENT_PLAN_SCHEMA,
			resources: [],
			dependencyOrder: [],
			objective,
		},
		matches: [],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "pending",
			obligations: [],
			decidedAt: iso(0),
		},
	});
}

export function createPlanningResolver(d: PlanningDeps): SetResolver {
	const declarationDigest =
		d.declarationDigest ?? ((value: Declaration) => digestOf(value));
	const dataPorts = new Set<string>(d.dataPorts ?? DEFAULT_DATA_PORTS);

	async function baseResolved(base: SetRecord | undefined) {
		return base ? d.desired.resolved(base) : undefined;
	}

	async function planFor(
		freight: FreightRecord,
		campId: CampId,
	): Promise<Outcome<ResolvedDeploymentSet>> {
		const source = previewSourceOf(campId);
		const declared = await d.camp(campId);
		// A preview Camp is planned with its source Camp's inputs (env.Cloned).
		const inherited = declared ?? (source ? await d.camp(source) : undefined);
		const camp =
			declared ??
			(inherited
				? { ...inherited, environment: `${inherited.environment}-preview` }
				: undefined);
		if (!camp)
			return {
				ok: false,
				reasons: [
					reason(
						PLANNING_REASON.campUnknown,
						`Camp ${campId} has no planning inputs`,
						"Declare the Camp in its Yard topology before promoting to it.",
						campId,
					),
				],
			};
		const declaration = await d.declaration(freight);
		if (!declaration)
			return {
				ok: false,
				reasons: [
					reason(
						PLANNING_REASON.declarationMissing,
						`declaration ${freight.manifest?.declarationHash ?? ""} of Freight ${freight.freightId} is not available`,
						"Restore the declaration blob the Freight names; promotion never rebuilds or substitutes it.",
						campId,
					),
				],
			};
		const digest = declarationDigest(declaration);
		if (digest !== freight.manifest?.declarationHash)
			return {
				ok: false,
				reasons: [
					reason(
						PLANNING_REASON.declarationMismatch,
						`declaration digest ${digest} differs from the Freight's ${freight.manifest?.declarationHash ?? ""}`,
						"The declaration store returned other bytes; restore the exact declaration (I1: promote, never rebuild).",
						campId,
					),
				],
			};
		const result = plan(
			declaration,
			{ ...camp.config, deploymentId: `${campId}:${freight.freightId}` },
			d.registry,
		);
		if (!result.ok)
			return {
				ok: false,
				reasons: [
					reason(
						PLANNING_REASON.planRejected,
						`Matching for Camp ${campId} rejected the declaration: ${result.reason}`,
						result.remediations.length > 0
							? result.remediations.map((r) => JSON.stringify(r)).join("; ")
							: "Register a provider for the unmatched resources in the Camp's Yard.",
						campId,
					),
				],
			};
		const matches: MatchSelection[] = result.decisions.map((decision) => ({
			resource: decision.resource,
			providerId: decision.providerId,
			port: decision.port,
			rationale: decision.rationale,
		}));
		return {
			ok: true,
			value: createResolvedDeploymentSet({
				tenant: d.tenant,
				environment: camp.environment,
				campId,
				plan: result.plan,
				matches,
				gatekeeper: {
					decision: "allow",
					gatekeeperDecisionId: `pending:${result.planHash}`,
					obligations: [],
					decidedAt: iso(0),
				},
			}),
		};
	}

	function withoutCompute(
		resolved: ResolvedDeploymentSet,
	): ResolvedDeploymentSet {
		const kept = resolved.plan.resources.filter((r) => dataPorts.has(r.port));
		const names = new Set(kept.map((r) => r.name));
		return createResolvedDeploymentSet({
			tenant: resolved.tenant,
			environment: resolved.environment,
			campId: resolved.campId,
			plan: {
				schema: DEPLOYMENT_PLAN_SCHEMA,
				resources: kept.map((r) => ({
					...r,
					deps: r.deps.filter((dep) => names.has(dep)),
				})),
				dependencyOrder: resolved.plan.dependencyOrder.filter((name) =>
					names.has(name),
				),
				objective: resolved.plan.objective,
			},
			matches: resolved.matches.filter((m) => names.has(m.resource)),
			gatekeeper: resolved.gatekeeper,
			secretRefs: resolved.secretRefs,
		});
	}

	return {
		async resolve(input, ctx: CdContext) {
			const base = input.base ?? (await d.desired.current(input.campId));
			const before = await baseResolved(base);
			let resolved: ResolvedDeploymentSet;
			if (input.intent === "down") {
				resolved = emptyResolved(
					d.tenant,
					before?.environment ?? input.campId,
					input.campId,
					before?.plan.objective ?? "min-cost",
				);
			} else if (input.intent === "depart") {
				resolved = before
					? withoutCompute(before)
					: emptyResolved(d.tenant, input.campId, input.campId, "min-cost");
			} else {
				const planned = await planFor(input.freight, input.campId);
				if (!planned.ok) return planned;
				resolved = planned.value;
			}
			const changes = diffResolvedSets(before, resolved);
			let infrastructureDiff: ResourceChange[] = [];
			if (input.sourceCampId && input.sourceCampId !== input.campId) {
				const sourceSet = await d.desired.current(input.sourceCampId);
				const source = sourceSet
					? await d.desired.resolved(sourceSet)
					: undefined;
				if (!source)
					return {
						ok: false,
						reasons: [
							reason(
								PLANNING_REASON.sourceUnresolvable,
								`source Camp ${input.sourceCampId} has no resolved Set to compare against`,
								"Promote from a Camp that has converged, or omit sourceCampId.",
								input.campId,
							),
						],
					};
				infrastructureDiff = diffResolvedSets(source, resolved);
			}
			const delta: DeltaRecord = create(DeltaRecordSchema, {
				schemaVersion: DELTA_SCHEMA,
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
				changes,
				infrastructureDiff,
				openedBy: principalName(ctx.principal),
				proposal: false,
				openedAt: iso(ctx.now()),
				intent: input.intent,
			});
			return { ok: true, value: { resolved, delta } };
		},
	};
}
