// createCampReconciler (D5, I2–I5). One loop per Camp lease `cd:camp:<id>`:
//
//   1. claim (or renew) the fenced Camp lease; a held lease backs off with
//      jitter derived from hash(reconcilerId, camp);
//   2. read the feed; for the newest change fetch the resolved blob by digest
//      (a missing blob blocks with a reason);
//   3. observe first; converge only when the observation does not already
//      prove the Set (a crash between execute and observe therefore never
//      repeats a mutation: the resumed pass observes and stops);
//   4. report status (ReconcileStarted → StatusObserved → Converged /
//      ReconcileBlocked) and checkpoint only after convergence;
//   5. without a new change, re-observe periodically: drift is routed by the
//      DriftPolicy (reconcile, propose, ignore, escalate) with flapping
//      suppression and an oscillation guard.
//
// OBSERVE_ONLY Camps take the read path only; `mutate` is the single call
// site of Realizer.converge and refuses them (architecture-tested).
import { clone, create } from "@bufbuild/protobuf";
import type { PrincipalRef } from "@hobo/core";
import {
	CampManagement,
	type DepartureAction,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcilerMode,
	ReconcileStatus,
	SetOrigin,
	type SetRecord,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type {
	CampId,
	CampReconciler,
	CdBase,
	CdContext,
	DesiredStateChange,
	DriftPolicy,
	DriftRoute,
	OtelMetricPoint,
	RealizeInput,
	Realizer,
	ReconcilerId,
	ReconcilerLease,
	ReconcilerTransport,
	TelemetrySink,
} from "../ports.js";
import { backoffMs } from "./backoff.js";
import {
	type DeparturePlan,
	type DirectedRealizeInput,
	defaultDepartureAction,
	keptButMissing,
	planDeparture,
} from "./departure.js";
import { driftFindings, driftFingerprint } from "./drift.js";
import { messageOf, reason } from "./errors.js";
import {
	blockedObservation,
	isConvergedOn,
	type SanitizeInput,
	sanitizeObservation,
} from "./observation.js";

// public-contract: interval between re-observations of a converged Camp.
export const RECONCILE_OBSERVE_INTERVAL_MS = 60_000 as const;

// public-contract: metric names the reconciler emits through TelemetrySink.
export const RECONCILE_METRICS = Object.freeze({
	passes: "hobo.cd.reconcile.passes",
	duration: "hobo.cd.reconcile.duration",
	blocked: "hobo.cd.reconcile.blocked",
	converged: "hobo.cd.reconcile.converged",
	drift: "hobo.cd.reconcile.drift",
	leaseRefused: "hobo.cd.reconcile.lease_refused",
	mutations: "hobo.cd.reconcile.mutations",
} as const);

export type CampReconcilerDeps = CdBase & {
	readonly reconcilerId: ReconcilerId;
	readonly mode: ReconcilerMode;
	readonly campIds: readonly CampId[];
	readonly holderId: string;
	readonly transport: ReconcilerTransport;
	readonly realizer: Realizer;
	readonly drift: DriftPolicy;
	readonly telemetry: TelemetrySink;
	/** DepartureAction for a `depart` Set; default CD_DEFAULTS (ORPHAN_DATA). */
	readonly departureAction?: (
		campId: CampId,
		set: SetRecord,
	) => DepartureAction | Promise<DepartureAction>;
	/** Re-observation interval for a Camp with no new change. */
	readonly observeIntervalMs?: number;
	/** Remediations of one drift fingerprint before it escalates. */
	readonly maxRemediations?: number;
	/** Sleep between `run` passes; injectable for tests. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly principal?: PrincipalRef;
};

type CampMemory = {
	current?: DesiredStateChange;
	convergedSet?: SetRecord;
	lastObservation?: ReconcileObservationRecord;
	lastObservedAtMs?: number;
	lastDriftFingerprint?: string | undefined;
	remediations: Map<string, number>;
	attempt: number;
	nextAttemptAtMs: number;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

function withReasons(
	observation: ReconcileObservationRecord,
	reasons: readonly ReasonRecord[],
	status?: ReconcileStatus,
): ReconcileObservationRecord {
	const next = clone(ReconcileObservationRecordSchema, observation);
	next.reasons = [...next.reasons, ...reasons];
	if (status !== undefined) next.status = status;
	return next;
}

export function createCampReconciler(d: CampReconcilerDeps): CampReconciler {
	const memory = new Map<CampId, CampMemory>();
	const held = new Map<CampId, ReconcilerLease>();
	const observeIntervalMs =
		d.observeIntervalMs ?? RECONCILE_OBSERVE_INTERVAL_MS;
	const maxRemediations = d.maxRemediations ?? 1;
	const sleep = d.sleep ?? defaultSleep;
	const principal: PrincipalRef = d.principal ?? {
		kind: "service",
		id: `cd-reconciler:${d.reconcilerId}`,
	};

	function mem(campId: CampId): CampMemory {
		let entry = memory.get(campId);
		if (!entry) {
			entry = { remediations: new Map(), attempt: 0, nextAttemptAtMs: 0 };
			memory.set(campId, entry);
		}
		return entry;
	}

	async function metric(points: readonly OtelMetricPoint[]): Promise<void> {
		try {
			await d.telemetry.metrics(points);
		} catch {
			// Telemetry never fails a reconcile pass.
		}
	}

	function point(
		name: string,
		value: number,
		campId: CampId,
		extra: Readonly<Record<string, string>> = {},
		kind: OtelMetricPoint["kind"] = "counter",
		unit = "1",
	): OtelMetricPoint {
		return {
			name,
			kind,
			value,
			unit,
			atMs: d.now(),
			attributes: {
				"hobo.cd.camp": campId,
				"hobo.cd.reconciler": d.reconcilerId,
				"hobo.cd.reconciler.mode": ReconcilerMode[d.mode] ?? "UNSPECIFIED",
				...extra,
			},
		};
	}

	function sanitize(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		raw: ReconcileObservationRecord,
		input?: RealizeInput,
	): ReconcileObservationRecord {
		const request: SanitizeInput = {
			observation: raw,
			campId: lease.campId,
			reconcilerId: d.reconcilerId,
			fence: lease.fence,
			nowMs: d.now(),
			observeFields: change.observeFields,
			management: change.management,
		};
		return sanitizeObservation(
			input ? { ...request, resolved: input.resolved } : request,
		);
	}

	function realizeInput(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		resolved: RealizeInput["resolved"],
		ctx: CdContext,
	): RealizeInput {
		const base: RealizeInput = {
			campId: lease.campId,
			desired: change.set,
			resolved,
			reconcilerId: d.reconcilerId,
			fence: lease.fence,
			signal: ctx.signal ?? new AbortController().signal,
		};
		const previous = mem(lease.campId).convergedSet;
		return previous ? { ...base, previous } : base;
	}

	async function report(
		lease: ReconcilerLease,
		observation: ReconcileObservationRecord,
	): Promise<ReconcileObservationRecord> {
		const out = await d.transport.report(lease, observation);
		if (out.ok) return observation;
		return withReasons(observation, out.reasons, ReconcileStatus.BLOCKED);
	}

	async function guarded(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		call: () => Promise<ReconcileObservationRecord>,
		code: "realize-failed",
	): Promise<ReconcileObservationRecord> {
		try {
			return await call();
		} catch (error) {
			return blockedObservation({
				campId: lease.campId,
				setId: change.set.setId,
				reconcilerId: d.reconcilerId,
				fence: lease.fence,
				nowMs: d.now(),
				reasons: [reason(code, messageOf(error), lease.campId)],
			});
		}
	}

	/**
	 * The only path that calls Realizer.converge. OBSERVE_ONLY Camps are refused
	 * here, and the lease is re-checked before every mutation (I4).
	 */
	async function mutate(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		input: DirectedRealizeInput,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord | undefined> {
		if (change.management !== CampManagement.MANAGED) return undefined;
		const renewed = await d.transport.renew(lease);
		if (!renewed.ok) {
			held.delete(lease.campId);
			return blockedObservation({
				campId: lease.campId,
				setId: change.set.setId,
				reconcilerId: d.reconcilerId,
				fence: lease.fence,
				nowMs: d.now(),
				reasons: renewed.reasons,
			});
		}
		held.set(lease.campId, renewed.value);
		await report(
			lease,
			create(ReconcileObservationRecordSchema, {
				campId: lease.campId,
				setId: change.set.setId,
				reconcilerId: d.reconcilerId,
				fenceToken: lease.fence.toString(10),
				status: ReconcileStatus.CONVERGING,
				observedAt: new Date(d.now()).toISOString(),
			}),
		);
		await metric([point(RECONCILE_METRICS.mutations, 1, lease.campId)]);
		const raw = await guarded(
			lease,
			change,
			() => d.realizer.converge(input, ctx),
			"realize-failed",
		);
		return sanitize(lease, change, raw, input);
	}

	async function departure(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		input: RealizeInput,
		observed: ReconcileObservationRecord,
	): Promise<DeparturePlan | undefined> {
		if (change.set.origin !== SetOrigin.DEPARTURE) return undefined;
		const action = d.departureAction
			? await d.departureAction(lease.campId, change.set)
			: defaultDepartureAction();
		return planDeparture({
			action,
			observed: observed.resources,
			declared: input.resolved.plan.resources.map((r) => r.name),
		});
	}

	function departureOutcome(
		plan: DeparturePlan,
		after: ReconcileObservationRecord,
	): ReconcileObservationRecord {
		const missing = keptButMissing(plan, after);
		if (missing.length > 0)
			return withReasons(
				after,
				missing.map((name) =>
					reason(
						"departure-keep-violated",
						`realizer removed ${name}, which the DepartureAction keeps`,
						name,
					),
				),
				ReconcileStatus.BLOCKED,
			);
		return withReasons(
			after,
			plan.keep.map((name) =>
				reason(
					"departure-orphaned",
					`${name} kept on departure and recorded as orphaned`,
					name,
				),
			),
		);
	}

	async function checkpoint(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		observation: ReconcileObservationRecord,
	): Promise<ReconcileObservationRecord> {
		const committed = await d.transport.checkpoint(lease, change.position);
		if (!committed.ok)
			return withReasons(
				observation,
				committed.reasons,
				ReconcileStatus.BLOCKED,
			);
		return observation;
	}

	/** Handle the newest desired-state change for a leased Camp. */
	async function apply(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord> {
		const m = mem(lease.campId);
		m.current = change;
		const resolved = await d.transport.resolved(lease, change.set);
		if (!resolved.ok) {
			return report(
				lease,
				blockedObservation({
					campId: lease.campId,
					setId: change.set.setId,
					reconcilerId: d.reconcilerId,
					fence: lease.fence,
					nowMs: d.now(),
					reasons: resolved.reasons,
				}),
			);
		}
		const input = realizeInput(lease, change, resolved.value, ctx);
		const observed = sanitize(
			lease,
			change,
			await guarded(
				lease,
				change,
				() => d.realizer.observe(input, ctx),
				"realize-failed",
			),
			input,
		);
		m.lastObservedAtMs = d.now();
		// Without a successful observation nothing is applied: an unknown
		// target state is resolved by observation only (I5).
		if (observed.status === ReconcileStatus.BLOCKED)
			return report(lease, observed);
		if (change.management !== CampManagement.MANAGED) {
			// OBSERVE_ONLY: read, report and record drift; never apply.
			const findings = driftFindings(observed);
			const reported = await report(
				lease,
				findings.length === 0
					? observed
					: withReasons(observed, [
							reason(
								"drift-detected",
								`drift on ${findings.map((f) => `${f.resource}:${f.driftClass}`).join(", ")} (observe-only)`,
								lease.campId,
							),
						]),
			);
			return reported.status === ReconcileStatus.BLOCKED
				? reported
				: checkpoint(lease, change, reported);
		}
		const plan = await departure(lease, change, input, observed);
		// The target already runs this Set but diverged: that is drift, routed
		// by policy, never a silent re-apply.
		if (
			!plan &&
			observed.setId === change.set.setId &&
			driftFindings(observed).length > 0
		)
			return routeDrift(lease, change, input, observed, ctx);
		if (!plan && isConvergedOn(observed, change.set.setId)) {
			const reported = await report(lease, observed);
			m.convergedSet = change.set;
			return checkpoint(lease, change, reported);
		}
		const directed: DirectedRealizeInput = plan
			? { ...input, keep: plan.keep }
			: input;
		let after = await mutate(lease, change, directed, ctx);
		if (!after) return observed;
		if (plan) after = departureOutcome(plan, after);
		const reported = await report(lease, after);
		if (
			reported.status === ReconcileStatus.CONVERGED &&
			reported.setId === change.set.setId
		) {
			m.convergedSet = change.set;
			m.lastDriftFingerprint = undefined;
			return checkpoint(lease, change, reported);
		}
		return reported;
	}

	/** Periodic re-observation of the current Set: drift detection + routing. */
	async function reobserve(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord> {
		const m = mem(lease.campId);
		const resolved = await d.transport.resolved(lease, change.set);
		if (!resolved.ok)
			return report(
				lease,
				blockedObservation({
					campId: lease.campId,
					setId: change.set.setId,
					reconcilerId: d.reconcilerId,
					fence: lease.fence,
					nowMs: d.now(),
					reasons: resolved.reasons,
				}),
			);
		const input = realizeInput(lease, change, resolved.value, ctx);
		const observed = sanitize(
			lease,
			change,
			await guarded(
				lease,
				change,
				() => d.realizer.observe(input, ctx),
				"realize-failed",
			),
			input,
		);
		m.lastObservedAtMs = d.now();
		return routeDrift(lease, change, input, observed, ctx);
	}

	/**
	 * Drift detection and routing for a Camp that runs `change.set`: flapping
	 * suppression, DriftPolicy routing and the oscillation guard.
	 */
	async function routeDrift(
		lease: ReconcilerLease,
		change: DesiredStateChange,
		input: RealizeInput,
		observed: ReconcileObservationRecord,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord> {
		const m = mem(lease.campId);
		const findings = driftFindings(observed);
		if (findings.length === 0) {
			m.lastDriftFingerprint = undefined;
			const previous = m.lastObservation;
			if (
				previous &&
				previous.status === observed.status &&
				previous.setId === observed.setId
			)
				return observed;
			return report(lease, observed);
		}
		const fingerprint = driftFingerprint(change.set.setId, findings);
		// Flapping: the same drift as last pass, already handled, emits nothing.
		if (fingerprint === m.lastDriftFingerprint) return observed;
		m.lastDriftFingerprint = fingerprint;
		const detected = reason(
			"drift-detected",
			`drift on ${findings.map((f) => `${f.resource}:${f.driftClass}`).join(", ")}`,
			lease.campId,
		);
		await metric([
			point(RECONCILE_METRICS.drift, findings.length, lease.campId, {
				"hobo.cd.drift.fingerprint": fingerprint,
			}),
		]);
		if (change.management !== CampManagement.MANAGED)
			return report(lease, withReasons(observed, [detected]));
		let route: DriftRoute = await d.drift.route(observed, ctx);
		const prior = m.remediations.get(fingerprint) ?? 0;
		const oscillating = route === "reconcile" && prior >= maxRemediations;
		if (oscillating) route = "escalate";
		switch (route) {
			case "ignore":
				return report(
					lease,
					withReasons(observed, [
						detected,
						reason(
							"drift-ignored",
							"drift recorded; policy ignores it",
							lease.campId,
						),
					]),
				);
			case "propose":
				return report(
					lease,
					withReasons(observed, [
						detected,
						reason(
							"drift-proposed",
							"drift diff proposed for review",
							lease.campId,
						),
					]),
				);
			case "escalate":
				return report(
					lease,
					withReasons(
						observed,
						[
							detected,
							reason(
								"drift-escalated",
								oscillating
									? `drift ${fingerprint} recurred after ${prior} remediation(s)`
									: "drift routed to a human by policy",
								lease.campId,
							),
						],
						ReconcileStatus.BLOCKED,
					),
				);
			case "reconcile": {
				await report(lease, withReasons(observed, [detected]));
				m.remediations.set(fingerprint, prior + 1);
				const after = await mutate(lease, change, input, ctx);
				if (!after) return observed;
				const remediated =
					after.status === ReconcileStatus.CONVERGED
						? withReasons(after, [
								reason(
									"drift-reconciled",
									"re-applied the current Set",
									lease.campId,
								),
							])
						: after;
				// A confirmed reconverge makes the same fingerprint new drift next
				// time (the oscillation guard still bounds remediations).
				if (remediated.status === ReconcileStatus.CONVERGED)
					m.lastDriftFingerprint = undefined;
				return report(lease, remediated);
			}
		}
	}

	async function lease(
		campId: CampId,
	): Promise<ReconcilerLease | ReasonRecord[]> {
		const existing = held.get(campId);
		if (existing) {
			const renewed = await d.transport.renew(existing);
			if (renewed.ok) {
				held.set(campId, renewed.value);
				return renewed.value;
			}
			held.delete(campId);
		}
		const claimed = await d.transport.claim({
			reconcilerId: d.reconcilerId,
			campId,
			holderId: d.holderId,
			ttlMs: CD_DEFAULTS.leaseTtlMs,
		});
		if (!claimed.ok) return [...claimed.reasons];
		held.set(campId, claimed.value);
		return claimed.value;
	}

	async function pass(
		campId: CampId,
		ctx: CdContext,
		hold: boolean,
	): Promise<ReconcileObservationRecord> {
		const started = d.now();
		const m = mem(campId);
		const got = await lease(campId);
		if (Array.isArray(got)) {
			m.attempt += 1;
			m.nextAttemptAtMs =
				d.now() + backoffMs(d.reconcilerId, campId, m.attempt);
			await metric([point(RECONCILE_METRICS.leaseRefused, 1, campId)]);
			return blockedObservation({
				campId,
				setId: m.current?.set.setId ?? "",
				reconcilerId: d.reconcilerId,
				fence: 0n,
				nowMs: d.now(),
				reasons: got,
			});
		}
		const current = got;
		let observation: ReconcileObservationRecord | undefined;
		try {
			let newest: DesiredStateChange | undefined;
			for await (const change of d.transport.feed({
				lease: current,
				signal: ctx.signal ?? new AbortController().signal,
			}))
				newest = change;
			if (newest) observation = await apply(current, newest, ctx);
			else if (
				m.current &&
				(m.lastObservedAtMs === undefined ||
					d.now() - m.lastObservedAtMs >= observeIntervalMs)
			)
				observation = await reobserve(current, m.current, ctx);
			else
				observation =
					m.lastObservation ??
					create(ReconcileObservationRecordSchema, {
						campId,
						reconcilerId: d.reconcilerId,
						fenceToken: current.fence.toString(10),
						status: ReconcileStatus.UNSPECIFIED,
						observedAt: new Date(d.now()).toISOString(),
					});
		} finally {
			if (!hold) {
				held.delete(campId);
				await d.transport.release(current);
			}
		}
		m.lastObservation = observation;
		const blocked = observation.status === ReconcileStatus.BLOCKED;
		if (blocked) {
			m.attempt += 1;
			m.nextAttemptAtMs =
				d.now() + backoffMs(d.reconcilerId, campId, m.attempt);
		} else {
			m.attempt = 0;
			m.nextAttemptAtMs = 0;
		}
		const status = ReconcileStatus[observation.status] ?? "UNSPECIFIED";
		await metric([
			point(RECONCILE_METRICS.passes, 1, campId, {
				"hobo.cd.reconcile.status": status,
			}),
			point(
				RECONCILE_METRICS.duration,
				d.now() - started,
				campId,
				{},
				"histogram",
				"ms",
			),
			...(blocked
				? [
						point(RECONCILE_METRICS.blocked, 1, campId, {
							"hobo.cd.reason": observation.reasons.at(-1)?.code ?? "",
						}),
					]
				: []),
			...(observation.status === ReconcileStatus.CONVERGED
				? [point(RECONCILE_METRICS.converged, 1, campId)]
				: []),
		]);
		return observation;
	}

	function contextFor(signal: AbortSignal): CdContext {
		return { tenant: d.tenant, principal, now: d.now, signal };
	}

	return Object.freeze({
		reconcilerId: d.reconcilerId,
		mode: d.mode,
		async reconcileOnce(campId: CampId, ctx: CdContext) {
			return pass(campId, ctx, false);
		},
		async run(signal: AbortSignal): Promise<void> {
			const ctx = contextFor(signal);
			try {
				while (!signal.aborted) {
					for (const campId of d.campIds) {
						if (signal.aborted) break;
						if (d.now() < mem(campId).nextAttemptAtMs) continue;
						await pass(campId, ctx, true);
					}
					if (signal.aborted) break;
					// Wake every service tick: leases renew well inside their TTL and
					// backed-off Camps are skipped until their retry time.
					await sleep(CD_DEFAULTS.serviceTickMs, signal);
				}
			} finally {
				for (const lease of held.values()) await d.transport.release(lease);
				held.clear();
			}
		},
	} satisfies CampReconciler);
}
