import * as Schema from "effect/Schema";

export const FleetId = Schema.NonEmptyString.pipe(Schema.brand("FleetId"));
export type FleetId = typeof FleetId.Type;

export const FleetMemberName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
).pipe(Schema.brand("FleetMemberName"));
export type FleetMemberName = typeof FleetMemberName.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

export const FleetUsageUnitSchema = Schema.Literals([
	"operations",
	"compute-hours",
	"storage-bytes",
	"commands",
	"rows-read",
	"rows-written",
	"simple-operations",
	"advanced-operations",
]);
export type FleetUsageUnitSchema = typeof FleetUsageUnitSchema.Type;

export const FleetOfferTierSchema = Schema.Literals([
	"free",
	"prepaid",
	"payg",
]);
export type FleetOfferTierSchema = typeof FleetOfferTierSchema.Type;

export const SwitchCause = Schema.Literals([
	"preference",
	"exhaustion",
	"budget-cap",
]);
export type SwitchCause = typeof SwitchCause.Type;

export const NonNegativeMicros = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeMicros"));
export type NonNegativeMicros = typeof NonNegativeMicros.Type;

export const NonNegativeUnitPriceMicros = Schema.Finite.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeUnitPriceMicros"));
export type NonNegativeUnitPriceMicros = typeof NonNegativeUnitPriceMicros.Type;

export const NonNegativeUsage = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeUsage"));
export type NonNegativeUsage = typeof NonNegativeUsage.Type;

export const NonNegativeMs = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeMs"));
export type NonNegativeMs = typeof NonNegativeMs.Type;

export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
	Schema.brand("EpochMs"),
);
export type EpochMs = typeof EpochMs.Type;

export const EpochNumber = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("EpochNumber"));
export type EpochNumber = typeof EpochNumber.Type;

export const HysteresisFactor = Schema.Finite.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("HysteresisFactor"));
export type HysteresisFactor = typeof HysteresisFactor.Type;

export const UnitFraction = Schema.Finite.check(
	Schema.isGreaterThan(0),
	Schema.isLessThanOrEqualTo(1),
).pipe(Schema.brand("UnitFraction"));
export type UnitFraction = typeof UnitFraction.Type;

export const RoutingHysteresisMarks = Schema.Struct({
	switchAt: UnitFraction,
	switchBackBelow: UnitFraction,
	minDwellMs: NonNegativeMs,
	failoverAfterMs: NonNegativeMs,
})
	.check(
		Schema.makeFilter((marks) => marks.switchBackBelow < marks.switchAt, {
			title: "RoutingHysteresisMarks",
			description:
				"switchBackBelow must be strictly lower than switchAt to prevent flapping.",
		}),
	)
	.pipe(Schema.brand("RoutingHysteresisMarks"));
export type RoutingHysteresisMarks = typeof RoutingHysteresisMarks.Type;

export const HardStopAllowance = Schema.TaggedStruct("HardStop", {
	unit: FleetUsageUnitSchema,
	included: Schema.NullOr(NonNegativeUsage),
});

export const MeteredAllowance = Schema.TaggedStruct("Metered", {
	unit: FleetUsageUnitSchema,
	included: Schema.NullOr(NonNegativeUsage),
	meteredMicrosPerUnit: NonNegativeUnitPriceMicros,
});

export const UnknownOverageAllowance = Schema.TaggedStruct("UnknownOverage", {
	unit: FleetUsageUnitSchema,
	included: Schema.NullOr(NonNegativeUsage),
});

export const TypedFleetAllowance = Schema.Union([
	HardStopAllowance,
	MeteredAllowance,
	UnknownOverageAllowance,
]);
export type TypedFleetAllowance = typeof TypedFleetAllowance.Type;

export const KeepActiveRoute = Schema.TaggedStruct("Keep", {
	active: FleetMemberName,
	reasons: Schema.NonEmptyArray(NonEmptyReason),
});

export const HoldFleetRoute = Schema.TaggedStruct("Hold", {
	active: Schema.NullOr(FleetMemberName),
	reasons: Schema.NonEmptyArray(NonEmptyReason),
});

export const SwitchFleetRoute = Schema.TaggedStruct("Switch", {
	active: FleetMemberName,
	target: FleetMemberName,
	reasons: Schema.NonEmptyArray(NonEmptyReason),
}).check(
	Schema.makeFilter((route) => route.target !== route.active, {
		title: "SwitchFleetRoute",
		description: "Switch target must differ from the active member.",
	}),
);

export const FailoverFleetRoute = Schema.TaggedStruct("Failover", {
	active: FleetMemberName,
	target: FleetMemberName,
	lossWindowMs: Schema.NullOr(NonNegativeMs),
	reasons: Schema.NonEmptyArray(NonEmptyReason),
}).check(
	Schema.makeFilter((route) => route.target !== route.active, {
		title: "FailoverFleetRoute",
		description: "Failover target must differ from the active member.",
	}),
);

export const FleetRouteDecision = Schema.Union([
	KeepActiveRoute,
	HoldFleetRoute,
	SwitchFleetRoute,
	FailoverFleetRoute,
]);
export type FleetRouteDecision = typeof FleetRouteDecision.Type;

export const decodeFleetMemberName = Schema.decodeSync(FleetMemberName);
export const decodeNonNegativeMicros = Schema.decodeSync(NonNegativeMicros);
export const decodeNonNegativeUnitPriceMicros = Schema.decodeSync(
	NonNegativeUnitPriceMicros,
);
export const decodeNonNegativeUsage = Schema.decodeSync(NonNegativeUsage);
export const decodeNonNegativeMs = Schema.decodeSync(NonNegativeMs);
export const decodeEpochMs = Schema.decodeSync(EpochMs);
export const decodeEpochNumber = Schema.decodeSync(EpochNumber);
export const decodeHysteresisFactor = Schema.decodeSync(HysteresisFactor);
export const decodeUnitFraction = Schema.decodeSync(UnitFraction);
export const decodeRoutingHysteresisMarks = Schema.decodeSync(
	RoutingHysteresisMarks,
);
export const decodeTypedFleetAllowance = Schema.decodeSync(TypedFleetAllowance);
export const decodeFleetRouteDecision = Schema.decodeSync(FleetRouteDecision);
