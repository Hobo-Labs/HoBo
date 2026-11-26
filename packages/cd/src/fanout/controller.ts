// FanoutController (WP23; C18, D21, I20). One controller per fan-out holds
// lease `cd:fanout:<id>` and drives a `defineSaga` over `cd-fanout-<id>`:
// the forward step classifies in-flight Camps, schedules the next ones under
// `max_concurrency`, mandatory groups and the failure budget, and requests an
// ordinary per-Camp promotion for each (idempotency key `fanout:<id>:<camp>`);
// the compensation halts the run and, with `rollback_on_halt`, rolls back
// the failed Camps only (D12). Every transition is journaled before its side
// effect (write-ahead), so a crash resumes by re-folding and re-requesting
// idempotently, and the in-flight bound holds across restarts and replicas.
import { create, type JsonObject } from "@bufbuild/protobuf";
import type { ActorLeaseHost, EventInput } from "@hobo/core";
import { defineSaga } from "@hobo/events";
import {
	type CampStatusRecord,
	DepartureAction,
	FanoutState,
	type FanoutStatusRecord,
	PlacementCandidateRecordSchema,
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	PromotionState,
	type ReasonRecord,
	SelectorRecordSchema,
} from "../_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	CD_SUBSCRIPTIONS,
} from "../events.js";
import type {
	CampId,
	CampTopology,
	CdAction,
	CdContext,
	CdFactories,
	FanoutController,
	FanoutId,
	FreightId,
	Outcome,
	PromotionId,
	WindowEvaluation,
} from "../ports.js";
import { classify, eligibility } from "./classify.js";
import { dataResourcesOf } from "./data.js";
import {
	departedBody,
	haltedBody,
	parseFailoverFact,
	progressedBody,
	resumedBody,
	type SlotOutcome,
	startedBody,
	statusBody,
} from "./facts.js";
import {
	appendAt,
	counter,
	emit,
	eventsOf,
	gauge,
	isConflict,
	leaseRunner,
	msOf,
	principalName,
	readStream,
	reason,
	refuse,
	sha256Hex,
	streamsWith,
} from "./journal.js";
import { FANOUT_REASON, parseFanoutPlan } from "./policy.js";
import { budgetExceeded, failuresAgainstBudget, schedule } from "./schedule.js";
import {
	apply,
	type FanoutView,
	fold,
	isActive,
	isTerminal,
	type Slot,
	statusOf,
} from "./state.js";

// public-contract: saga name recorded in saga facts for every fan-out.
export const FANOUT_SAGA = "cd.fanout" as const;

export const FANOUT_METRIC = Object.freeze({
	started: "hobo.cd.fanout.started",
	transitions: "hobo.cd.fanout.transitions",
	inFlight: "hobo.cd.fanout.in_flight",
	halted: "hobo.cd.fanout.halted",
	completed: "hobo.cd.fanout.completed",
	rolledBack: "hobo.cd.fanout.rolled_back",
	departed: "hobo.cd.fanout.departed",
	refused: "hobo.cd.fanout.refused",
	stepError: "hobo.cd.fanout.step_errors",
	waiting: "hobo.cd.fanout.waiting",
} as const);

export type FanoutStartInput = Parameters<FanoutController["start"]>[0] & {
	/** The node's change windows (D10). Selector-matched windows apply regardless. */
	readonly windows?: readonly string[];
};

export type FanoutControllerDeps = Parameters<
	CdFactories["createFanoutController"]
>[0] & {
	/** Lease holder identity; defaults to a per-process id. */
	readonly holderId?: string;
	/** Lease TTL; defaults to CD_DEFAULTS.leaseTtlMs. */
	readonly leaseTtlMs?: number;
};

/** The saga records its own facts and dispatches no aggregate commands. */
const NO_DISPATCH: ActorLeaseHost = {
	acquire() {
		throw new Error(
			"the fan-out saga records its own facts and dispatches no aggregate commands",
		);
	},
};

/** Thrown by the saga step when the run must halt; the compensation halts it. */
class FanoutHalt extends Error {
	constructor(readonly reason: ReasonRecord) {
		super(reason.message);
		this.name = "FanoutHalt";
	}
}

export function fanoutIdFor(
	tenant: string,
	pipeline: string,
	node: string,
	idempotencyKey: string,
): FanoutId {
	// SAFETY: a FanoutId is minted only here, from a deterministic digest.
	return `fanout-${sha256Hex(tenant, pipeline, node, idempotencyKey).slice(0, 32)}` as FanoutId;
}

export function campKey(fanoutId: string, campId: string): string {
	return `fanout:${fanoutId}:${campId}`;
}

function asCamp(id: string): CampId {
	// SAFETY: Camp ids in fan-out records come from a recorded placement decision.
	return id as CampId;
}

