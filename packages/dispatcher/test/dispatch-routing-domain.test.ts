import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	AccountHasActiveReservations,
	BudgetCapBelowLiabilities,
	BudgetCapExceeded,
	type BuildMachineAccountId,
	ConfigureDispatchAccount,
	ConfirmReservation,
	DispatchAccount,
	DispatchAccountConfigured,
	DispatchAccountView,
	DispatchReservationConfirmed,
	DispatchReservationReleased,
	DispatchReservationStarted,
	DispatchReserved,
	DispatchRouting,
	DuplicateReservation,
	decodeActiveReservationHold,
	decodeEpochMs,
	decodeNonNegativeMicros,
	decodeNonNegativeSlots,
	decodeNonNegativeUnits,
	decodePositiveUnits,
	decodeSafeSequence,
	decodeScopedAccountId,
	ExpirePendingReservations,
	NonEmptyReason,
	PendingReservationsExpired,
	ProviderId,
	ReleaseReservation,
	type ReservationEntry,
	ReservationId,
	ReservationNotConfirmable,
	ReservationNotReleasable,
	ReserveDispatch,
	type RunnerAccountId,
	StartReservation,
	scopedAccountId,
	selectDispatchCandidate,
	UsageEvidenceRef,
	UsageEvidenceRequired,
} from "../src/domain/index.js";

const story = Story.make(DispatchRouting);

const MICROS = (value: number) => decodeNonNegativeMicros(value);
const UNITS = (value: number) => decodeNonNegativeUnits(value);
const POS_UNITS = (value: number) => decodePositiveUnits(value);
const SLOTS = (value: number) => decodeNonNegativeSlots(value);
const EPOCH = (value: number) => decodeEpochMs(value);

