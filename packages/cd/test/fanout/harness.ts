// Shared wiring for the WP23 fan-out tests: one controller over the fakes,
// and a driver that settles live promotions between ticks.
import { DepartureAction, type FanoutRecord, FanoutState, type PlacementDecisionRecord } from "../../src/_generated/cd_pb.js";
import { createFanoutController, type FanoutStartInput } from "../../src/fanout/index.js";
import type { CdContext, FanoutController, FreightId } from "../../src/ports.js";
import {
	asLedger,
	clock,
	context,
	FakeAuthorizer,
	FakeDesired,
	FakeFreight,
	FakeInventory,
	FakePromotions,
	FakeWindows,
	FREIGHT,
	MemoryEventStore,
	MINUTE,
	RecordingTelemetry,
	TENANT,
} from "./fakes.js";

export function harness(options: Readonly<{ leases?: boolean; holderId?: string }> = {}) {
	const time = clock();
	const store = new MemoryEventStore({ leases: options.leases ?? false });
	store.leaseNow = time.now;
	const freight = new FakeFreight();
	const promotions = new FakePromotions(freight, time.now);
	const inventory = new FakeInventory();
	const windows = new FakeWindows();
	const desired = new FakeDesired();
	const authorizer = new FakeAuthorizer();
	const telemetry = new RecordingTelemetry();
	const make = (holderId: string) =>
		createFanoutController({
			store,
			tenant: TENANT,
			now: time.now,
			freight: asLedger(freight),
			promotions,
			inventory,
			desired,
			windows,
			authorizer,
			telemetry,
			holderId,
		});
	const controller = make(options.holderId ?? "replica-a");
	const ctx: CdContext = context(time.now);
	return { time, store, freight, promotions, inventory, windows, desired, authorizer, telemetry, controller, make, ctx };
}

export type Harness = ReturnType<typeof harness>;

export function addCamps(h: Harness, decision: PlacementDecisionRecord): void {
	for (const group of decision.groups) for (const campId of group.campIds) h.inventory.add(campId);
}

export function startInput(
	decision: PlacementDecisionRecord,
	fanout: FanoutRecord,
	overrides: Partial<FanoutStartInput> = {},
): FanoutStartInput {
	return {
		pipeline: decision.pipeline,
		node: decision.node,
		freightId: FREIGHT,
		decision,
		fanout,
		departure: DepartureAction.ORPHAN_DATA,
		idempotencyKey: `start:${decision.decisionId}:${String(overrides.freightId ?? FREIGHT)}`,
		...overrides,
	};
}

/**
 * Tick until the fan-out settles: every live forward promotion is settled by
 * `outcome` (pass by default) and the clock moves past `min_success_ms`.
 */
export async function drive(
	h: Harness,
	outcome: (campId: string) => "pass" | "fail" | "hold" = () => "pass",
	options: Readonly<{ maxTicks?: number; controller?: FanoutController; onTick?: () => void }> = {},
): Promise<void> {
	const controller = options.controller ?? h.controller;
	for (let i = 0; i < (options.maxTicks ?? 400); i += 1) {
		await controller.tick(h.ctx);
		options.onTick?.();
		for (const promotion of h.promotions.live()) {
			const campId = promotion.targetCampIds[0] ?? "";
			const result = outcome(campId);
			if (result !== "hold") h.promotions.settle(campId, result);
		}
		h.time.advance(MINUTE + 1);
		const statuses = await controller.list();
		const settled = statuses.every(
			(s) => s.inFlight.length === 0 && (s.pending.length === 0 || s.state !== FanoutState.RUNNING),
		);
		if (settled && h.promotions.live().length === 0) {
			await controller.tick(h.ctx);
			return;
		}
	}
}

export const freightB = "sha256:bbbb" as FreightId;