function asFreight(id: string): FreightId {
	// SAFETY: the Freight id was checked usable against the ledger at start.
	return id as FreightId;
}

function asPromotion(id: string): PromotionId {
	// SAFETY: promotion ids are recorded from PromotionService results.
	return id as PromotionId;
}

function selectedCamps(decision: PlacementDecisionRecord): string[] {
	const fromGroups = decision.groups.flatMap((group) => group.campIds);
	return fromGroups.length > 0
		? fromGroups
		: decision.candidates.filter((c) => c.selected).map((c) => c.campId);
}

/**
 * The decision with completed failovers applied: each `from` Camp replaced
 * by its replacement (D21 late entry, D23). Pure over recorded facts.
 */
export function effectiveDecision(
	decision: PlacementDecisionRecord,
	moves: readonly Readonly<{ from: string; to: string }>[],
): PlacementDecisionRecord {
	if (moves.length === 0) return decision;
	const swap = (campId: string): string => {
		let current = campId;
		for (const move of moves) if (move.from === current) current = move.to;
		return current;
	};
	const out = create(PlacementDecisionRecordSchema, decision);
	out.groups = decision.groups.map((group) => ({
		...group,
		campIds: group.campIds.map(swap),
	}));
	const selected = new Set(selectedCamps(out));
	const candidates = decision.candidates.filter(
		(candidate) => !moves.some((move) => move.from === candidate.campId),
	);
	for (const campId of [...selected].sort()) {
		if (!candidates.some((candidate) => candidate.campId === campId))
			candidates.push(
				create(PlacementCandidateRecordSchema, { campId, selected: true }),
			);
	}
	out.candidates = candidates.map((candidate) =>
		moves.some((move) => move.from === candidate.campId)
			? { ...candidate, selected: false }
			: candidate,
	);
	return out;
}