describe("@hobo/dispatcher/domain DispatchRouting (static invariants + BDD)", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(DispatchRouting)).toEqual([]);
	});

	it("rejects over-restorable holds, negative micros, zero units, unsafe sequences, and unscoped accounts at the schema boundary", () => {
		expect(() => decodeNonNegativeMicros(-1)).toThrow();
		expect(() => decodeNonNegativeMicros(0.5)).toThrow();
		expect(() => decodePositiveUnits(0)).toThrow();
		expect(() => decodePositiveUnits(-2)).toThrow();
		expect(() => decodeSafeSequence(Number.MAX_SAFE_INTEGER + 1)).toThrow();
		expect(() => decodeSafeSequence(-1)).toThrow();
		expect(() => decodeScopedAccountId("unscoped-provider")).toThrow();
		expect(() =>
			decodeActiveReservationHold({
				units: POS_UNITS(2),
				freeUnits: UNITS(3),
				paidUnits: UNITS(0),
				reservedMicros: MICROS(0),
				concurrencySlots: SLOTS(1),
			}),
		).toThrow();
		expect(() =>
			decodeActiveReservationHold({
				units: POS_UNITS(2),
				freeUnits: UNITS(2),
				paidUnits: UNITS(0),
				reservedMicros: MICROS(0),
				concurrencySlots: SLOTS(2),
			}),
		).toThrow();
	});

	it("makes cross-category accounts, unbranded amounts, and terminal reservation holds unrepresentable at compile time", () => {
		const checkCategoryIsolation = () => {
			const runnerId: RunnerAccountId = scopedAccountId(
				"runner",
				ProviderId.make("provider-a"),
			);
			// @ts-expect-error RunnerAccountId cannot be assigned to BuildMachineAccountId
			const impossibleCrossCategory: BuildMachineAccountId = runnerId;
			return impossibleCrossCategory;
		};

		const checkTerminalHoldAbsent = (entry: ReservationEntry) => {
			if (entry._tag === "Released") {
				// @ts-expect-error Released reservation carries no releasable hold
				const impossibleHold = entry.hold;
				return impossibleHold;
			}
			if (entry._tag === "Confirmed") {
				// @ts-expect-error Confirmed reservation carries no releasable hold
				const impossibleHold = entry.hold;
				return impossibleHold;
			}
			return entry;
		};

		const checkRawNumbersRejected = () => {
			new ReserveDispatch({
				reservationId: ReservationId.make("res-raw"),
				// @ts-expect-error raw number is not PositiveUnits
				units: 1,
				// @ts-expect-error raw number is not NonNegativeMicros
				estimatedMicros: 100,
				expiresAtMs: null,
			});
		};

		expect(checkCategoryIsolation).toBeDefined();
		expect(checkTerminalHoldAbsent).toBeDefined();
		expect(checkRawNumbersRejected).toBeDefined();
	});

	it("selects deterministically with exact micro-dollars, category isolation, full estimate admission, and UTF-16 tie-break", () => {
		const providerA = ProviderId.make("provider-a");
		const providerB = ProviderId.make("provider-b");
		const runnerA = scopedAccountId("runner", providerA);
		const runnerB = scopedAccountId("runner", providerB);
		const buildA = scopedAccountId("build-machine", providerA);

		const exactCent = selectDispatchCandidate({
			category: "runner",
			units: POS_UNITS(1),
			estimatedMicros: MICROS(0),
			candidates: [
				{
					accountId: buildA,
					category: "build-machine",
					providerId: providerA,
					listUnitMicros: MICROS(0),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(100),
					rateHeadroom: UNITS(100),
					concurrencyHeadroom: SLOTS(10),
					budgetCapMicros: MICROS(1_000_000),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
				{
					accountId: runnerA,
					category: "runner",
					providerId: providerA,
					listUnitMicros: MICROS(200_000),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(0),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(300_000),
					spentMicros: MICROS(100_000),
					heldMicros: MICROS(0),
				},
			],
		});
		expect(exactCent._tag).toBe("Selected");
		if (exactCent._tag === "Selected") {
			expect(exactCent.winner.accountId).toBe(runnerA);
			expect(exactCent.winner.requiredMicros).toBe(200_000);
			expect(exactCent.excluded).toEqual([
				{
					_tag: "Excluded",
					accountId: buildA,
					providerId: providerA,
					reason: "category-mismatch",
				},
			]);
		}

		const forward = selectDispatchCandidate({
			category: "runner",
			units: POS_UNITS(1),
			estimatedMicros: MICROS(150_000),
			candidates: [
				{
					accountId: runnerB,
					category: "runner",
					providerId: providerB,
					listUnitMicros: MICROS(100_000),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(0),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(200_000),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
				{
					accountId: runnerA,
					category: "runner",
					providerId: providerA,
					listUnitMicros: MICROS(100_000),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(0),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(120_000),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
			],
		});
		expect(forward._tag).toBe("Selected");
		if (forward._tag === "Selected") {
			expect(forward.winner.providerId).toBe(providerB);
			expect(forward.winner.requiredMicros).toBe(150_000);
			expect(forward.excluded[0]?.reason).toBe("budget-cap-exceeded");
		}

		const tieForward = selectDispatchCandidate({
			category: "runner",
			units: POS_UNITS(1),
			estimatedMicros: MICROS(0),
			candidates: [
				{
					accountId: scopedAccountId("runner", ProviderId.make("v")),
					category: "runner",
					providerId: ProviderId.make("v"),
					listUnitMicros: MICROS(0),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(10),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(0),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
				{
					accountId: scopedAccountId("runner", ProviderId.make("w")),
					category: "runner",
					providerId: ProviderId.make("w"),
					listUnitMicros: MICROS(0),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(10),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(0),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
			],
		});
		const tieReverse = selectDispatchCandidate({
			category: "runner",
			units: POS_UNITS(1),
			estimatedMicros: MICROS(0),
			candidates: [
				{
					accountId: scopedAccountId("runner", ProviderId.make("w")),
					category: "runner",
					providerId: ProviderId.make("w"),
					listUnitMicros: MICROS(0),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(10),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(0),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
				{
					accountId: scopedAccountId("runner", ProviderId.make("v")),
					category: "runner",
					providerId: ProviderId.make("v"),
					listUnitMicros: MICROS(0),
					switchingMicros: MICROS(0),
					freeHeadroom: UNITS(10),
					rateHeadroom: UNITS(10),
					concurrencyHeadroom: SLOTS(2),
					budgetCapMicros: MICROS(0),
					spentMicros: MICROS(0),
					heldMicros: MICROS(0),
				},
			],
		});
		expect(tieForward).toEqual(tieReverse);
	});

	it("enforces hard budget caps, single release, running-settlement evidence, and atomic expiry through BDD stories", async () => {
		const runnerAccount = DispatchAccount.ref(
			scopedAccountId("runner", ProviderId.make("github")),
		);
		const resOne = ReservationId.make("res-1");
		const resTwo = ReservationId.make("res-2");
		const resThree = ReservationId.make("res-3");
		const resFour = ReservationId.make("res-4");
		const cancelReason = NonEmptyReason.make("job-cancelled");
		const evidence = UsageEvidenceRef.make("usage:run-42");

		await Effect.runPromise(
			story(
				Story.when(
					runnerAccount,
					new ConfigureDispatchAccount({
						listUnitMicros: MICROS(100_000),
						freeHeadroom: UNITS(1),
						rateHeadroom: UNITS(10),
						concurrencyHeadroom: SLOTS(3),
						budgetCapMicros: MICROS(250_000),
					}),
				),
				Story.then(
					runnerAccount,
					new DispatchAccountConfigured({
						listUnitMicros: MICROS(100_000),
						freeHeadroom: UNITS(1),
						rateHeadroom: UNITS(10),
						concurrencyHeadroom: SLOTS(3),
						budgetCapMicros: MICROS(250_000),
					}),
				),
				Story.when(
					runnerAccount,
					new ReserveDispatch({
						reservationId: resOne,
						units: POS_UNITS(2),
						estimatedMicros: MICROS(150_000),
						expiresAtMs: EPOCH(10_000),
					}),
				),
				Story.then(
					runnerAccount,
					new DispatchReserved({
						reservationId: resOne,
						hold: decodeActiveReservationHold({
							units: POS_UNITS(2),
							freeUnits: UNITS(1),
							paidUnits: UNITS(1),
							reservedMicros: MICROS(150_000),
							concurrencySlots: SLOTS(1),
						}),
						expiresAtMs: EPOCH(10_000),
						freeHeadroomAfter: UNITS(0),
						rateHeadroomAfter: UNITS(8),
						concurrencyHeadroomAfter: SLOTS(2),
						heldMicrosAfter: MICROS(150_000),
					}),
				),
				Story.when(
					runnerAccount,
					new ReserveDispatch({
						reservationId: resOne,
						units: POS_UNITS(1),
						estimatedMicros: MICROS(0),
						expiresAtMs: null,
					}),
				),
				Story.rejected(new DuplicateReservation({ reservationId: resOne })),
				Story.when(
					runnerAccount,
					new ReserveDispatch({
						reservationId: resTwo,
						units: POS_UNITS(2),
						estimatedMicros: MICROS(0),
						expiresAtMs: null,
					}),
				),
				Story.rejected(
					new BudgetCapExceeded({
						spentMicros: MICROS(0),
						heldMicros: MICROS(150_000),
						requiredMicros: MICROS(200_000),
						budgetCapMicros: MICROS(250_000),
					}),
				),
				Story.when(
					runnerAccount,
					new ReleaseReservation({
						reservationId: resOne,
						reason: cancelReason,
					}),
				),
				Story.then(
					runnerAccount,
					new DispatchReservationReleased({
						reservationId: resOne,
						reason: cancelReason,
						freeHeadroomAfter: UNITS(1),
						rateHeadroomAfter: UNITS(10),
						concurrencyHeadroomAfter: SLOTS(3),
						heldMicrosAfter: MICROS(0),
					}),
				),
				Story.when(
					runnerAccount,
					new ReleaseReservation({
						reservationId: resOne,
						reason: cancelReason,
					}),
				),
				Story.rejected(
					new ReservationNotReleasable({
						reservationId: resOne,
						status: "Released",
					}),
				),
				Story.when(
					runnerAccount,
					new ReserveDispatch({
						reservationId: resTwo,
						units: POS_UNITS(2),
						estimatedMicros: MICROS(100_000),
						expiresAtMs: null,
					}),
				),
				Story.then(
					runnerAccount,
					new DispatchReserved({
						reservationId: resTwo,
						hold: decodeActiveReservationHold({
							units: POS_UNITS(2),
							freeUnits: UNITS(1),
							paidUnits: UNITS(1),
							reservedMicros: MICROS(100_000),
							concurrencySlots: SLOTS(1),
						}),
						expiresAtMs: null,
						freeHeadroomAfter: UNITS(0),
						rateHeadroomAfter: UNITS(8),
						concurrencyHeadroomAfter: SLOTS(2),
						heldMicrosAfter: MICROS(100_000),
					}),
				),
				Story.when(
					runnerAccount,
					new StartReservation({ reservationId: resTwo }),
				),
				Story.then(
					runnerAccount,
					new DispatchReservationStarted({ reservationId: resTwo }),
				),
				Story.when(
					runnerAccount,
					new ReleaseReservation({
						reservationId: resTwo,
						reason: cancelReason,
					}),
				),
				Story.rejected(
					new ReservationNotReleasable({
						reservationId: resTwo,
						status: "Running",
					}),
				),
				Story.when(
					runnerAccount,
					new ConfirmReservation({
						reservationId: resTwo,
						settledMicros: MICROS(80_000),
						usageEvidenceRef: null,
					}),
				),
				Story.rejected(new UsageEvidenceRequired({ reservationId: resTwo })),
				Story.when(
					runnerAccount,
					new ConfirmReservation({
						reservationId: resTwo,
						settledMicros: MICROS(80_000),
						usageEvidenceRef: evidence,
					}),
				),
				Story.then(
					runnerAccount,
					new DispatchReservationConfirmed({
						reservationId: resTwo,
						settledMicros: MICROS(80_000),
						overrun: false,
						usageEvidenceRef: evidence,
						concurrencyHeadroomAfter: SLOTS(3),
						spentMicrosAfter: MICROS(80_000),
						heldMicrosAfter: MICROS(0),
					}),
				),
				Story.when(
					runnerAccount,
					new ConfirmReservation({
						reservationId: resTwo,
						settledMicros: MICROS(80_000),
						usageEvidenceRef: evidence,
					}),
				),
				Story.rejected(
					new ReservationNotConfirmable({
						reservationId: resTwo,
						status: "Confirmed",
					}),
				),
				Story.when(
					runnerAccount,
					new ReserveDispatch({
						reservationId: resThree,
						units: POS_UNITS(1),
						estimatedMicros: MICROS(0),
						expiresAtMs: EPOCH(5_000),
					}),
				),
				Story.then(
					runnerAccount,
					new DispatchReserved({
						reservationId: resThree,
						hold: decodeActiveReservationHold({
							units: POS_UNITS(1),
							freeUnits: UNITS(0),
							paidUnits: UNITS(1),
							reservedMicros: MICROS(100_000),
							concurrencySlots: SLOTS(1),
						}),
						expiresAtMs: EPOCH(5_000),
						freeHeadroomAfter: UNITS(0),
						rateHeadroomAfter: UNITS(7),
						concurrencyHeadroomAfter: SLOTS(2),
						heldMicrosAfter: MICROS(100_000),
					}),
				),
				Story.when(
					runnerAccount,
					new ReserveDispatch({
						reservationId: resFour,
						units: POS_UNITS(1),
						estimatedMicros: MICROS(0),
						expiresAtMs: EPOCH(6_000),
					}),
				),
				Story.rejected(
					new BudgetCapExceeded({
						spentMicros: MICROS(80_000),
						heldMicros: MICROS(100_000),
						requiredMicros: MICROS(100_000),
						budgetCapMicros: MICROS(250_000),
					}),
				),
				Story.when(
					runnerAccount,
					new ConfigureDispatchAccount({
						listUnitMicros: MICROS(100_000),
						freeHeadroom: UNITS(5),
						rateHeadroom: UNITS(10),
						concurrencyHeadroom: SLOTS(3),
						budgetCapMicros: MICROS(250_000),
					}),
				),
				Story.rejected(
					new AccountHasActiveReservations({
						accountId: scopedAccountId("runner", ProviderId.make("github")),
						activeCount: UNITS(1),
					}),
				),
				Story.when(
					runnerAccount,
					new ExpirePendingReservations({ nowMs: EPOCH(5_000) }),
				),
				Story.then(
					runnerAccount,
					new PendingReservationsExpired({
						nowMs: EPOCH(5_000),
						expiredReservationIds: [resThree],
						freeHeadroomAfter: UNITS(0),
						rateHeadroomAfter: UNITS(8),
						concurrencyHeadroomAfter: SLOTS(3),
						heldMicrosAfter: MICROS(0),
					}),
				),
				Story.when(
					runnerAccount,
					new ConfigureDispatchAccount({
						listUnitMicros: MICROS(100_000),
						freeHeadroom: UNITS(0),
						rateHeadroom: UNITS(8),
						concurrencyHeadroom: SLOTS(3),
						budgetCapMicros: MICROS(50_000),
					}),
				),
				Story.rejected(
					new BudgetCapBelowLiabilities({
						spentMicros: MICROS(80_000),
						heldMicros: MICROS(0),
						requestedCapMicros: MICROS(50_000),
					}),
				),
				Story.view(DispatchAccountView, runnerAccount, {
					_tag: "Configured",
					spentMicros: MICROS(80_000),
					heldMicros: MICROS(0),
					availableBudgetMicros: MICROS(170_000),
					activeReservationCount: UNITS(0),
					overrunSeen: false,
				}),
			),
		);
	});
});
