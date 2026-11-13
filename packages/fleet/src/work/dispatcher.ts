/**
 * The dispatcher loop (design §6.9 steps 1, 4 and 5): on a 10-second beat it
 * polls each work source for each fleet it dispatches in, ranks itself among
 * the fleet's dispatchers and offers what is its turn; it checks every claim
 * on its offers by the four rules, deletes and reports what the claimant's own
 * signature proves, and orders the claim that stands: `stillWanted`, prepare,
 * seal the secret to the claimant's `SEAL` key, sign, deliver. It writes
 * nothing to the journal (the authority records from the bus). Private to L04.
 */
import { randomBytes } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type Claim,
	ClaimSchema,
	CoordinationMode,
	type FleetRecord,
	KeyPurpose,
	Role,
	SandboxTier,
	type SignedEnvelope,
	TrustClass,
	type ViolationReport,
	ViolationReportSchema,
	type WorkOffer,
	WorkOfferSchema,
	WorkOrderSchema,
	WorkOrigin,
} from "../_generated/fleet_pb.js";
import {
	OFFER_CONTEXT,
	ORDER_CONTEXT,
	ORDER_SECRET_CONTEXT,
} from "../contexts.js";
import {
	type FleetId,
	parseFleetId,
	parseMemberId,
	parseWorkDigest,
	type WorkDigest,
} from "../ids.js";
import { seal, signEnvelope } from "../keys/index.js";
import { claimTurn } from "../observation/index.js";
import type {
	Clock,
	DeviceKeys,
	FleetBus,
	FleetLog,
	Subscription,
	UpstreamWork,
	WorkSource,
} from "../ports.js";
import { claimVerdict, MAX_RANK, policyOf } from "./checks.js";
import {
	createObservationCache,
	rankDispatchers,
	rankExecutors,
} from "./ranking.js";
import { digestOf, policyRefusal } from "./rules.js";
import { keyOf } from "./signed.js";

/** §6.9: the dispatcher's poll beat. */
export const DISPATCH_BEAT_MS = 10_000;
/** §6.9 step 2: one rank is 20 seconds. */
export const STEP_MS = 20_000;
/** How long an offer stands; inside the offer stream's 15-minute maximum age. */
const OFFER_TTL_MS = 10 * 60_000;
/** §6.9 step 4: three early claims from one device inside an hour are reported. */
const EARLY_CLAIMS = 3;
const EARLY_WINDOW_MS = 60 * 60_000;
/** How long a handled digest is remembered, so a source that still lists it is not offered again. */
const HANDLED_MS = 30 * 60_000;

type OpenOffer = {
	readonly offer: WorkOffer;
	readonly envelope: SignedEnvelope;
	readonly source: WorkSource;
	readonly fleet: FleetRecord;
	state: "open" | "ordering" | "ordered";
};

const iso = (ms: number) => new Date(ms).toISOString();

function decodeClaim(envelope: SignedEnvelope): Claim | undefined {
	try {
		return fromBinary(ClaimSchema, envelope.payload);
	} catch {
		return undefined;
	}
}

