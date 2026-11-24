import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	AbortSealedSwitch,
	BackendRouting,
	CompleteSealedSwitch,
	decodeEpochMs,
	decodeEpochNumber,
	decodeFleetMemberName,
	decodeFleetRouteDecision,
	decodeNonNegativeMs,
	decodeNonNegativeUnitPriceMicros,
	decodeNonNegativeUsage,
	decodeRoutingHysteresisMarks,
	decodeTypedFleetAllowance,
	decodeUnitFraction,
	FailoverThresholdNotReached,
	FleetAssignment,
	FleetAssignmentInitialized,
	type FleetAssignmentState,
	FleetAssignmentView,
	FleetFailoverPromoted,
	FleetId,
	type FleetRouteDecision,
	FleetSwitchAborted,
	FleetSwitchAlreadyInFlight,
	FleetSwitchCompleted,
	FleetSwitchSealed,
	InitializeFleetAssignment,
	MinimumDwellNotReached,
	NonEmptyReason,
	NoSwitchInFlight,
	PromoteFailoverStandby,
	ProposeBudgetSwitch,
	SwitchTargetMatchesActive,
	type TypedFleetAllowance,
} from "../src/domain/index.js";

const story = Story.make(BackendRouting);

const EPOCH = (value: number) => decodeEpochMs(value);
const MS = (value: number) => decodeNonNegativeMs(value);
const UPSTASH = decodeFleetMemberName("upstash");
const TURSO = decodeFleetMemberName("turso");
const BLOB = decodeFleetMemberName("blob");

const DEFAULT_MARKS = decodeRoutingHysteresisMarks({
	switchAt: decodeUnitFraction(0.9),
	switchBackBelow: decodeUnitFraction(0.8),
	minDwellMs: MS(3_600_000),
	failoverAfterMs: MS(60_000),
});

