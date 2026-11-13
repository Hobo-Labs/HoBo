/**
 * O8: a claim cannot be used against an innocent device. The four rules of
 * §6.9 step 4 one by one (`checkClaim`), the verdicts the authority's
 * `report` needs when it re-checks with no ranking of its own, and the
 * dispatcher on the memory bus: forged, replayed and cross-fleet claims
 * naming a victim are deleted and the victim is never reported; a
 * signature-valid out-of-fleet claim is deleted and its signer reported once;
 * three early claims inside an hour are reported together.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ClaimSchema,
	DeviceClass,
	MemberKind,
	MemberState,
	ResidencyRuleSchema,
	Role,
	SandboxTier,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustClass,
	type WorkOffer,
	WorkOfferSchema,
} from "../../src/_generated/fleet_pb.js";
import { OBSERVATION_CONTEXT } from "../../src/contexts.js";
import {
	type MemberId,
	parseMemberId,
	parseWorkDigest,
} from "../../src/ids.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";
import { checkClaim, createDispatcher } from "../../src/work/index.js";
import {
	authorityKey,
	claimFor,
	device,
	FLEET,
	fleetRecord,
	iso,
	NOW,
	OTHER_FLEET,
	offer,
	openPolicy,
	registry,
	seedBus,
} from "./fixtures.js";
import { recorder, reports, testSource, upstream } from "./harness.js";

const STEP = 20_000;
const subjectOf = (work: WorkOffer) => ({
	fleet: FLEET,
	digest: parseWorkDigest(work.workDigest),
});

async function world() {
	const dispatcher = await device({ roles: [Role.DISPATCHER] });
	const victim = await device({ roles: [Role.EXECUTOR] });
	const outsider = await device({
		fleet: OTHER_FLEET,
		roles: [Role.EXECUTOR],
	});
	const work = offer(dispatcher.keys.memberId);
	const view = registry(
		[dispatcher.record, victim.record, outsider.record],
		[fleetRecord(), fleetRecord(openPolicy(), OTHER_FLEET)],
	);
	return { dispatcher, victim, outsider, work, view };
}

const context = (
	view: ReturnType<typeof registry>,
	ranked: readonly MemberId[] = [],
	nowMs = NOW,
) => ({ registry: view, ranked, nowMs, stepMs: STEP });

describe("checkClaim rule 1: garbage and replays are deleted and attributed to nobody", () => {
	it("a claim signed by its claimant for this offer at its turn is valid", async () => {
		const { victim, work, view } = await world();
		const claim = await claimFor(victim.keys, work);
		expect(await checkClaim(claim, subjectOf(work), work, context(view))).toBe(
			"valid",
		);
	});

	it("forged: another key signing a claim that names the victim", async () => {
		const { victim, outsider, work, view } = await world();
		const forged = await claimFor(victim.keys, work, {}, outsider.keys.sign);
		expect(await checkClaim(forged, subjectOf(work), work, context(view))).toBe(
			"discard",
		);
		const relabelled = create(SignedEnvelopeSchema, {
			...forged,
			keyId: `${victim.keys.memberId}#sign`,
		});
		expect(
			await checkClaim(relabelled, subjectOf(work), work, context(view)),
		).toBe("discard");
		const flipped = await claimFor(victim.keys, work);
		const bytes = flipped.payload.slice();
		bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
		expect(
			await checkClaim(
				create(SignedEnvelopeSchema, { ...flipped, payload: bytes }),
				subjectOf(work),
				work,
				context(view),
			),
		).toBe("discard");
	});

	it("replayed: the victim's genuine claim on another offer, dispatcher or expiry", async () => {
		const { dispatcher, victim, work, view } = await world();
		const earlier = offer(dispatcher.keys.memberId, { workKey: "job-0" });
		const replay = await claimFor(victim.keys, earlier);
		expect(await checkClaim(replay, subjectOf(work), work, context(view))).toBe(
			"discard",
		);
		const otherDispatcher = await claimFor(victim.keys, work, {
			dispatcher: victim.keys.memberId,
		});
		expect(
			await checkClaim(otherDispatcher, subjectOf(work), work, context(view)),
		).toBe("discard");
		const staleOffer = await claimFor(victim.keys, work, {
			offerExpiresAt: iso(NOW + 1),
		});
		expect(
			await checkClaim(staleOffer, subjectOf(work), work, context(view)),
		).toBe("discard");
	});

	it("cross-fleet: the victim's claim arriving on another fleet's subject", async () => {
		const { victim, work, view } = await world();
		const claim = await claimFor(victim.keys, work);
		expect(
			await checkClaim(
				claim,
				{ fleet: OTHER_FLEET, digest: parseWorkDigest(work.workDigest) },
				work,
				context(view),
			),
		).toBe("discard");
		const moved = await claimFor(victim.keys, work, { fleet: OTHER_FLEET });
		expect(await checkClaim(moved, subjectOf(work), work, context(view))).toBe(
			"discard",
		);
	});

	it("wrong context, an unknown signer, an undecodable payload or an unknown fleet", async () => {
		const { victim, work, view, dispatcher } = await world();
		const claim = await claimFor(victim.keys, work);
		const wrongContext = create(SignedEnvelopeSchema, {
			...claim,
			context: OBSERVATION_CONTEXT,
		});
		expect(
			await checkClaim(wrongContext, subjectOf(work), work, context(view)),
		).toBe("discard");
		const stranger = await device();
		expect(
			await checkClaim(
				await claimFor(stranger.keys, work),
				subjectOf(work),
				work,
				context(view),
			),
		).toBe("discard");
		expect(
			await checkClaim(
				create(SignedEnvelopeSchema, { ...claim, keyId: "nonsense" }),
				subjectOf(work),
				work,
				context(view),
			),
		).toBe("discard");
		const noFleets = registry([dispatcher.record, victim.record], []);
		expect(
			await checkClaim(claim, subjectOf(work), work, context(noFleets)),
		).toBe("discard");
	});
});

describe("checkClaim rule 2: what the claimant's own signature proves it may not hold", () => {
	it("an out-of-fleet executor is not entitled", async () => {
		const { outsider, work, view } = await world();
		const claim = await claimFor(outsider.keys, work);
		expect(await checkClaim(claim, subjectOf(work), work, context(view))).toBe(
			"not-entitled",
		);
	});

	it("a member that is not ACTIVE, not a device, or not an executor there", async () => {
		const { dispatcher, work } = await world();
		const cases = [
			await device({ state: MemberState.SUSPENDED }),
			await device({ kind: MemberKind.BACKEND }),
			await device({ roles: [Role.OBSERVER] }),
		];
		for (const claimant of cases) {
			const view = registry(
				[dispatcher.record, claimant.record],
				[fleetRecord()],
			);
			expect(
				await checkClaim(
					await claimFor(claimant.keys, work),
					subjectOf(work),
					work,
					context(view),
				),
			).toBe("not-entitled");
		}
	});

	it("a device on another platform, outside the residency rule, or claiming a tier too weak", async () => {
		const { dispatcher } = await world();
		const mac = await device({ os: "darwin" });
		const linuxWork = offer(dispatcher.keys.memberId, {
			needs: { platform: { os: "linux" } },
		});
		const residency = create(ResidencyRuleSchema, {
			allowedJurisdictions: ["eu"],
		});
		const usDevice = await device({ region: "us-east-1" });
		const euDevice = await device({ region: "eu-west-1" });
		const noRegion = await device({ region: "" });
		const personal = await device({ deviceClass: DeviceClass.PERSONAL });
		const view = registry(
			[
				dispatcher.record,
				mac.record,
				usDevice.record,
				euDevice.record,
				noRegion.record,
				personal.record,
			],
			[fleetRecord(openPolicy({ residency }))],
		);
		const verdict = async (
			claimant: Awaited<ReturnType<typeof device>>,
			work: WorkOffer,
			tier: SandboxTier = SandboxTier.S3_MICROVM,
		) =>
			checkClaim(
				await claimFor(claimant.keys, work, { sandboxTier: tier }),
				subjectOf(work),
				work,
				context(view),
			);
		expect(await verdict(mac, linuxWork)).toBe("not-entitled");
		const plain = offer(dispatcher.keys.memberId);
		expect(await verdict(usDevice, plain)).toBe("not-entitled");
		expect(await verdict(noRegion, plain)).toBe("not-entitled");
		expect(await verdict(euDevice, plain)).toBe("valid");
		// ORG work on a personal device needs S3; UNTRUSTED work never runs there.
		expect(await verdict(personal, plain, SandboxTier.S1_CONTAINER)).toBe(
			"not-entitled",
		);
		const fork = offer(dispatcher.keys.memberId, {
			trustClass: TrustClass.UNTRUSTED,
		});
		expect(await verdict(personal, fork)).toBe("not-entitled");
	});
});

describe("checkClaim rule 3: early by more than one rank", () => {
	it("on the dispatcher's ranking: one rank of tolerance, more is early", async () => {
		const { victim, work, view } = await world();
		const others = await Promise.all([device(), device(), device()]);
		const ranked = [
			...others.map((other) => other.keys.memberId),
			victim.keys.memberId,
		];
		// Rank 3 is due at queued + 60 s.
		const at = (ms: number) =>
			claimFor(victim.keys, work, { claimedAt: iso(NOW + ms) });
		expect(
			await checkClaim(
				await at(0),
				subjectOf(work),
				work,
				context(view, ranked, NOW),
			),
		).toBe("early");
		expect(
			await checkClaim(
				await at(39_000),
				subjectOf(work),
				work,
				context(view, ranked, NOW + 39_000),
			),
		).toBe("early");
		expect(
			await checkClaim(
				await at(40_000),
				subjectOf(work),
				work,
				context(view, ranked, NOW + 40_000),
			),
		).toBe("valid");
		// A claimed time in the reader's future does not buy a later turn.
		expect(
			await checkClaim(
				await at(60_000),
				subjectOf(work),
				work,
				context(view, ranked, NOW + 1_000),
			),
		).toBe("early");
	});

	it("with no ranking (the authority's re-check), the claimant's own signed rank is its turn", async () => {
		const { victim, work, view } = await world();
		const early = await claimFor(victim.keys, work, {
			rank: 3,
			claimedAt: iso(NOW + 1_000),
		});
		// The authority checks later; the signed time is what counts.
		expect(
			await checkClaim(
				early,
				subjectOf(work),
				work,
				context(view, [], NOW + 3_600_000),
			),
		).toBe("early");
		const onTime = await claimFor(victim.keys, work, {
			rank: 3,
			claimedAt: iso(NOW + 60_000),
		});
		expect(
			await checkClaim(
				onTime,
				subjectOf(work),
				work,
				context(view, [], NOW + 3_600_000),
			),
		).toBe("valid");
		// Ranks are capped at 4: rank 9 waits no longer than rank 4.
		const capped = await claimFor(victim.keys, work, {
			rank: 9,
			claimedAt: iso(NOW + 60_000),
		});
		expect(
			await checkClaim(
				capped,
				subjectOf(work),
				work,
				context(view, [], NOW + 60_000),
			),
		).toBe("valid");
		const unqueued = offer(work.dispatcher, { queuedAt: "not a time" });
		expect(
			await checkClaim(
				await claimFor(victim.keys, unqueued, { rank: 4 }),
				subjectOf(unqueued),
				unqueued,
				context(view),
			),
		).toBe("valid");
	});
});

describe("the dispatcher on the bus", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function onBus() {
		const authority = authorityKey();
		const bus = createMemoryBus(() => Date.now());
		const parts = await world();
		const extra = await device({ roles: [Role.EXECUTOR] });
		await seedBus(
			bus,
			authority,
			[
				parts.dispatcher.record,
				parts.victim.record,
				parts.outsider.record,
				extra.record,
			],
			[fleetRecord(), fleetRecord(openPolicy(), OTHER_FLEET)],
		);
		const source = testSource();
		source.queue.push(upstream("job-1", NOW), upstream("job-2", NOW));
		const sent = reports();
		const logs = recorder();
		const dispatcher = createDispatcher({
			self: parts.dispatcher.keys,
			bus,
			sources: [source],
			report: sent.report,
			now: () => Date.now(),
			log: logs.log,
		});
		const offers: { envelope: SignedEnvelope; offer: WorkOffer }[] = [];
		bus.offers.subscribe([FLEET], "start", async (envelope) => {
			offers.push({
				envelope,
				offer: fromBinary(WorkOfferSchema, envelope.payload),
			});
		});
		dispatcher.start();
		await vi.advanceTimersByTimeAsync(1_000);
		const publish = async (claim: SignedEnvelope, fleet = FLEET) => {
			const decoded = fromBinary(ClaimSchema, claim.payload);
			const digest = parseWorkDigest(decoded.workDigest);
			const target = offers[0]?.offer;
			const subject =
				target === undefined ? digest : parseWorkDigest(target.workDigest);
			expect(await bus.claims.claim(claim, fleet, subject)).toBe("claimed");
			await vi.advanceTimersByTimeAsync(100);
			// Every one of these is deleted, so the ledger is free again.
			expect(await bus.claims.holder(fleet, subject)).toBeUndefined();
		};
		return { ...parts, extra, bus, dispatcher, offers, sent, logs, publish };
	}

	const claimants = (report: { claims: readonly SignedEnvelope[] }) =>
		report.claims.map((claim) =>
			parseMemberId(fromBinary(ClaimSchema, claim.payload).memberId),
		);

	it("deletes forged, replayed and cross-fleet claims naming a victim and never reports the victim", async () => {
		const w = await onBus();
		expect(w.offers).toHaveLength(2);
		const [first, second] = w.offers.map((entry) => entry.offer);
		if (first === undefined || second === undefined)
			throw new Error("no offers");
		// Forged: the outsider signs a claim naming the victim.
		await w.publish(
			await claimFor(w.victim.keys, first, {}, w.outsider.keys.sign),
		);
		// Forged under the victim's key id.
		const forged = await claimFor(
			w.victim.keys,
			first,
			{},
			w.outsider.keys.sign,
		);
		await w.publish(
			create(SignedEnvelopeSchema, {
				...forged,
				keyId: `${w.victim.keys.memberId}#sign`,
			}),
		);
		// Replayed: the victim's genuine claim on the other offer, on this offer's subject.
		await w.publish(await claimFor(w.victim.keys, second, { rank: 0 }));
		// Cross-fleet: the victim's genuine claim moved to the other fleet's payload.
		await w.publish(
			await claimFor(w.victim.keys, first, { fleet: OTHER_FLEET }),
		);
		expect(w.sent.sent).toHaveLength(0);
		expect(
			w.logs.lines.filter(
				(line) => line.event === "hobo_fleet_claim_discarded",
			),
		).toHaveLength(4);
		await w.dispatcher.stop();
	});

	it("reports a signature-valid out-of-fleet claim once, on its signer", async () => {
		const w = await onBus();
		const first = w.offers[0]?.offer;
		if (first === undefined) throw new Error("no offer");
		const claim = await claimFor(w.outsider.keys, first);
		await w.publish(claim);
		await w.publish(claim);
		expect(w.sent.sent).toHaveLength(1);
		const [report] = w.sent.sent;
		expect(report?.kind).toBe("claim-not-entitled");
		expect(report === undefined ? [] : claimants(report)).toEqual([
			w.outsider.keys.memberId,
		]);
		expect(report?.offer?.payload).toEqual(w.offers[0]?.envelope.payload);
		await w.dispatcher.stop();
	});

	it("deletes early claims and reports three from one device inside an hour", async () => {
		const w = await onBus();
		const first = w.offers[0]?.offer;
		if (first === undefined) throw new Error("no offer");
		for (const ms of [0, 1_000, 2_000]) {
			await w.publish(
				await claimFor(w.victim.keys, first, {
					rank: 4,
					claimedAt: iso(NOW + ms),
				}),
			);
			expect(w.sent.sent).toHaveLength(ms === 2_000 ? 1 : 0);
		}
		const [report] = w.sent.sent;
		expect(report?.kind).toBe("claim-early");
		expect(report?.claims).toHaveLength(3);
		expect(report === undefined ? [] : claimants(report)).toEqual([
			w.victim.keys.memberId,
			w.victim.keys.memberId,
			w.victim.keys.memberId,
		]);
		await w.dispatcher.stop();
	});

	it("still deletes a claim it must report when the authority cannot be reached", async () => {
		const w = await onBus();
		const first = w.offers[0]?.offer;
		if (first === undefined) throw new Error("no offer");
		const failing = createDispatcher({
			self: w.dispatcher.keys,
			bus: w.bus,
			sources: [],
			report: async () => {
				throw new Error("authority down");
			},
			now: () => Date.now(),
			log: () => undefined,
		});
		failing.start();
		await vi.advanceTimersByTimeAsync(100);
		await w.publish(await claimFor(w.outsider.keys, first));
		await failing.stop();
		await w.dispatcher.stop();
	});
});