export function createFanoutController(
	d: FanoutControllerDeps,
): FanoutController {
	const holderId =
		d.holderId ??
		`fanout-${process.pid}-${sha256Hex(String(d.now())).slice(0, 8)}`;
	const withLease = leaseRunner(
		d.store,
		d.tenant,
		holderId,
		d.leaseTtlMs ?? CD_DEFAULTS.leaseTtlMs,
	);

	const metric = (
		name: string,
		atMs: number,
		attributes: Readonly<Record<string, string>>,
		value = 1,
	) =>
		emit(d.telemetry, [
			counter(name, atMs, { tenant: d.tenant, ...attributes }, value),
		]);

	async function authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<readonly ReasonRecord[] | undefined> {
		const decision = await d.authorizer.authorize(action, subject, ctx);
		if (!decision.ok) return decision.reasons;
		if (decision.value.proposalOnly)
			return [
				reason(
					FANOUT_REASON.proposalOnly,
					`${action} by ${principalName(ctx.principal)} is proposal-only`,
					"have an operator or a granted service principal run the command",
					action,
				),
			];
		return undefined;
	}

	async function load(fanoutId: string): Promise<FanoutView | undefined> {
		return fold(await readStream(d.store, CD_STREAMS.fanout(fanoutId)));
	}

	async function all(): Promise<FanoutView[]> {
		const out: FanoutView[] = [];
		for (const streamId of await streamsWith(
			d.store,
			CD_EVENTS.FanoutStarted,
			d.tenant,
		)) {
			const view = fold(await readStream(d.store, streamId));
			if (view !== undefined) out.push(view);
		}
		return out;
	}

	/** Completed failovers per node, in journal order (D23 → D21 late entry). */
	async function moves(
		pipeline: string,
		node: string,
	): Promise<{ from: string; to: string }[]> {
		const out: { from: string; to: string }[] = [];
		for (const event of await eventsOf(
			d.store,
			CD_EVENTS.FailoverCompleted,
			d.tenant,
		)) {
			const fact = parseFailoverFact(event.data);
			if (fact === undefined) continue;
			const record = fact.failover;
			if (
				record.pipeline !== pipeline ||
				record.node !== node ||
				record.toCampId === ""
			)
				continue;
			out.push({ from: record.fromCampId, to: record.toCampId });
		}
		return out;
	}

	/** Appends facts at the view's head and applies them to the view. */
	async function write(
		view: FanoutView,
		ctx: CdContext,
		events: readonly EventInput[],
	): Promise<void> {
		const streamId = CD_STREAMS.fanout(view.fanoutId);
		let seq = view.seq;
		await appendAt({
			store: d.store,
			streamId,
			expectedSeq: seq,
			events,
			actor: ctx.principal,
			tenant: d.tenant,
		});
		for (const event of events) {
			seq += 1;
			apply(view, event.type, event.data, seq);
		}
	}

	async function transition(
		view: FanoutView,
		slot: Slot,
		outcome: SlotOutcome,
		ctx: CdContext,
		extra: Readonly<{
			promotionId?: string;
			reasons?: readonly ReasonRecord[];
			catchUp?: boolean;
		}> = {},
	): Promise<void> {
		const atMs = ctx.now();
		await write(view, ctx, [
			{
				type: CD_EVENTS.FanoutProgressed,
				data: progressedBody({
					campId: slot.campId,
					outcome,
					promotionId: extra.promotionId ?? slot.promotionId,
					catchUp: extra.catchUp ?? slot.catchUp,
					reasons: extra.reasons ?? [],
					atMs,
				}),
			},
		]);
		// The status snapshot rides on the next fact; consumers read statusOf.
		metric(FANOUT_METRIC.transitions, atMs, {
			pipeline: view.pipeline,
			node: view.node,
			outcome,
		});
	}

	async function halt(
		view: FanoutView,
		why: ReasonRecord,
		ctx: CdContext,
	): Promise<void> {
		if (view.state !== FanoutState.RUNNING) return;
		const atMs = ctx.now();
		await write(view, ctx, [
			{
				type: CD_EVENTS.FanoutHalted,
				data: haltedBody({
					reason: why,
					atMs,
					status: {
						...statusOf(view),
						state: FanoutState.HALTED,
						reasons: [why],
					},
				}),
			},
		]);
		metric(FANOUT_METRIC.halted, atMs, {
			pipeline: view.pipeline,
			node: view.node,
			reason: why.code,
		});
		if (view.plan.rollbackOnHalt)
			await rollbackCamps(
				view,
				[...view.slots.values()].filter((slot) => slot.state === "failed"),
				why.message,
				ctx,
			);
	}

	/** Roll back each Camp through the same gate (D12, I7). Refusals are recorded, never hidden. */
	async function rollbackCamps(
		view: FanoutView,
		slots: readonly Slot[],
		why: string,
		ctx: CdContext,
	): Promise<string[]> {
		const done: string[] = [];
		for (const slot of slots) {
			if (slot.rolledBack) {
				done.push(slot.campId);
				continue;
			}
			try {
				const result = await d.promotions.rollback(
					{
						campId: asCamp(slot.campId),
						reason: why,
						idempotencyKey: `${campKey(view.fanoutId, slot.campId)}:rollback`,
					},
					ctx,
				);
				if (result.ok) {
					await transition(view, slot, "rolled-back", ctx, {
						promotionId: result.value.promotionId,
					});
					done.push(slot.campId);
				} else {
					metric(FANOUT_METRIC.refused, ctx.now(), {
						pipeline: view.pipeline,
						node: view.node,
						reason: FANOUT_REASON.rollbackRefused,
					});
					view.reasons = [
						...view.reasons,
						reason(
							FANOUT_REASON.rollbackRefused,
							`rollback of Camp ${slot.campId} was refused: ${result.reasons.map((r) => r.code).join(", ")}`,
							result.reasons[0]?.remediation ??
								"roll the Camp back by hand through `hobo deploy rollback`",
							slot.campId,
						),
					];
				}
			} catch (error) {
				if (isConflict(error)) throw error;
				metric(FANOUT_METRIC.stepError, ctx.now(), {
					pipeline: view.pipeline,
					node: view.node,
					step: "rollback",
				});
			}
		}
		if (done.length > 0)
			metric(
				FANOUT_METRIC.rolledBack,
				ctx.now(),
				{ pipeline: view.pipeline, node: view.node },
				done.length,
			);
		return done;
	}

	async function qualifiedAt(
		view: FanoutView,
		campId: string,
	): Promise<number | undefined> {
		const records = await d.freight.qualifications(asFreight(view.freightId));
		const found = records.find(
			(q) =>
				q.campId === campId &&
				q.pipeline === view.pipeline &&
				q.node === view.node,
		);
		return found === undefined ? undefined : msOf(found.qualifiedAt);
	}

	/** Bind a write-ahead slot to its promotion (re-requesting is idempotent). */
	async function request(
		view: FanoutView,
		slot: Slot,
		ctx: CdContext,
	): Promise<void> {
		const result = await d.promotions.promote(
			{
				freightId: asFreight(view.freightId),
				targets: [asCamp(slot.campId)],
				idempotencyKey: campKey(view.fanoutId, slot.campId),
				pipeline: view.pipeline,
				node: view.node,
				// SAFETY: fan-out ids are minted by fanoutIdFor.
				fanoutId: view.fanoutId as FanoutId,
				intent: "promote",
			},
			ctx,
		);
		if (result.ok) {
			await transition(view, slot, "bound", ctx, {
				promotionId: result.value.promotionId,
			});
			return;
		}
		metric(FANOUT_METRIC.refused, ctx.now(), {
			pipeline: view.pipeline,
			node: view.node,
			reason: result.reasons[0]?.code ?? FANOUT_REASON.promotionRefused,
		});
		await transition(view, slot, "failed", ctx, {
			reasons:
				result.reasons.length > 0
					? result.reasons
					: [
							reason(
								FANOUT_REASON.promotionRefused,
								`promotion of Camp ${slot.campId} was refused`,
								"inspect the gate decision",
								slot.campId,
							),
						],
		});
	}

	async function classifyInFlight(
		view: FanoutView,
		ctx: CdContext,
	): Promise<void> {
		for (const slot of view.slots.values()) {
			if (slot.state !== "in-flight") continue;
			try {
				if (slot.promotionId === "") {
					await request(view, slot, ctx);
					continue;
				}
				const promotion = await d.promotions.get(asPromotion(slot.promotionId));
				const outcome = classify({
					campId: slot.campId,
					promotion,
					qualifiedAtMs: await qualifiedAt(view, slot.campId),
					requestedAtMs: slot.requestedAtMs,
					nowMs: ctx.now(),
					minSuccessMs: view.plan.minSuccessMs,
					progressDeadlineMs: view.plan.progressDeadlineMs,
				});
				if (outcome.kind === "in-flight") continue;
				await transition(
					view,
					slot,
					outcome.kind,
					ctx,
					outcome.kind === "succeeded" ? {} : { reasons: outcome.reasons },
				);
			} catch (error) {
				if (isConflict(error)) throw error;
				// A port threw (transient): nothing is decided; the next tick retries.
				metric(FANOUT_METRIC.stepError, ctx.now(), {
					pipeline: view.pipeline,
					node: view.node,
					step: "classify",
				});
			}
		}
	}

	async function topologies(
		campIds: readonly string[],
	): Promise<Map<string, CampTopology>> {
		const out = new Map<string, CampTopology>();
		if (campIds.length === 0) return out;
		const views = await d.inventory.list({
			selector: create(SelectorRecordSchema, { campIds: [...campIds] }),
		});
		for (const view of views) out.set(view.topology.campId, view.topology);
		return out;
	}

	async function windowFor(
		view: FanoutView,
		campId: string,
		topology: CampTopology | undefined,
		atMs: number,
	): Promise<WindowEvaluation> {
		return d.windows.evaluate({
			campId: asCamp(campId),
			labels: topology?.labels ?? {},
			envType: topology?.envType ?? "",
			windowNames: view.windows,
			atMs,
			intent: "promote",
		});
	}

	/** In catch-up, a Camp already carrying (or moving to) other promotions is left alone this tick. */
	async function catchUpBlocked(
		view: FanoutView,
		campId: string,
	): Promise<{ blocked: boolean; promotionId?: string }> {
		const history = await d.promotions.list({ campId: asCamp(campId) });
		const live = history.filter((p) => !TERMINAL_PROMOTION.has(p.state));
		const same = history.find(
			(p) =>
				p.freightId === view.freightId &&
				p.state !== PromotionState.SUPERSEDED &&
				p.state !== PromotionState.REJECTED &&
				p.state !== PromotionState.FAILED &&
				p.state !== PromotionState.ROLLED_BACK,
		);
		if (same !== undefined)
			return { blocked: false, promotionId: same.promotionId };
		return { blocked: live.length > 0 };
	}

	async function scheduleNext(
		view: FanoutView,
		ctx: CdContext,
		catchUp: boolean,
	): Promise<void> {
		const plan = schedule(view.plan, view.slots, {
			halted: view.state === FanoutState.HALTED,
			catchUp,
		});
		if (plan.candidates.length === 0 || plan.free === 0) return;
		const atMs = ctx.now();
		const topo = await topologies(plan.candidates);
		let free = plan.free;
		for (const campId of plan.candidates) {
			if (free <= 0) break;
			const slot = view.slots.get(campId);
			if (slot === undefined) continue;
			let status: CampStatusRecord | undefined;
			let window: WindowEvaluation;
			try {
				status = await d.inventory.status(asCamp(campId));
				window = await windowFor(view, campId, topo.get(campId), atMs);
			} catch (error) {
				if (isConflict(error)) throw error;
				metric(FANOUT_METRIC.stepError, atMs, {
					pipeline: view.pipeline,
					node: view.node,
					step: "eligibility",
				});
				continue;
			}
			const deferral = eligibility({ campId, status, window });
			if (deferral !== undefined) {
				if (slot.state === "pending")
					await transition(view, slot, "deferred", ctx, { reasons: deferral });
				continue;
			}
			let bindTo: string | undefined;
			if (catchUp || slot.state === "deferred") {
				const check = await catchUpBlocked(view, campId);
				if (check.blocked) continue;
				bindTo = check.promotionId;
			}
			// Write-ahead: the slot is in flight before the promotion exists.
			await transition(view, slot, "requested", ctx, {
				promotionId: bindTo ?? "",
				catchUp,
				reasons: [],
			});
			free -= 1;
			if (bindTo !== undefined) continue;
			try {
				await request(view, slot, ctx);
			} catch (error) {
				if (isConflict(error)) throw error;
				metric(FANOUT_METRIC.stepError, ctx.now(), {
					pipeline: view.pipeline,
					node: view.node,
					step: "request",
				});
			}
		}
	}

	async function complete(
		view: FanoutView,
		state: FanoutState,
		ctx: CdContext,
		reasons: readonly ReasonRecord[] = [],
	): Promise<void> {
		const atMs = ctx.now();
		const status: FanoutStatusRecord = {
			...statusOf(view),
			state,
			reasons: [...reasons],
		};
		await write(view, ctx, [
			{
				type: CD_EVENTS.FanoutCompleted,
				data: statusBody({ atMs, status, campIds: [], reasons }),
			},
		]);
		metric(FANOUT_METRIC.completed, atMs, {
			pipeline: view.pipeline,
			node: view.node,
			state: FanoutState[state] ?? "",
		});
	}

	/** D21 departure: Camps the new decision dropped get a `depart` Delta per DepartureAction. */
	async function depart(view: FanoutView, ctx: CdContext): Promise<void> {
		for (const campId of view.departing) {
			if (view.departed.has(campId)) continue;
			const action =
				view.departure === DepartureAction.UNSPECIFIED
					? DepartureAction.ORPHAN_DATA
					: view.departure;
			try {
				const current = await d.desired.current(asCamp(campId));
				const resolved =
					current === undefined ? undefined : await d.desired.resolved(current);
				const observed = await d.desired.status(asCamp(campId));
				const data = dataResourcesOf(resolved, observed);
				const everything = resolved?.plan.resources.map((r) => r.name) ?? [];
				const kept =
					action === DepartureAction.DELETE
						? []
						: action === DepartureAction.ORPHAN
							? [...everything].sort()
							: data;
				const result = await d.promotions.promote(
					{
						freightId: asFreight(view.freightId),
						targets: [asCamp(campId)],
						idempotencyKey: `${campKey(view.fanoutId, campId)}:depart`,
						pipeline: view.pipeline,
						node: view.node,
						intent: "depart",
					},
					ctx,
				);
				const atMs = ctx.now();
				await write(view, ctx, [
					{
						type: CD_EVENTS.CampDeparted,
						data: departedBody({
							fanoutId: view.fanoutId,
							campId,
							action,
							promotionId: result.ok ? result.value.promotionId : "",
							kept,
							reasons: result.ok
								? []
								: [
										...result.reasons,
										reason(
											FANOUT_REASON.departureRefused,
											`the depart Delta for Camp ${campId} was refused`,
											"depart the Camp with an approved `hobo deploy depart`; it keeps running meanwhile",
											campId,
										),
									],
							atMs,
						}),
					},
				]);
				metric(FANOUT_METRIC.departed, atMs, {
					pipeline: view.pipeline,
					node: view.node,
					action: DepartureAction[action] ?? "",
					outcome: result.ok ? "requested" : "refused",
				});
			} catch (error) {
				if (isConflict(error)) throw error;
				metric(FANOUT_METRIC.stepError, ctx.now(), {
					pipeline: view.pipeline,
					node: view.node,
					step: "depart",
				});
			}
		}
	}

	/** One saga pass for one fan-out. Caller holds the lease. */
	async function advance(
		view: FanoutView,
		ctx: CdContext,
		everyone: readonly FanoutView[],
	): Promise<void> {
		if (isTerminal(view)) return;
		const saga = defineSaga({
			name: FANOUT_SAGA,
			trigger: CD_EVENTS.FanoutStarted,
			step: async () => {
				if (
					view.state === FanoutState.RUNNING &&
					!(await d.freight.isUsable(asFreight(view.freightId)))
				)
					throw new FanoutHalt(
						reason(
							FANOUT_REASON.freightUnusable,
							`Freight ${view.freightId} is yanked or retired`,
							"promote newer Freight; yanked Freight never continues (I13)",
							view.freightId,
						),
					);
				await classifyInFlight(view, ctx);
				if (view.state === FanoutState.HALTED && view.plan.rollbackOnHalt)
					await rollbackCamps(
						view,
						[...view.slots.values()].filter(
							(slot) => slot.state === "failed" && !slot.rolledBack,
						),
						"fan-out halted",
						ctx,
					);
				const plan = schedule(view.plan, view.slots, {
					halted: false,
					catchUp: false,
				});
				if (view.state === FanoutState.RUNNING) {
					if (plan.mandatoryFailed)
						throw new FanoutHalt(
							reason(
								FANOUT_REASON.mandatoryFailed,
								"a Camp in a mandatory group failed; remaining groups never start",
								"fix the cause, then roll back the fan-out or promote newer Freight",
								view.fanoutId,
							),
						);
					if (budgetExceeded(view.plan, view.slots, view.baseline))
						throw new FanoutHalt(
							reason(
								FANOUT_REASON.budgetExceeded,
								`${failuresAgainstBudget(view.slots, view.baseline)} Camps failed; the budget allows ${view.plan.maxFailures}`,
								"inspect the failed Camps; resume (fanout.resume) after fixing the cause, or roll the fan-out back",
								view.fanoutId,
							),
						);
				}
				if (view.supersedeRequested && isActive(view) && plan.atGroupBoundary) {
					await complete(view, FanoutState.SUPERSEDED, ctx, [
						reason(
							FANOUT_REASON.superseded,
							"newer Freight superseded this fan-out at a group boundary",
							"none: the newer fan-out continues",
							view.fanoutId,
						),
					]);
					return;
				}
				const predecessor = everyone.find(
					(other) =>
						other.fanoutId !== view.fanoutId &&
						other.pipeline === view.pipeline &&
						other.node === view.node &&
						isActive(other) &&
						startedBefore(other, view),
				);
				if (predecessor !== undefined && view.state === FanoutState.RUNNING) {
					metric(FANOUT_METRIC.waiting, ctx.now(), {
						pipeline: view.pipeline,
						node: view.node,
						reason: FANOUT_REASON.awaitingSupersede,
					});
					return;
				}
				if (view.state === FanoutState.RUNNING) {
					await scheduleNext(view, ctx, false);
					if (
						schedule(view.plan, view.slots, { halted: false, catchUp: false })
							.complete
					) {
						await complete(view, FanoutState.COMPLETED, ctx);
					}
				}
				if (view.state === FanoutState.COMPLETED) {
					// Late entrants converge to the node's current qualified Freight:
					// only the newest fan-out of the node catches its Camps up.
					const newer = everyone.some(
						(other) =>
							other.fanoutId !== view.fanoutId &&
							other.pipeline === view.pipeline &&
							other.node === view.node &&
							startedBefore(view, other),
					);
					if (!newer) await scheduleNext(view, ctx, true);
					await depart(view, ctx);
				}
			},
			compensate: async (_event, _sagaCtx, cause) => {
				if (cause instanceof FanoutHalt) {
					await halt(view, cause.reason, ctx);
					return;
				}
				throw cause;
			},
		});
		await saga.run(view.trigger, { store: d.store, actorHost: NO_DISPATCH });
		emit(d.telemetry, [
			gauge(
				FANOUT_METRIC.inFlight,
				ctx.now(),
				{ tenant: d.tenant, pipeline: view.pipeline, node: view.node },
				[...view.slots.values()].filter((s) => s.state === "in-flight").length,
				"{camp}",
			),
		]);
	}

	function startedBefore(a: FanoutView, b: FanoutView): boolean {
		if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs < b.startedAtMs;
		return a.fanoutId < b.fanoutId;
	}

	async function drive(fanoutId: string, ctx: CdContext): Promise<void> {
		await withLease(CD_SUBSCRIPTIONS.fanout(fanoutId), async () => {
			const view = await load(fanoutId);
			if (view === undefined) return;
			try {
				await advance(view, ctx, await all());
			} catch (error) {
				if (!isConflict(error)) throw error;
				// Another writer moved the stream; the next tick re-folds.
			}
		});
	}

	async function command(
		fanoutId: FanoutId,
		action: CdAction,
		ctx: CdContext,
		run: (view: FanoutView) => Promise<Outcome<FanoutStatusRecord>>,
	): Promise<Outcome<FanoutStatusRecord>> {
		const denied = await authorize(action, { fanoutId }, ctx);
		if (denied !== undefined) return refuse(...denied);
		const held = await withLease(
			CD_SUBSCRIPTIONS.fanout(fanoutId),
			async () => {
				const view = await load(fanoutId);
				if (view === undefined)
					return refuse(
						reason(
							FANOUT_REASON.notFound,
							`fan-out ${fanoutId} does not exist`,
							"list fan-outs with `hobo deploy fanout list`",
							fanoutId,
						),
					);
				return run(view);
			},
		);
		if (!held.held)
			return refuse(
				reason(
					FANOUT_REASON.wrongState,
					`fan-out ${fanoutId} is being advanced by another controller`,
					"retry the command",
					fanoutId,
				),
			);
		return held.value;
	}

	const wrongState = (view: FanoutView, wanted: string) =>
		refuse(
			reason(
				FANOUT_REASON.wrongState,
				`fan-out ${view.fanoutId} is ${FanoutState[view.state] ?? "?"}; ${wanted}`,
				"list the fan-out and act on its current state",
				view.fanoutId,
			),
		);

	const controller: FanoutController = {
		async start(input: FanoutStartInput, ctx) {
			const atMs = ctx.now();
			const denied = await authorize(
				"promote",
				{
					pipeline: input.pipeline,
					node: input.node,
					freightId: input.freightId,
					fanout: true,
				},
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			const plan = parseFanoutPlan({
				pipeline: input.pipeline,
				node: input.node,
				decision: input.decision,
				fanout: input.fanout,
			});
			if (!plan.ok) {
				metric(FANOUT_METRIC.refused, atMs, {
					pipeline: input.pipeline,
					node: input.node,
					reason: plan.reasons[0]?.code ?? "",
				});
				return plan;
			}
			if (input.idempotencyKey === "")
				return refuse(
					reason(
						FANOUT_REASON.invalid,
						"idempotencyKey is empty",
						"pass a stable idempotency key",
						"idempotencyKey",
					),
				);
			const fanoutId = fanoutIdFor(
				d.tenant,
				input.pipeline,
				input.node,
				input.idempotencyKey,
			);
			const existing = await load(fanoutId);
			if (existing !== undefined)
				return { ok: true, value: statusOf(existing) };
			if (!(await d.freight.isUsable(input.freightId)))
				return refuse(
					reason(
						FANOUT_REASON.freightUnusable,
						`Freight ${input.freightId} is yanked, retired or unknown`,
						"promote usable Freight (I13)",
						input.freightId,
					),
				);
			const others = (await all()).filter(
				(v) => v.pipeline === input.pipeline && v.node === input.node,
			);
			const previous = [...others]
				.filter(
					(v) =>
						v.state === FanoutState.COMPLETED ||
						v.state === FanoutState.SUPERSEDED,
				)
				.sort((a, b) => (startedBefore(a, b) ? 1 : -1))[0];
			const nextCamps = new Set(plan.value.campIds);
			const departing =
				previous === undefined
					? []
					: selectedCamps(
							effectiveDecision(
								previous.decision,
								await moves(input.pipeline, input.node),
							),
						)
							.filter((campId) => !nextCamps.has(campId))
							.sort();
			const streamId = CD_STREAMS.fanout(fanoutId);
			const started = startedBody({
				fanoutId,
				pipeline: input.pipeline,
				node: input.node,
				freightId: input.freightId,
				decision: input.decision,
				fanout: input.fanout,
				departure: input.departure,
				windows: input.windows ?? [],
				idempotencyKey: input.idempotencyKey,
				departing,
				atMs,
			});
			try {
				await d.store.append(
					streamId,
					[
						{
							type: CD_EVENTS.FanoutStarted,
							data: started,
							meta: { idempotencyKey: input.idempotencyKey },
						},
					],
					{
						expectedSeq: 0,
						actor: ctx.principal,
						tenant: d.tenant,
					},
				);
			} catch (error) {
				if (!isConflict(error)) throw error;
				const raced = await load(fanoutId);
				if (raced !== undefined) return { ok: true, value: statusOf(raced) };
				throw error;
			}
			// Newer Freight supersedes active fan-outs on the node at their next group boundary.
			for (const other of others) {
				if (
					!isActive(other) ||
					other.freightId === input.freightId ||
					other.supersedeRequested
				)
					continue;
				await withLease(CD_SUBSCRIPTIONS.fanout(other.fanoutId), async () => {
					const fresh = await load(other.fanoutId);
					if (
						fresh === undefined ||
						!isActive(fresh) ||
						fresh.supersedeRequested
					)
						return;
					await write(fresh, ctx, [
						{
							type: CD_EVENTS.FanoutProgressed,
							data: progressedBody({
								campId: "",
								outcome: "supersede-requested",
								promotionId: "",
								catchUp: false,
								reasons: [],
								atMs,
							}),
						},
					]).catch(<E>(error: E) => {
						if (!isConflict(error)) throw error;
					});
				});
			}
			metric(FANOUT_METRIC.started, atMs, {
				pipeline: input.pipeline,
				node: input.node,
				strategy: plan.value.strategy,
			});
			await drive(fanoutId, ctx);
			const view = await load(fanoutId);
			if (view === undefined)
				throw new Error(`fan-out ${fanoutId} vanished after start`);
			return { ok: true, value: statusOf(view) };
		},

		async get(fanoutId) {
			const view = await load(fanoutId);
			return view === undefined ? undefined : statusOf(view);
		},

		async list(query) {
			const views = (await all())
				.filter(
					(v) =>
						(query?.pipeline === undefined || v.pipeline === query.pipeline) &&
						(query?.node === undefined || v.node === query.node),
				)
				.sort((a, b) => (startedBefore(a, b) ? 1 : -1));
			const limited =
				query?.limit === undefined ? views : views.slice(0, query.limit);
			return limited.map(statusOf);
		},

		async qualified(input) {
			const latest = (await all())
				.filter(
					(v) =>
						v.pipeline === input.pipeline &&
						v.node === input.node &&
						v.state === FanoutState.COMPLETED,
				)
				.sort((a, b) => (startedBefore(a, b) ? 1 : -1))[0];
			if (latest === undefined) return { qualifiedCampIds: [] };
			const applied = await moves(input.pipeline, input.node);
			const decision = effectiveDecision(latest.decision, applied);
			const members = new Set(selectedCamps(decision));
			const qualified = new Set(
				[...latest.slots.values()]
					.filter((slot) => slot.state === "succeeded")
					.map((slot) => slot.campId),
			);
			const ledger = await d.freight.qualifications(
				asFreight(latest.freightId),
			);
			for (const q of ledger)
				if (q.pipeline === input.pipeline && q.node === input.node)
					qualified.add(q.campId);
			return {
				decision,
				qualifiedCampIds: [...qualified]
					.filter((campId) => members.has(campId))
					.sort()
					.map(asCamp),
				stableFreightId: asFreight(latest.freightId),
			};
		},

		async halt(fanoutId, why, ctx) {
			return command(fanoutId, "fanout.halt", ctx, async (view) => {
				if (view.state !== FanoutState.RUNNING)
					return wrongState(view, "only a RUNNING fan-out can be halted");
				await halt(
					view,
					reason(
						FANOUT_REASON.operatorHalt,
						why,
						"resume or roll back the fan-out",
						principalName(ctx.principal),
					),
					ctx,
				);
				return { ok: true, value: statusOf(view) };
			});
		},

		async resume(fanoutId, ctx) {
			return command(fanoutId, "fanout.resume", ctx, async (view) => {
				if (view.state !== FanoutState.HALTED)
					return wrongState(view, "only a HALTED fan-out can be resumed");
				const atMs = ctx.now();
				const baseline = [...view.slots.values()].filter(
					(s) => s.state === "failed",
				).length;
				await write(view, ctx, [
					{
						type: CD_EVENTS.FanoutResumed,
						data: resumedBody({
							baseline,
							atMs,
							status: {
								...statusOf(view),
								state: FanoutState.RUNNING,
								reasons: [],
							},
						}),
					},
				]);
				metric(FANOUT_METRIC.transitions, atMs, {
					pipeline: view.pipeline,
					node: view.node,
					outcome: "resumed",
				});
				return { ok: true, value: statusOf(view) };
			});
		},

		async rollback(fanoutId, why, ctx) {
			return command(fanoutId, "fanout.rollback", ctx, async (view) => {
				if (isTerminal(view))
					return wrongState(view, "a terminal fan-out cannot be rolled back");
				const touched = [...view.slots.values()].filter(
					(s) =>
						s.state !== "pending" &&
						!(s.state === "deferred" && s.promotionId === ""),
				);
				const done = await rollbackCamps(view, touched, why, ctx);
				const atMs = ctx.now();
				const reasons = [
					reason(
						"fanout-rolled-back",
						why,
						"promote newer Freight when ready",
						principalName(ctx.principal),
					),
				];
				await write(view, ctx, [
					{
						type: CD_EVENTS.FanoutRolledBack,
						data: statusBody({
							atMs,
							campIds: done,
							reasons,
							status: {
								...statusOf(view),
								state: FanoutState.ROLLED_BACK,
								reasons,
							},
						}),
					},
				]);
				return { ok: true, value: statusOf(view) };
			});
		},

		async tick(ctx) {
			for (const view of await all()) {
				if (isTerminal(view)) continue;
				const pendingDepartures = view.departing.some(
					(campId) => !view.departed.has(campId),
				);
				const deferred = [...view.slots.values()].some(
					(s) => s.state === "deferred" || s.state === "in-flight",
				);
				if (
					view.state === FanoutState.COMPLETED &&
					!pendingDepartures &&
					!deferred
				)
					continue;
				await drive(view.fanoutId, ctx);
			}
		},
	};
	return controller;
}

const TERMINAL_PROMOTION: ReadonlySet<PromotionState> = new Set([
	PromotionState.PROMOTED,
	PromotionState.ROLLED_BACK,
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.SUPERSEDED,
]);