describe("@hobo/backend-routing/domain BackendRouting (static invariants + BDD)", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(BackendRouting)).toEqual([]);
	});

	it("rejects flapping hysteresis marks, self-targeting routes, and invalid member names at the schema boundary", () => {
		expect(() =>
			decodeRoutingHysteresisMarks({
				switchAt: decodeUnitFraction(0.9),
				switchBackBelow: decodeUnitFraction(0.9),
				minDwellMs: MS(0),
				failoverAfterMs: MS(0),
			}),
		).toThrow();
		expect(() => decodeUnitFraction(1.5)).toThrow();
		expect(() => decodeUnitFraction(0)).toThrow();
		expect(() => decodeFleetMemberName("INVALID UPPER")).toThrow();
		expect(() =>
			decodeFleetRouteDecision({
				_tag: "Switch",
				active: UPSTASH,
				target: UPSTASH,
				reasons: [NonEmptyReason.make("invalid-self-switch")],
			}),
		).toThrow();

		const metered = decodeTypedFleetAllowance({
			_tag: "Metered",
			unit: "simple-operations",
			included: decodeNonNegativeUsage(0),
			meteredMicrosPerUnit: decodeNonNegativeUnitPriceMicros(0.4),
		});
		expect(metered._tag).toBe("Metered");
	});

	it("makes metered-without-price, hard-stop-with-price, target-on-keep, and target-on-active-state unrepresentable at compile time", () => {
		const checkAllowanceUnion = (allowance: TypedFleetAllowance) => {
			if (allowance._tag === "HardStop") {
				// @ts-expect-error HardStop allowance cannot carry a metered price
				const impossiblePrice = allowance.meteredMicrosPerUnit;
				return impossiblePrice;
			}
			if (allowance._tag === "Metered") {
				const requiredPrice: number = allowance.meteredMicrosPerUnit;
				return requiredPrice;
			}
			return allowance.included;
		};

		const checkRouteUnion = (route: FleetRouteDecision) => {
			if (route._tag === "Keep") {
				// @ts-expect-error Keep decision cannot carry a switch target
				const impossibleTarget = route.target;
				return impossibleTarget;
			}
			if (route._tag === "Switch") {
				// @ts-expect-error Planned Switch cannot carry a failover lossWindowMs
				const impossibleLoss = route.lossWindowMs;
				return { target: route.target, impossibleLoss };
			}
			return route;
		};

		const checkStateUnion = (state: FleetAssignmentState) => {
			if (state._tag === "Active") {
				// @ts-expect-error Active fleet cannot carry an in-flight switch target
				const impossibleTarget = state.target;
				return impossibleTarget;
			}
			return state;
		};

		expect(checkAllowanceUnion).toBeDefined();
		expect(checkRouteUnion).toBeDefined();
		expect(checkStateUnion).toBeDefined();
	});

	it("enforces dwell on preference moves, allows immediate exhaustion switches, guards sealed transitions, and enforces failover threshold", async () => {
		const fleetId = FleetId.make("cache-fleet-prod");
		const fleet = FleetAssignment.ref(fleetId);
		const prefReason = NonEmptyReason.make("preferred-free");
		const exhaustReason = NonEmptyReason.make("commands projected 90%");
		const abortReason = NonEmptyReason.make("copy-replica-timeout");
		const downReason = NonEmptyReason.make("writer-unreachable");

		await Effect.runPromise(
			story(
				Story.when(
					fleet,
					new InitializeFleetAssignment({
						active: BLOB,
						marks: DEFAULT_MARKS,
						nowMs: EPOCH(1_000),
					}),
				),
				Story.then(
					fleet,
					new FleetAssignmentInitialized({
						active: BLOB,
						marks: DEFAULT_MARKS,
						epoch: decodeEpochNumber(1),
						decidedAtMs: EPOCH(1_000),
					}),
				),
				Story.when(
					fleet,
					new CompleteSealedSwitch({ completedAtMs: EPOCH(2_000) }),
				),
				Story.rejected(new NoSwitchInFlight({ fleetId })),
				Story.when(
					fleet,
					new ProposeBudgetSwitch({
						target: BLOB,
						cause: "preference",
						reason: prefReason,
						nowMs: EPOCH(5_000_000),
					}),
				),
				Story.rejected(new SwitchTargetMatchesActive({ member: BLOB })),
				Story.when(
					fleet,
					new ProposeBudgetSwitch({
						target: UPSTASH,
						cause: "preference",
						reason: prefReason,
						nowMs: EPOCH(61_000),
					}),
				),
				Story.rejected(
					new MinimumDwellNotReached({
						nextAllowedAtMs: EPOCH(3_601_000),
						nowMs: EPOCH(61_000),
					}),
				),
				Story.when(
					fleet,
					new ProposeBudgetSwitch({
						target: UPSTASH,
						cause: "exhaustion",
						reason: exhaustReason,
						nowMs: EPOCH(62_000),
					}),
				),
				Story.then(
					fleet,
					new FleetSwitchSealed({
						from: BLOB,
						target: UPSTASH,
						cause: "exhaustion",
						reason: exhaustReason,
						sealedAtMs: EPOCH(62_000),
					}),
				),
				Story.when(
					fleet,
					new ProposeBudgetSwitch({
						target: TURSO,
						cause: "exhaustion",
						reason: exhaustReason,
						nowMs: EPOCH(63_000),
					}),
				),
				Story.rejected(
					new FleetSwitchAlreadyInFlight({ active: BLOB, target: UPSTASH }),
				),
				Story.when(fleet, new AbortSealedSwitch({ reason: abortReason })),
				Story.then(
					fleet,
					new FleetSwitchAborted({
						active: BLOB,
						abortedTarget: UPSTASH,
						reason: abortReason,
					}),
				),
				Story.when(
					fleet,
					new ProposeBudgetSwitch({
						target: UPSTASH,
						cause: "preference",
						reason: prefReason,
						nowMs: EPOCH(4_000_000),
					}),
				),
				Story.then(
					fleet,
					new FleetSwitchSealed({
						from: BLOB,
						target: UPSTASH,
						cause: "preference",
						reason: prefReason,
						sealedAtMs: EPOCH(4_000_000),
					}),
				),
				Story.when(
					fleet,
					new CompleteSealedSwitch({ completedAtMs: EPOCH(4_005_000) }),
				),
				Story.then(
					fleet,
					new FleetSwitchCompleted({
						previousActive: BLOB,
						active: UPSTASH,
						epoch: decodeEpochNumber(2),
						completedAtMs: EPOCH(4_005_000),
					}),
				),
				Story.when(
					fleet,
					new PromoteFailoverStandby({
						target: TURSO,
						failingForMs: MS(10_000),
						lossWindowMs: MS(5_000),
						reason: downReason,
						nowMs: EPOCH(4_015_000),
					}),
				),
				Story.rejected(
					new FailoverThresholdNotReached({
						failingForMs: MS(10_000),
						failoverAfterMs: MS(60_000),
					}),
				),
				Story.when(
					fleet,
					new PromoteFailoverStandby({
						target: TURSO,
						failingForMs: MS(120_000),
						lossWindowMs: MS(5_000),
						reason: downReason,
						nowMs: EPOCH(4_125_000),
					}),
				),
				Story.then(
					fleet,
					new FleetFailoverPromoted({
						failedMember: UPSTASH,
						active: TURSO,
						epoch: decodeEpochNumber(3),
						lossWindowMs: MS(5_000),
						reason: downReason,
						promotedAtMs: EPOCH(4_125_000),
					}),
				),
				Story.view(FleetAssignmentView, fleet, {
					_tag: "Active",
					epoch: decodeEpochNumber(3),
					active: TURSO,
					decidedAtMs: EPOCH(4_125_000),
				}),
			),
		);
	});
});
