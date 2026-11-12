// Orchestrator realizer (D6, WP7). Resource-graph changes of a Set go through
// `runOrchestrator` (ResourceActors under ActorHost leases, choreographed
// compensation) behind a workload-attested apply. Rebuilt from the deleted
// `@hobo/cloud` CD plane without its defects:
//   - C3: nothing is fabricated. No simulated outputs, no injected health,
//     no fixture attestor: the attestor, executor and broker are injected, and
//     an unattestable worker blocks with a typed reason.
//   - C4: a rollback Set is an ordinary Set. The realizer diffs the desired
//     resources against what it realized (its fenced ledger) and re-applies
//     exactly the changed nodes, so the predecessor Set is re-applied.
// Only changed nodes reconcile: unchanged resources are skipped, removed ones
// are destroyed in reverse order (except those the reconciler asks to keep on
// departure), and the ledger records the realized state only after the
// orchestrator reports the deployment deployed.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	destroyResource,
	type IacProvider,
	iacProgramFor,
	type OrchestratorDeps,
	type ResolvedDeploymentSet,
	type ResourcePlan,
	runOrchestrator,
} from "@hobo/cloud";
import type { EventStore, JsonObject, PrincipalRef } from "@hobo/core";
import {
	type AttestationDocument,
	type LaunchMeasurement,
	verifyWorkloadAttestation,
} from "@hobo/identity";
import {
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	type ResourceObservation,
	ResourceObservationSchema,
} from "../_generated/cd_pb.js";
import type { CdContext, RealizeInput, Realizer } from "../ports.js";
import { keepOf } from "../reconcile/departure.js";
import { messageOf, reason } from "../reconcile/errors.js";
import { stableJson } from "../reconcile/json.js";

// public-contract: private ledger stream and event of the orchestrator realizer.
export const ORCHESTRATOR_LEDGER = Object.freeze({
	stream: (campId: string) => `cd-realizer-graph-${campId}`,
	realized: "cd.realizer.GraphRealized",
} as const);

/** The host attestor shape `@hobo/identity` attestors implement. */
export type HostAttestor = Readonly<{
	createDocument(input: {
		launchMeasurement: LaunchMeasurement;
		claimed?: JsonObject;
	}): AttestationDocument;
	publicKeys(): readonly Readonly<{
		hostId: string;
		keyId: string;
		verificationKey: string;
	}>[];
}>;

export type OrchestratorRealizerDeps = Pick<
	OrchestratorDeps,
	"actorHost" | "executor" | "broker"
> & {
	/** The realizer's journal: deployment streams and its fenced ledger. */
	readonly store: EventStore;
	readonly tenant: string;
	readonly attestor: HostAttestor;
	readonly hostId: string;
	readonly isolationTier?: string;
	/** Drift detection: refresh each realized resource during observe. */
	readonly refresh?: Pick<IacProvider, "refresh">;
	readonly now: () => number;
	/** Lifetime of one apply attestation; default 5 minutes. */
	readonly attestationTtlMs?: number;
};

type LedgerEntry = Readonly<{
	hash: string;
	deploymentId: string;
	kind: string;
	plan: JsonObject;
}>;

type Ledger = Readonly<{
	setId: string;
	resources: Readonly<Record<string, LedgerEntry>>;
	order: readonly string[];
	seq: number;
}>;

const EMPTY_LEDGER: Ledger = Object.freeze({
	setId: "",
	resources: {},
	order: [],
	seq: 0,
});

/** Content hash of one resource node as Matching resolved it. */
export function resourceNodeHash(
	resolved: ResolvedDeploymentSet,
	resource: ResourcePlan,
): string {
	const match = resolved.matches.find((m) => m.resource === resource.name);
	const body = stableJson({
		name: resource.name,
		port: resource.port,
		provider: match?.providerId ?? resource.provider,
		deps: [...resource.deps].sort(),
		strategy: resource.strategy ?? "",
		region: resource.region ?? "",
		productId: resource.productId ?? "",
		realizationParameters: resource.realizationParameters ?? {},
	});
	return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** Changed, unchanged and removed nodes between a ledger and a resolved set. */
export function diffGraph(
	ledger: Pick<Ledger, "resources">,
	resolved: ResolvedDeploymentSet,
	keep: ReadonlySet<string> = new Set(),
): Readonly<{
	changed: readonly ResourcePlan[];
	unchanged: readonly string[];
	removed: readonly string[];
}> {
	const changed: ResourcePlan[] = [];
	const unchanged: string[] = [];
	const declared = new Set<string>();
	for (const resource of resolved.plan.resources) {
		declared.add(resource.name);
		const hash = resourceNodeHash(resolved, resource);
		if (ledger.resources[resource.name]?.hash === hash)
			unchanged.push(resource.name);
		else changed.push(resource);
	}
	const removed = Object.keys(ledger.resources)
		.filter((name) => !declared.has(name) && !keep.has(name))
		.sort();
	return Object.freeze({ changed, unchanged, removed });
}

function blocked(
	input: RealizeInput,
	reasons: readonly ReasonRecord[],
	setId = "",
): ReconcileObservationRecord {
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId,
		reconcilerId: input.reconcilerId,
		fenceToken: input.fence.toString(10),
		status: ReconcileStatus.BLOCKED,
		reasons: [...reasons],
	});
}