export function dispatcher(
	deps: Readonly<{
		self: DeviceKeys;
		bus: FleetBus;
		sources: readonly WorkSource[];
		report(report: ViolationReport): Promise<void>;
		now: Clock;
		log: FleetLog;
	}>,
) {
	const { self, bus, log } = deps;
	const open = new Map<WorkDigest, OpenOffer>();
	/** Digests this dispatcher ordered, refused or saw offered by another, until when. */
	const handled = new Map<WorkDigest, number>();
	const early = new Map<string, SignedEnvelope[]>();
	const reported = new Set<string>();
	const observations = createObservationCache(bus.registry);
	const subscriptions: Subscription[] = [];
	let subscribedFleets = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	let running: Promise<void> = Promise.resolve();
	let stopped = true;
	let connected = true;

	const busStatus = () => {
		const now = bus.status() === "connected";
		if (now !== connected) {
			connected = now;
			log("hobo_fleet_bus_status", {
				member: self.memberId,
				role: "dispatcher",
				status: bus.status(),
			});
		}
		return now;
	};

	async function myFleets(): Promise<readonly FleetRecord[]> {
		const record = await bus.registry.member(self.memberId);
		if (record === undefined) return [];
		const fleets: FleetRecord[] = [];
		for (const membership of record.memberships) {
			if (!membership.roles.includes(Role.DISPATCHER)) continue;
			const fleet = await bus.registry.fleet(parseFleetId(membership.fleet));
			if (
				fleet !== undefined &&
				fleet.coordination !== CoordinationMode.ONE_ACTIVE
			)
				fleets.push(fleet);
		}
		return fleets;
	}

	async function subscribe(fleets: readonly FleetId[]): Promise<void> {
		const key = [...fleets].sort().join(",");
		if (key === subscribedFleets) return;
		await Promise.all(subscriptions.splice(0).map((s) => s.stop()));
		subscribedFleets = key;
		subscriptions.push(
			bus.offers.subscribe(fleets, "new", async (envelope) => {
				// Another dispatcher's offer: it is that dispatcher's to see through.
				if (envelope.keyId === self.sign.keyId) return;
				try {
					const offer = fromBinary(WorkOfferSchema, envelope.payload);
					handled.set(
						parseWorkDigest(offer.workDigest),
						deps.now() + HANDLED_MS,
					);
				} catch {
					// Garbage on the offer subject is not this dispatcher's business.
				}
			}),
			bus.claims.subscribe(fleets, "new", (claim, fleet, digest) =>
				onClaim(claim, fleet, digest),
			),
		);
	}

	async function offerWork(
		fleet: FleetRecord,
		source: WorkSource,
		work: UpstreamWork,
	): Promise<void> {
		const digest = digestOf(source.kind, work.workKey);
		const nowMs = deps.now();
		if (open.has(digest) || (handled.get(digest) ?? 0) > nowMs) return;
		const fleetId = parseFleetId(fleet.fleetId);
		const ranked = await rankDispatchers(bus.registry, fleetId, digest);
		const turn = claimTurn({
			digest,
			self: self.memberId,
			ranked,
			queuedAtMs: work.queuedAtMs,
			nowMs,
			stepMs: STEP_MS,
			maxRank: MAX_RANK,
		});
		if (turn.waitMs > 0) return;
		const policy = policyOf(fleet.policy);
		const refusal = policyRefusal(policy, { kind: source.kind, ...work });
		if (refusal !== undefined) {
			handled.set(digest, nowMs + HANDLED_MS);
			log("hobo_fleet_offer_unfit", {
				digest,
				fleet: fleetId,
				reason: `policy-${refusal}`,
			});
			return;
		}
		const offer = create(WorkOfferSchema, {
			submission: work.submission,
			workKey: work.workKey,
			workDigest: digest,
			kind: source.kind,
			fleet: fleetId,
			label: work.label,
			needs: work.needs,
			// The dispatcher's ceiling: never OWN (§6.9).
			trustClass:
				work.origin === WorkOrigin.INTERNAL
					? TrustClass.ORG
					: TrustClass.UNTRUSTED,
			author: work.author,
			origin: work.origin,
			repository: work.repository,
			ref: work.ref,
			workflowDigest: work.workflowDigest,
			queuedAt: iso(Math.min(work.queuedAtMs, nowMs)),
			expiresAt: iso(nowMs + OFFER_TTL_MS),
			dispatcher: self.memberId,
		});
		const envelope = await signEnvelope(
			self.sign,
			OFFER_CONTEXT,
			toBinary(WorkOfferSchema, offer),
		);
		open.set(digest, { offer, envelope, source, fleet, state: "open" });
		await bus.offers.publish(envelope, fleetId);
		log("hobo_fleet_work_offered", {
			digest,
			fleet: fleetId,
			kind: source.kind,
		});
	}

	async function tick(): Promise<void> {
		const nowMs = deps.now();
		for (const [digest, until] of handled)
			if (until <= nowMs) handled.delete(digest);
		for (const [digest, entry] of open)
			if (entry.state === "open" && Date.parse(entry.offer.expiresAt) <= nowMs)
				open.delete(digest);
		// With the bus down nothing is offered; the work stays upstream (§6.9, F4).
		if (!busStatus()) return;
		const fleets = await myFleets();
		await subscribe(fleets.map((fleet) => parseFleetId(fleet.fleetId)));
		for (const fleet of fleets) {
			for (const source of deps.sources) {
				let works: readonly UpstreamWork[];
				try {
					works = await source.poll(fleet);
				} catch {
					continue;
				}
				for (const work of works) {
					if (stopped) return;
					await offerWork(fleet, source, work);
				}
			}
		}
	}

	async function sendReport(
		report: ViolationReport,
		claimant: string,
	): Promise<void> {
		try {
			await deps.report(report);
		} catch {
			// The authority is down: the claim is deleted all the same; the report is lost.
		}
		log("hobo_fleet_violation_reported", {
			kind: report.kind,
			member: claimant,
		});
	}

	async function discard(
		fleet: FleetId,
		digest: WorkDigest,
		reason: string,
		claimant: string,
	): Promise<void> {
		await bus.claims.remove(fleet, digest).catch(() => undefined);
		log("hobo_fleet_claim_discarded", {
			digest,
			fleet,
			reason,
			member: claimant,
		});
	}

	async function onClaim(
		envelope: SignedEnvelope,
		fleet: FleetId,
		digest: WorkDigest,
	): Promise<void> {
		const entry = open.get(digest);
		if (
			entry === undefined ||
			entry.offer.fleet !== fleet ||
			entry.state !== "open"
		)
			return;
		const nowMs = deps.now();
		const { ranked } = await rankExecutors({
			registry: bus.registry,
			fleet: entry.fleet,
			offer: entry.offer,
			digest,
			observations: await observations.read(bus.observations, nowMs),
		});
		const verdict = await claimVerdict(
			envelope,
			{ fleet, digest },
			entry.offer,
			{
				registry: bus.registry,
				ranked,
				nowMs,
				stepMs: STEP_MS,
			},
		);
		const claim = decodeClaim(envelope);
		const claimant = verdict === "discard" ? "" : (claim?.memberId ?? "");
		if (verdict === "discard") return discard(fleet, digest, "discard", "");
		if (verdict === "not-entitled") {
			await discard(fleet, digest, "not-entitled", claimant);
			const key = `${claimant}.${digest}.${claim?.claimedAt ?? ""}`;
			if (reported.has(key)) return;
			reported.add(key);
			return sendReport(
				create(ViolationReportSchema, {
					kind: "claim-not-entitled",
					offer: entry.envelope,
					claims: [envelope],
				}),
				claimant,
			);
		}
		if (verdict === "early") {
			await discard(fleet, digest, "early", claimant);
			const key = `${claimant}.${digest}`;
			const seen = (early.get(key) ?? []).filter((prior) => {
				const at = Date.parse(decodeClaim(prior)?.claimedAt ?? "");
				return Number.isFinite(at) && nowMs - at < EARLY_WINDOW_MS;
			});
			if (
				!seen.some(
					(prior) => decodeClaim(prior)?.claimedAt === claim?.claimedAt,
				)
			)
				seen.push(envelope);
			if (seen.length < EARLY_CLAIMS) {
				early.set(key, seen);
				return;
			}
			early.delete(key);
			return sendReport(
				create(ViolationReportSchema, {
					kind: "claim-early",
					offer: entry.envelope,
					claims: seen.slice(-EARLY_CLAIMS),
				}),
				claimant,
			);
		}
		return order(entry, envelope, claimant, fleet, digest);
	}

	async function order(
		entry: OpenOffer,
		claimEnvelope: SignedEnvelope,
		claimant: string,
		fleet: FleetId,
		digest: WorkDigest,
	): Promise<void> {
		entry.state = "ordering";
		const release = async (reason: string) => {
			open.delete(digest);
			handled.set(digest, deps.now() + HANDLED_MS);
			await bus.claims.remove(fleet, digest).catch(() => undefined);
			log("hobo_fleet_claim_discarded", {
				digest,
				fleet,
				reason,
				member: claimant,
			});
		};
		try {
			if (!(await entry.source.stillWanted(entry.offer)))
				return release("not-wanted");
			const record = await bus.registry.member(parseMemberId(claimant));
			const sealKey =
				record === undefined ? undefined : keyOf(record, KeyPurpose.SEAL);
			if (record === undefined || sealKey === undefined)
				return release("claimant-unknown");
			const prepared = await entry.source.prepare(entry.offer, record);
			if (!prepared.ok) return release(prepared.error.code);
			const claim = decodeClaim(claimEnvelope);
			const orderId = randomBytes(16).toString("hex");
			const associated = new TextEncoder().encode(`${orderId}\0${claimant}`);
			const nowMs = deps.now();
			const message = create(WorkOrderSchema, {
				orderId,
				offer: entry.offer,
				memberId: claimant,
				sandboxTier: claim?.sandboxTier ?? SandboxTier.UNSPECIFIED,
				egressAllow: [...prepared.value.egressAllow],
				parameters: { ...prepared.value.parameters },
				secret: seal(
					sealKey,
					prepared.value.secret,
					ORDER_SECRET_CONTEXT,
					associated,
				),
				issuedAt: iso(nowMs),
				expiresAt: entry.offer.expiresAt,
			});
			const envelope = await signEnvelope(
				self.sign,
				ORDER_CONTEXT,
				toBinary(WorkOrderSchema, message),
			);
			await bus.orders.deliver(envelope, parseMemberId(record.memberId));
			entry.state = "ordered";
			handled.set(digest, Date.parse(entry.offer.expiresAt) + HANDLED_MS);
			open.delete(digest);
			log("hobo_fleet_work_ordered", {
				digest,
				fleet,
				member: claimant,
				order: orderId,
			});
		} catch {
			entry.state = "open";
			await release("unavailable");
		}
	}

	return {
		start() {
			if (!stopped) return;
			stopped = false;
			const beat = () => {
				running = running
					.then(() => (stopped ? undefined : tick()))
					.catch(() => undefined);
			};
			beat();
			timer = setInterval(beat, DISPATCH_BEAT_MS);
		},
		async stop() {
			stopped = true;
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			await running;
			await Promise.all(subscriptions.splice(0).map((s) => s.stop()));
			subscribedFleets = "";
		},
	};
}
