import * as Schema from "effect/Schema";

export const DispatchCategory = Schema.Literals([
	"runner",
	"build-machine",
	"traffic-backend",
]);
export type DispatchCategory = typeof DispatchCategory.Type;

export const CATEGORY_DIMENSION_MAP = {
	runner: "runner.minutes",
	"build-machine": "build.minutes",
	"traffic-backend": "traffic.requests",
} as const satisfies Record<DispatchCategory, string>;

export type CategoryDimension<C extends DispatchCategory> =
	(typeof CATEGORY_DIMENSION_MAP)[C];

export const ProviderId = Schema.NonEmptyString.pipe(
	Schema.brand("ProviderId"),
);
export type ProviderId = typeof ProviderId.Type;

export const DispatchId = Schema.NonEmptyString.pipe(
	Schema.brand("DispatchId"),
);
export type DispatchId = typeof DispatchId.Type;

export const ReservationId = Schema.NonEmptyString.pipe(
	Schema.brand("ReservationId"),
);
export type ReservationId = typeof ReservationId.Type;

export const UsageEvidenceRef = Schema.NonEmptyString.pipe(
	Schema.brand("UsageEvidenceRef"),
);
export type UsageEvidenceRef = typeof UsageEvidenceRef.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

const SCOPED_ACCOUNT_PATTERN = /^(?:runner|build-machine|traffic-backend):.+$/u;

export const ScopedAccountId = Schema.String.check(
	Schema.isPattern(SCOPED_ACCOUNT_PATTERN),
).pipe(Schema.brand("ScopedAccountId"));
export type ScopedAccountId = typeof ScopedAccountId.Type;

export const RunnerAccountId = ScopedAccountId.check(
	Schema.isPattern(/^runner:.+$/u),
).pipe(Schema.brand("RunnerAccountId"));
export type RunnerAccountId = typeof RunnerAccountId.Type;

export const BuildMachineAccountId = ScopedAccountId.check(
	Schema.isPattern(/^build-machine:.+$/u),
).pipe(Schema.brand("BuildMachineAccountId"));
export type BuildMachineAccountId = typeof BuildMachineAccountId.Type;

export const TrafficBackendAccountId = ScopedAccountId.check(
	Schema.isPattern(/^traffic-backend:.+$/u),
).pipe(Schema.brand("TrafficBackendAccountId"));
export type TrafficBackendAccountId = typeof TrafficBackendAccountId.Type;

export type CategoryAccountIdMap = {
	readonly runner: RunnerAccountId;
	readonly "build-machine": BuildMachineAccountId;
	readonly "traffic-backend": TrafficBackendAccountId;
};

export type CategoryScopedAccountId<C extends DispatchCategory> =
	CategoryAccountIdMap[C];

export const decodeScopedAccountId = Schema.decodeSync(ScopedAccountId);
export const decodeRunnerAccountId = Schema.decodeSync(RunnerAccountId);
export const decodeBuildMachineAccountId = Schema.decodeSync(
	BuildMachineAccountId,
);
export const decodeTrafficBackendAccountId = Schema.decodeSync(
	TrafficBackendAccountId,
);

export function scopedAccountId(
	category: "runner",
	providerId: ProviderId,
): RunnerAccountId;
export function scopedAccountId(
	category: "build-machine",
	providerId: ProviderId,
): BuildMachineAccountId;
export function scopedAccountId(
	category: "traffic-backend",
	providerId: ProviderId,
): TrafficBackendAccountId;
export function scopedAccountId(
	category: DispatchCategory,
	providerId: ProviderId,
): ScopedAccountId;
export function scopedAccountId(
	category: DispatchCategory,
	providerId: ProviderId,
): ScopedAccountId {
	switch (category) {
		case "runner":
			return decodeRunnerAccountId(`runner:${providerId}`);
		case "build-machine":
			return decodeBuildMachineAccountId(`build-machine:${providerId}`);
		case "traffic-backend":
			return decodeTrafficBackendAccountId(`traffic-backend:${providerId}`);
	}
}

export const NonNegativeMicros = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeMicros"));
export type NonNegativeMicros = typeof NonNegativeMicros.Type;

export const PositiveUnits = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveUnits"));
export type PositiveUnits = typeof PositiveUnits.Type;

export const NonNegativeUnits = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeUnits"));
export type NonNegativeUnits = typeof NonNegativeUnits.Type;

export const NonNegativeSlots = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeSlots"));
export type NonNegativeSlots = typeof NonNegativeSlots.Type;

export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
	Schema.brand("EpochMs"),
);
export type EpochMs = typeof EpochMs.Type;

export const SafeSequence = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("SafeSequence"));
export type SafeSequence = typeof SafeSequence.Type;

export const ActiveReservationHold = Schema.Struct({
	units: PositiveUnits,
	freeUnits: NonNegativeUnits,
	paidUnits: NonNegativeUnits,
	reservedMicros: NonNegativeMicros,
	concurrencySlots: NonNegativeSlots,
})
	.check(
		Schema.makeFilter(
			(hold) =>
				hold.freeUnits + hold.paidUnits === hold.units &&
				hold.concurrencySlots <= 1,
			{
				title: "ActiveReservationHold",
				description:
					"Free plus paid units must equal reserved units and concurrency slots must be at most 1.",
			},
		),
	)
	.pipe(Schema.brand("ActiveReservationHold"));
export type ActiveReservationHold = typeof ActiveReservationHold.Type;

export const ReservationStatusTag = Schema.Literals([
	"Pending",
	"Running",
	"Confirmed",
	"Released",
	"Expired",
]);
export type ReservationStatusTag = typeof ReservationStatusTag.Type;

export const decodeNonNegativeMicros = Schema.decodeSync(NonNegativeMicros);
export const decodePositiveUnits = Schema.decodeSync(PositiveUnits);
export const decodeNonNegativeUnits = Schema.decodeSync(NonNegativeUnits);
export const decodeNonNegativeSlots = Schema.decodeSync(NonNegativeSlots);
export const decodeEpochMs = Schema.decodeSync(EpochMs);
export const decodeSafeSequence = Schema.decodeSync(SafeSequence);
export const decodeActiveReservationHold = Schema.decodeSync(
	ActiveReservationHold,
);