export function createOrchestratorRealizer(
	d: OrchestratorRealizerDeps,
): Realizer {
	const ttl = d.attestationTtlMs ?? 300_000;

	async function readLedger(campId: string): Promise<Ledger> {
		let out = EMPTY_LEDGER;
		for await (const event of d.store.read(
			ORCHESTRATOR_LEDGER.stream(campId),
		)) {
			if (event.type !== ORCHESTRATOR_LEDGER.realized) continue;
			// SAFETY: ledger events are written only by this adapter (writeLedger).
			const data = event.data as {
				setId: string;
				resources: Record<string, LedgerEntry>;
				order: string[];
			};
			out = {
				setId: data.setId,
				resources: data.resources,
				order: data.order,
				seq: event.seq,
			};
		}
		return out;
	}

	async function writeLedger(
		input: RealizeInput,
		previous: Ledger,
		resources: Record<string, LedgerEntry>,
		order: readonly string[],
		actor: PrincipalRef,
	): Promise<void> {
		await d.store.append(
			ORCHESTRATOR_LEDGER.stream(input.campId),
			[
				{
					type: ORCHESTRATOR_LEDGER.realized,
					data: { setId: input.desired.setId, resources, order: [...order] },
					meta: {
						idempotencyKey: `${input.campId}:${input.desired.setId}:${input.fence}`,
					},
				},
			],
			{
				expectedSeq: previous.seq,
				actor,
				tenant: d.tenant,
				fenceToken: input.fence,
			},
		);
	}

	function attest(
		input: RealizeInput,
		nowMs: number,
	): ReasonRecord | undefined {
		const runId = `${input.campId}:${input.desired.setId}:${input.fence}`;
		const launchMeasurement: LaunchMeasurement = {
			runId,
			tenant: d.tenant,
			parentPrincipal: {
				kind: "service",
				id: `cd-reconciler:${input.reconcilerId}`,
			},
			codeVersion: {
				digest: input.resolved.planHash,
				version: input.desired.setId,
			},
			componentImageDigest: input.resolved.contentHash,
			hostId: d.hostId,
			issuedAt: new Date(nowMs).toISOString(),
			expiresAt: new Date(nowMs + ttl).toISOString(),
			nonce: createHash("sha256").update(runId).digest("hex"),
			isolationTier: d.isolationTier ?? "in-process",
		};
		try {
			const document = d.attestor.createDocument({
				launchMeasurement,
				claimed: {
					tenant: d.tenant,
					setId: input.desired.setId,
					campId: input.campId,
				},
			});
			const verdict = verifyWorkloadAttestation(document, {
				knownImageDigests: [input.resolved.contentHash],
				hostPublicKeys: d.attestor.publicKeys(),
				now: new Date(nowMs).toISOString(),
			});
			if (verdict.state === "attested") return undefined;
			return reason("attestation-refused", verdict.reason, input.campId);
		} catch (error) {
			return reason("attestation-refused", messageOf(error), input.campId);
		}
	}

	async function observe(
		input: RealizeInput,
		_ctx: CdContext,
	): Promise<ReconcileObservationRecord> {
		const ledger = await readLedger(input.campId);
		const keep = keepOf(input);
		const diff = diffGraph(ledger, input.resolved, keep);
		const resources: ResourceObservation[] = [];
		let drifted = false;
		for (const name of Object.keys(ledger.resources).sort()) {
			const entry = ledger.resources[name];
			if (!entry) continue;
			let driftKind = "";
			if (d.refresh) {
				// SAFETY: the ledger stores the ResourcePlan JSON it realized.
				const plan = entry.plan as unknown as ResourcePlan;
				const report = await d.refresh.refresh(
					iacProgramFor(entry.deploymentId, plan, "preview", d.tenant),
				);
				if (report.drift) {
					driftKind = "modified";
					drifted = true;
				}
			}
			resources.push(
				create(ResourceObservationSchema, {
					resource: name,
					physicalId: `${entry.deploymentId}/${name}`,
					outputsHash: entry.hash,
					healthy: driftKind === "",
					driftKind,
					kind: entry.kind,
				}),
			);
		}
		const converged =
			ledger.setId !== "" &&
			diff.changed.length === 0 &&
			diff.removed.length === 0;
		return create(ReconcileObservationRecordSchema, {
			campId: input.campId,
			setId: converged ? input.desired.setId : ledger.setId,
			reconcilerId: input.reconcilerId,
			fenceToken: input.fence.toString(10),
			status: !converged
				? ReconcileStatus.CONVERGING
				: drifted
					? ReconcileStatus.DRIFTED
					: ReconcileStatus.CONVERGED,
			resources,
		});
	}

	return Object.freeze({
		observe,
		async converge(
			input: RealizeInput,
			ctx: CdContext,
		): Promise<ReconcileObservationRecord> {
			if (
				input.resolved.contentHash !== input.desired.contentHash ||
				input.resolved.campId !== input.campId
			)
				return blocked(input, [
					reason(
						"resolved-set-mismatch",
						`resolved set ${input.resolved.contentHash} for ${input.resolved.campId} does not match Set ${input.desired.setId}`,
						input.desired.setId,
					),
				]);
			// A newer lease holder already recorded realized state: stop before
			// any mutation (I4); the journal would refuse the ledger write anyway.
			const head = d.store.getStreamHead?.(
				ORCHESTRATOR_LEDGER.stream(input.campId),
			);
			if (head && head.ownerEpoch > input.fence)
				return blocked(input, [
					reason(
						"stale-fence",
						`ledger is fenced at ${head.ownerEpoch}, this pass holds ${input.fence}`,
						input.campId,
					),
				]);
			const refused = attest(input, ctx.now());
			if (refused) return blocked(input, [refused]);
			const actor: PrincipalRef = {
				kind: "service",
				id: `cd-reconciler:${input.reconcilerId}`,
			};
			const ledger = await readLedger(input.campId);
			const keep = keepOf(input);
			const diff = diffGraph(ledger, input.resolved, keep);
			const deploymentId = `cd.${input.campId}.${input.desired.setId}`;
			const next: Record<string, LedgerEntry> = { ...ledger.resources };
			try {
				if (diff.changed.length > 0) {
					const changedNames = new Set(diff.changed.map((r) => r.name));
					// Unchanged dependencies are already provisioned by an earlier Set.
					const subset = diff.changed.map((r) => ({
						...r,
						deps: r.deps.filter((dep) => changedNames.has(dep)),
					}));
					const result = await runOrchestrator(
						{
							store: d.store,
							actorHost: d.actorHost,
							executor: d.executor,
							broker: d.broker,
						},
						{
							...input.resolved.plan,
							resources: subset,
							dependencyOrder: input.resolved.plan.dependencyOrder.filter((n) =>
								changedNames.has(n),
							),
						},
						deploymentId,
						{ tenant: d.tenant, actor, correlationId: input.desired.setId },
					);
					if (result.status !== "deployed")
						return blocked(
							input,
							[
								reason(
									result.status === "waiting"
										? "realize-failed"
										: "realize-blocked",
									`orchestrator ${result.status}${result.compensation ? ` (${result.compensation.status})` : ""}`,
									input.campId,
								),
							],
							ledger.setId,
						);
					for (const resource of diff.changed)
						next[resource.name] = {
							hash: resourceNodeHash(input.resolved, resource),
							deploymentId,
							kind: resource.port,
							// SAFETY: a ResourcePlan is a JSON record (manifest-plan wire form).
							plan: JSON.parse(JSON.stringify(resource)) as JsonObject,
						};
				}
				const order = ledger.order.length > 0 ? ledger.order : [];
				const removeOrder = [...diff.removed].sort(
					(a, b) => order.indexOf(b) - order.indexOf(a),
				);
				for (const name of removeOrder) {
					const entry = ledger.resources[name];
					if (!entry) continue;
					// SAFETY: the ledger stores the ResourcePlan JSON it realized.
					const plan = entry.plan as unknown as ResourcePlan;
					const destroyed = await destroyResource(
						{
							store: d.store,
							actorHost: d.actorHost,
							executor: d.executor,
							broker: d.broker,
						},
						plan,
						{ deploymentId: entry.deploymentId, tenant: d.tenant, actor },
					);
					if (destroyed.kind === "failed")
						return blocked(
							input,
							[
								reason(
									"realize-failed",
									`destroy ${name}: ${destroyed.reason ?? "failed"}`,
									name,
								),
							],
							ledger.setId,
						);
					delete next[name];
				}
			} catch (error) {
				return blocked(
					input,
					[reason("realize-failed", messageOf(error), input.campId)],
					ledger.setId,
				);
			}
			const order = [
				...input.resolved.plan.dependencyOrder,
				...Object.keys(next).filter(
					(n) => !input.resolved.plan.dependencyOrder.includes(n),
				),
			];
			await writeLedger(input, ledger, next, order, actor);
			return observe(input, ctx);
		},
	} satisfies Realizer);
}
