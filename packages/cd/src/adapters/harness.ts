// RolloutEngine over the Harness OpenDeliveryEngine (D8: its staged records are
// the only rollout state machine). A RolloutPlanRecord lowers to a staged
// RolloutPolicy: one stage per stage percent, each with the target Camps as
// ordered target groups (one Camp per group, so a stage exposes one Camp at a
// time — the smallest blast radius) and maxFailures 0.
//
// OpenDeliveryEngine keeps its journal in memory and mints random internal
// ids, so this adapter makes it durable and deterministic: every command
// (start / advance / hold / rollback) is appended to `cd-rollout-engine-<id>`
// BEFORE it is applied, and an engine is rebuilt after a restart by replaying
// those commands into a fresh OpenDeliveryEngine whose clock reads the recorded
// command times. The internal id never leaves this module; callers only see
// the plan's rollout id (I8).
import {
	fromJson,
	type JsonObject,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	FeatureFlagStore,
	OpenDeliveryEngine,
	type RolloutPolicy,
	type RolloutState,
} from "@hobo/identity";
import {
	type ReasonRecord,
	ReasonRecordSchema,
	type RolloutPlanRecord,
	RolloutPlanRecordSchema,
	type VerificationResultRecord,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import { WINDOW_CLOSED } from "../events.js";
import type {
	CdBase,
	CdContext,
	RolloutEngine,
	RolloutId,
	RolloutSnapshot,
	RolloutStatus,
} from "../ports.js";
import { ledgerType, ROLLOUT_LEDGER } from "../rollout/journal.js";
import { jsonOf, objectOf, text } from "../rollout/json.js";
import { reason } from "../rollout/reasons.js";

// public-contract: the engine command ledger (private to this adapter). Its
// type is the rollout ledger's `rollout.EngineCommanded`; the legacy
// `cd.rollout.EngineCommanded` is upcast on read (rollout/journal ledgerType).
export const HARNESS_LEDGER = Object.freeze({
	stream: (rolloutId: string) => `cd-rollout-engine-${rolloutId}`,
	commanded: ROLLOUT_LEDGER.engineCommanded,
} as const);

export type HarnessRolloutEngineDeps = CdBase &
	Readonly<{
		/**
		 * OpenFeature flag store the ramp mirrors its percent into (flag
		 * `cd.rollout.<id>`): exposure within a version (D7). Defaults to a
		 * store per rollout.
		 */
		flags?: FeatureFlagStore;
	}>;

type Command =
	| Readonly<{ command: "start"; plan: RolloutPlanRecord; atMs: number }>
	| Readonly<{
			command: "advance";
			campId: string;
			pass: boolean;
			atMs: number;
	  }>
	| Readonly<{ command: "hold"; hold: ReasonRecord; atMs: number }>
	| Readonly<{ command: "rollback"; why: string; atMs: number }>;

type Instance = {
	readonly engine: OpenDeliveryEngine;
	readonly clock: { atMs: number };
	internalId: string;
	hold: ReasonRecord | undefined;
	seq: number;
};

/** The staged policy for a plan: Camps as ordered target groups per stage. */
export function rolloutPolicy(plan: RolloutPlanRecord): RolloutPolicy {
	return {
		name: plan.rolloutId,
		flag: `cd.rollout.${plan.rolloutId}`,
		// Traffic moves only through Station cutover (D8); the flag carries the
		// ramp for in-version exposure. Never "gateway-weighted" (C5).
		traffic: "flag-only",
		// The orchestrator decides rollback from verification; never a health guess.
		autoRollback: false,
		stages: plan.stagePercents.map((percent) => ({
			percent,
			maxFailures: 0,
			groups: plan.targetCampIds.map((campId) => ({
				name: campId,
				targets: [campId],
				maxFailures: 0,
			})),
		})),
	};
}

function commandBody(command: Command): JsonObject {
	const at = new Date(command.atMs).toISOString();
	switch (command.command) {
		case "start":
			return {
				command: "start",
				plan: toJson(RolloutPlanRecordSchema, command.plan),
				at,
			};
		case "advance":
			return {
				command: "advance",
				campId: command.campId,
				pass: command.pass,
				at,
			};
		case "hold":
			return {
				command: "hold",
				reason: toJson(ReasonRecordSchema, command.hold),
				at,
			};
		case "rollback":
			return { command: "rollback", reason: command.why, at };
	}
}

function decodeCommand(value: JsonValue | undefined): Command | undefined {
	const data = objectOf(value);
	if (!data) return undefined;
	const atMs = Date.parse(text(data.at));
	if (!Number.isFinite(atMs)) return undefined;
	try {
		switch (text(data.command)) {
			case "start": {
				const plan = objectOf(data.plan);
				return plan
					? {
							command: "start",
							plan: fromJson(RolloutPlanRecordSchema, plan),
							atMs,
						}
					: undefined;
			}
			case "advance":
				return {
					command: "advance",
					campId: text(data.campId),
					pass: data.pass === true,
					atMs,
				};
			case "hold": {
				const hold = objectOf(data.reason);
				return hold
					? { command: "hold", hold: fromJson(ReasonRecordSchema, hold), atMs }
					: undefined;
			}
			case "rollback":
				return { command: "rollback", why: text(data.reason), atMs };
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

const STATUS = {
	running: "running",
	awaiting_approval: "awaiting-approval",
	halted: "halted",
	promoted: "promoted",
	rolled_back: "rolled-back",
	failed: "failed",
} as const satisfies Readonly<Record<RolloutState["status"], RolloutStatus>>;

function holdStatus(hold: ReasonRecord): RolloutStatus {
	if (
		hold.code === WINDOW_CLOSED ||
		hold.code === "rollout-rollback-window-closed"
	)
		return "awaiting-window";
	if (hold.code === "rollout-approval-pending") return "awaiting-approval";
	return "running";
}

function engineReasons(
	state: RolloutState,
	rolloutId: string,
): readonly ReasonRecord[] {
	if (state.status === "halted")
		return [
			reason(
				"rollout-verification-failed",
				`ramp engine halted: ${state.reason ?? "max-failures-exceeded"}`,
				rolloutId,
			),
		];
	if (state.status === "rolled_back")
		return [
			reason("rollback-requested", state.reason ?? "rolled back", rolloutId),
		];
	return [];
}

/** True when an advance for this Camp would change the engine (it is pending in the current group). */
function pending(instance: Instance, campId: string): boolean {
	return instance.engine.nextBatch(instance.internalId).includes(campId);
}

export function createHarnessRolloutEngine(
	d: HarnessRolloutEngineDeps,
): RolloutEngine {
	const instances = new Map<string, Instance>();
	const locks = new Map<string, Promise<void>>();

	function fresh(): Instance {
		const clock = { atMs: d.now() };
		const flags =
			d.flags ??
			new FeatureFlagStore({ now: () => new Date(clock.atMs).toISOString() });
		return {
			engine: new OpenDeliveryEngine({
				store: flags,
				now: () => new Date(clock.atMs).toISOString(),
			}),
			clock,
			internalId: "",
			hold: undefined,
			seq: 0,
		};
	}

	function apply(instance: Instance, command: Command): void {
		instance.clock.atMs = command.atMs;
		switch (command.command) {
			case "start": {
				if (instance.internalId !== "") return;
				instance.internalId = instance.engine.start(
					rolloutPolicy(command.plan),
				).id;
				return;
			}
			case "advance": {
				instance.hold = undefined;
				if (!pending(instance, command.campId)) return;
				instance.engine.reportOutcomes(instance.internalId, [
					{ target: command.campId, ok: command.pass },
				]);
				return;
			}
			case "hold": {
				instance.hold = command.hold;
				return;
			}
			case "rollback": {
				instance.hold = undefined;
				const state = instance.engine.get(instance.internalId);
				if (!state || state.status === "rolled_back") return;
				instance.engine.rollback(instance.internalId, { reason: command.why });
				return;
			}
		}
	}

	async function hydrate(rolloutId: string): Promise<Instance | undefined> {
		const cached = instances.get(rolloutId);
		if (cached) return cached;
		const events: EventEnvelope[] = [];
		for await (const event of d.store.read(HARNESS_LEDGER.stream(rolloutId)))
			events.push(event);
		if (events.length === 0) return undefined;
		const instance = fresh();
		for (const event of events) {
			instance.seq = event.seq;
			if (ledgerType(event.type) !== HARNESS_LEDGER.commanded) continue;
			const command = decodeCommand(jsonOf(event.data));
			if (command) apply(instance, command);
		}
		if (instance.internalId === "") return undefined;
		instances.set(rolloutId, instance);
		return instance;
	}

	async function record(
		rolloutId: string,
		instance: Instance,
		command: Command,
		ctx: CdContext,
	): Promise<void> {
		try {
			const result = await d.store.append(
				HARNESS_LEDGER.stream(rolloutId),
				[{ type: HARNESS_LEDGER.commanded, data: commandBody(command) }],
				{ expectedSeq: instance.seq, actor: ctx.principal, tenant: d.tenant },
			);
			instance.seq = result.appended.at(-1)?.seq ?? instance.seq;
		} catch (error) {
			// Another writer moved the stream: drop the cache; the next call rebuilds from the journal.
			instances.delete(rolloutId);
			throw error;
		}
		apply(instance, command);
	}

	function snapshot(rolloutId: string, instance: Instance): RolloutSnapshot {
		const state = instance.engine.get(instance.internalId);
		if (!state)
			return {
				// SAFETY: echo of the caller's rollout id.
				rolloutId: rolloutId as RolloutId,
				status: "failed",
				stageIndex: 0,
				percent: 0,
				reasons: [
					reason("rollout-unknown", "engine record missing", rolloutId),
				],
			};
		const live =
			state.status === "running" || state.status === "awaiting_approval";
		const hold = live ? instance.hold : undefined;
		return {
			// SAFETY: echo of the caller's rollout id.
			rolloutId: rolloutId as RolloutId,
			status: hold ? holdStatus(hold) : STATUS[state.status],
			stageIndex: state.stageIndex,
			percent: state.percent,
			reasons: hold ? [hold] : engineReasons(state, rolloutId),
		};
	}

	async function exclusive<T>(
		rolloutId: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const previous = locks.get(rolloutId) ?? Promise.resolve();
		let release = (): void => undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		locks.set(rolloutId, next);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (locks.get(rolloutId) === next) locks.delete(rolloutId);
		}
	}

	function unknown(rolloutId: string): RolloutSnapshot {
		return {
			// SAFETY: echo of the caller's rollout id.
			rolloutId: rolloutId as RolloutId,
			status: "failed",
			stageIndex: 0,
			percent: 0,
			reasons: [
				reason(
					"rollout-unknown",
					"no engine record for this rollout",
					rolloutId,
				),
			],
		};
	}

	return {
		start: (plan, ctx) =>
			exclusive(plan.rolloutId, async () => {
				const existing = await hydrate(plan.rolloutId);
				if (existing) return snapshot(plan.rolloutId, existing);
				const instance = fresh();
				await record(
					plan.rolloutId,
					instance,
					{ command: "start", plan, atMs: ctx.now() },
					ctx,
				);
				instances.set(plan.rolloutId, instance);
				return snapshot(plan.rolloutId, instance);
			}),
		advance: (rolloutId, result: VerificationResultRecord, ctx) =>
			exclusive(rolloutId, async () => {
				const instance = await hydrate(rolloutId);
				if (!instance) return unknown(rolloutId);
				if (!pending(instance, result.campId) && instance.hold === undefined)
					return snapshot(rolloutId, instance);
				await record(
					rolloutId,
					instance,
					{
						command: "advance",
						campId: result.campId,
						pass: result.verdict === VerificationVerdict.PASS,
						atMs: ctx.now(),
					},
					ctx,
				);
				return snapshot(rolloutId, instance);
			}),
		hold: (rolloutId, why, ctx) =>
			exclusive(rolloutId, async () => {
				const instance = await hydrate(rolloutId);
				if (!instance) return unknown(rolloutId);
				if (
					instance.hold?.code !== why.code ||
					instance.hold.message !== why.message
				)
					await record(
						rolloutId,
						instance,
						{ command: "hold", hold: why, atMs: ctx.now() },
						ctx,
					);
				return snapshot(rolloutId, instance);
			}),
		rollback: (rolloutId, why, ctx) =>
			exclusive(rolloutId, async () => {
				const instance = await hydrate(rolloutId);
				if (!instance) return unknown(rolloutId);
				if (instance.engine.get(instance.internalId)?.status !== "rolled_back")
					await record(
						rolloutId,
						instance,
						{ command: "rollback", why, atMs: ctx.now() },
						ctx,
					);
				return snapshot(rolloutId, instance);
			}),
		get: async (rolloutId) => {
			const instance = await hydrate(rolloutId);
			return instance ? snapshot(rolloutId, instance) : undefined;
		},
	};
}
