/**
 * The executor loop (design §6.9 steps 2, 3, 6 to 8; §6.11): for each offer
 * in a fleet it executes in, fit it, wait its turn, and claim; wait up to 30
 * seconds for the order, check it, open an egress proxy for it, start a fresh
 * sandbox with the start fence, run the work kind, publish log chunks and
 * receipts, destroy the sandbox. Receipts go to `AgentState.pendingReceipts`
 * before they are published and leave it once published, so they survive a
 * bus outage (F4); order ids it has seen are persisted. With the bus down it
 * claims nothing and keeps running what it has. Private to L04.
 */
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	ClaimSchema,
	DeviceClass,
	type FleetRecord,
	type MemberRecord,
	ObservationSchema,
	ReceiptStatus,
	Role,
	SandboxTier,
	type SignedEnvelope,
	TrustClass,
	WorkNeedsSchema,
	type WorkOffer,
	WorkOfferSchema,
	type WorkOrder,
	WorkOrderSchema,
	WorkReceiptSchema,
} from "../_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	OFFER_CONTEXT,
	ORDER_SECRET_CONTEXT,
} from "../contexts.js";
import {
	type FleetId,
	parseFleetId,
	parseWorkDigest,
	type WorkDigest,
} from "../ids.js";
import { signEnvelope } from "../keys/index.js";
import { claimTurn, fitWork } from "../observation/index.js";
import type {
	AgentState,
	CapacitySource,
	Clock,
	DeviceKeys,
	EgressProxyFactory,
	FleetBus,
	FleetLog,
	FleetLogEvent,
	KeyStore,
	Sandbox,
	SandboxDriver,
	Subscription,
	WorkRunner,
} from "../ports.js";
import {
	ATTRIBUTABLE,
	fenceAllows,
	MAX_RANK,
	orderVerdict,
	policyOf,
} from "./checks.js";
import { STEP_MS } from "./dispatcher.js";
import { createObservationCache, rankExecutors } from "./ranking.js";
import {
	digestOf,
	neededTier,
	policyRefusal,
	residencyAllows,
	versionAtLeast,
} from "./rules.js";
import { deviceSigner, signLogChunk, signReceipt } from "./signed.js";

/** §6.9: how long a claimant waits for its order. */
export const ORDER_WAIT_MS = 30_000;
/** How often queued receipts are retried while the bus is down. */
const FLUSH_MS = 10_000;
/** §7.1 `WorkLogChunk.data`: at most 64 KiB. */
const LOG_CHUNK_BYTES = 64 * 1024;
/** Order ids kept; the order stream keeps 15 minutes, far fewer than this. */
const SEEN_LIMIT = 10_000;
const ORDERS = "orders";
const OFFERS = "offers";

type Held = { offer: WorkOffer; timer: ReturnType<typeof setTimeout> };
/**
 * Where the offer subscription starts: the start of `FLEET_OFFERS`, whose
 * 15-minute maximum age (§6.7) holds every offer still standing (an offer
 * stands 10 minutes), so an executor that has just started, restarted or
 * joined a fleet sees the offers made before it listened. Offers past their
 * `expires_at` are skipped, and each digest is handled once while its offer
 * stands.
 */
const OFFERS_FROM = "start";
type Live = { sandbox: Sandbox; abort: AbortController };

const iso = (ms: number) => new Date(ms).toISOString();

/** The log event of each receipt status (§7.5). */
const RECEIPT_EVENTS = {
	[ReceiptStatus.UNSPECIFIED]: "hobo_fleet_work_abandoned",
	[ReceiptStatus.STARTED]: "hobo_fleet_work_started",
	[ReceiptStatus.SUCCEEDED]: "hobo_fleet_work_succeeded",
	[ReceiptStatus.FAILED]: "hobo_fleet_work_failed",
	[ReceiptStatus.CANCELLED]: "hobo_fleet_work_cancelled",
	[ReceiptStatus.ABANDONED]: "hobo_fleet_work_abandoned",
	[ReceiptStatus.REFUSED]: "hobo_fleet_work_refused",
} as const satisfies Readonly<Record<ReceiptStatus, FleetLogEvent>>;

function decode<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

export function executor(
	deps: Readonly<{
		self: DeviceKeys;
		state: KeyStore;
		bus: FleetBus;
		runners: readonly WorkRunner[];
		sandboxes: readonly SandboxDriver[];
		egress: EgressProxyFactory;
		capacity: CapacitySource;
		now: Clock;
		log: FleetLog;
	}>,
) {
	const { self, bus, log } = deps;
	const held = new Map<WorkDigest, Held>();
	/** Digests already handled, until their offer's `expires_at` (epoch ms). */
	const handled = new Map<WorkDigest, number>();
	const live = new Map<string, Live>();
	const runs = new Set<Promise<void>>();
	const waits = new Set<ReturnType<typeof setTimeout>>();
	const observations = createObservationCache(bus.registry);
	let drivers: SandboxDriver[] = [];
	let seen: string[] = [];
	let seenSet = new Set<string>();
	let pending: SignedEnvelope[] = [];
	const sequences: Record<string, number> = {};
	let offerSubscription: Subscription | undefined;
	let orderSubscription: Subscription | undefined;
	let flushTimer: ReturnType<typeof setInterval> | undefined;
	let ready: Promise<void> = Promise.resolve();
	let writes: Promise<void> = Promise.resolve();
	let flushing: Promise<void> = Promise.resolve();
	let accepting = false;
	let started = false;

	// ── State ───────────────────────────────────────────────────────────────
	const persist = (): Promise<void> => {
		writes = writes
			.then(async () => {
				const current: AgentState = await deps.state.readState();
				await deps.state.writeState({
					...current,
					lastSequence: { ...current.lastSequence, ...sequences },
					seenOrderIds: [...seen],
					pendingReceipts: [...pending],
				});
			})
			.catch(() => undefined);
		return writes;
	};

	const remember = (orderId: string) => {
		if (seenSet.has(orderId)) return;
		seen.push(orderId);
		if (seen.length > SEEN_LIMIT) seen = seen.slice(-SEEN_LIMIT);
		seenSet = new Set(seen);
	};

	// ── Receipts (F4) ─────────────────────────────────────────────────────────
	const flush = (): Promise<void> => {
		flushing = flushing
			.then(async () => {
				while (pending.length > 0 && bus.status() === "connected") {
					const [next] = pending;
					if (next === undefined) break;
					try {
						await bus.events.publish(next, self.memberId, "receipt");
					} catch {
						break;
					}
					pending = pending.slice(1);
					await persist();
				}
			})
			.catch(() => undefined);
		return flushing;
	};

	async function receipt(
		order: WorkOrder,
		status: ReceiptStatus,
		fields: Readonly<{
			reason?: string;
			trust?: TrustClass;
			sandboxSeconds?: number;
			outputDigest?: string;
			observedWorkKey?: string;
		}> = {},
	): Promise<void> {
		const envelope = await signReceipt(
			self.sign,
			create(WorkReceiptSchema, {
				orderId: order.orderId,
				workDigest: order.offer?.workDigest ?? "",
				memberId: self.memberId,
				status,
				reason: fields.reason ?? "",
				at: iso(deps.now()),
				sandboxTier: order.sandboxTier,
				trustClass: fields.trust ?? TrustClass.UNSPECIFIED,
				sandboxSeconds: fields.sandboxSeconds ?? 0,
				outputDigest: fields.outputDigest ?? "",
				observedWorkKey: fields.observedWorkKey ?? "",
			}),
		);
		pending = [...pending, envelope];
		await persist();
		log(RECEIPT_EVENTS[status], {
			order: order.orderId,
			digest: order.offer?.workDigest ?? "",
			reason: fields.reason ?? "",
		});
		await flush();
	}

	// ── Offers: fit, turn, claim ─────────────────────────────────────────────
	async function selfRecord(): Promise<MemberRecord | undefined> {
		return bus.registry.member(self.memberId);
	}

	const inUse = () => held.size + live.size;

	async function ownObservation(record: MemberRecord, fleet: FleetId) {
		const reading = await deps.capacity.read();
		const capacity = reading.capacity;
		return create(ObservationSchema, {
			memberId: self.memberId,
			observerId: self.memberId,
			fleets: [fleet],
			health: reading.health,
			capacity: {
				...capacity,
				freeSlots: Math.max(0, capacity.freeSlots - inUse()),
			},
			labels: [...reading.labels],
			platform: record.platform,
			sandboxTiers: drivers.map((driver) => driver.tier),
			agentVersion: record.agentVersion,
			region: record.region,
			issuedAt: iso(deps.now()),
			validUntil: iso(deps.now() + 60_000),
		});
	}

	function after(ms: number, task: () => Promise<void>): void {
		const timer = setTimeout(
			() => {
				waits.delete(timer);
				void task().catch(() => undefined);
			},
			Math.max(0, ms),
		);
		waits.add(timer);
	}

	type Plan = Readonly<{
		offer: WorkOffer;
		fleet: FleetRecord;
		digest: WorkDigest;
		tier: SandboxTier;
	}>;

	/** Whether this device could run the offer now, and in which tier; logs why not. */
	async function plan(
		offer: WorkOffer,
		digest: WorkDigest,
	): Promise<
		Readonly<{ plan: Plan; record: MemberRecord; fits: boolean }> | undefined
	> {
		const record = await selfRecord();
		if (record === undefined) return undefined;
		const fleetId = parseFleetId(offer.fleet);
		const fleet = await bus.registry.fleet(fleetId);
		if (
			fleet === undefined ||
			!record.memberships.some(
				(m) => m.fleet === offer.fleet && m.roles.includes(Role.EXECUTOR),
			)
		)
			return undefined;
		const policy = policyOf(fleet.policy);
		const unfit = (reason: string) => {
			log("hobo_fleet_offer_unfit", { digest, fleet: fleetId, reason });
			return undefined;
		};
		if (!deps.runners.some((runner) => runner.kind === offer.kind))
			return unfit("kind");
		const refusal = policyRefusal(policy, offer);
		if (refusal !== undefined) return unfit(`policy-${refusal}`);
		if (!versionAtLeast(record.agentVersion, policy.minAgentVersion)) {
			log("hobo_fleet_update_required", {
				minimum: policy.minAgentVersion,
				version: record.agentVersion,
			});
			return undefined;
		}
		if (!residencyAllows(record.region, [policy.residency, offer.residency]))
			return unfit("residency");
		const { tier: needed } = neededTier(offer, record, policy);
		if (needed === "never") return unfit("sandbox");
		const tier = drivers
			.map((driver) => driver.tier)
			.filter(
				(candidate) => candidate >= Math.max(needed, SandboxTier.S1_CONTAINER),
			)
			.sort((a, b) => a - b)[0];
		if (tier === undefined) return unfit("sandbox");
		const own = await ownObservation(record, fleetId);
		const needs = clone(
			WorkNeedsSchema,
			offer.needs ?? create(WorkNeedsSchema),
		);
		needs.minSandbox = tier;
		const fit = fitWork(own, needs);
		return { plan: { offer, fleet, digest, tier }, record, fits: fit.fits };
	}

	async function onOffer(
		envelope: SignedEnvelope,
		sequence: number,
	): Promise<void> {
		sequences[OFFERS] = sequence;
		if (!accepting) return;
		const dispatcher = await deviceSigner(
			bus.registry,
			envelope,
			OFFER_CONTEXT,
		);
		if (dispatcher === undefined) return;
		const offer = decode(() => fromBinary(WorkOfferSchema, envelope.payload));
		if (
			offer === undefined ||
			offer.dispatcher !== dispatcher.memberId ||
			!dispatcher.memberships.some(
				(m) => m.fleet === offer.fleet && m.roles.includes(Role.DISPATCHER),
			)
		)
			return;
		const digest = decode(() => parseWorkDigest(offer.workDigest));
		if (digest === undefined || digest !== digestOf(offer.kind, offer.workKey))
			return;
		const nowMs = deps.now();
		const expiresAtMs = Date.parse(offer.expiresAt);
		if (expiresAtMs <= nowMs || held.has(digest)) return;
		for (const [seen, until] of handled)
			if (until <= nowMs) handled.delete(seen);
		if (handled.has(digest)) return;
		handled.set(digest, expiresAtMs);
		const planned = await plan(offer, digest);
		if (planned === undefined) return;
		const own = await ownObservation(planned.record, parseFleetId(offer.fleet));
		const { ranked } = await rankExecutors({
			registry: bus.registry,
			fleet: planned.plan.fleet,
			offer,
			digest,
			observations: await observations.read(bus.observations, nowMs),
			self: { memberId: self.memberId, observation: own },
		});
		const turn = claimTurn({
			digest,
			self: self.memberId,
			ranked,
			queuedAtMs: Date.parse(offer.queuedAt),
			nowMs,
			stepMs: STEP_MS,
			maxRank: MAX_RANK,
		});
		if (turn.rank < 0) return;
		after(turn.waitMs, () => claim(planned.plan, turn.rank));
	}

	async function claim(planned: Plan, rank: number): Promise<void> {
		const { offer, digest } = planned;
		const fleet = parseFleetId(offer.fleet);
		if (!accepting || held.has(digest)) return;
		if (Date.parse(offer.expiresAt) <= deps.now()) return;
		// An executor that cannot reach the bus does not claim (§6.9 step 3).
		if (bus.status() !== "connected") {
			log("hobo_fleet_claims_unreachable", {
				digest,
				fleet,
				status: bus.status(),
			});
			return;
		}
		const again = await plan(offer, digest);
		if (again === undefined || !again.fits) return;
		try {
			if ((await bus.claims.holder(fleet, digest)) !== undefined) return;
			const message = create(ClaimSchema, {
				workDigest: digest,
				fleet,
				memberId: self.memberId,
				dispatcher: offer.dispatcher,
				offerExpiresAt: offer.expiresAt,
				rank,
				sandboxTier: again.plan.tier,
				claimedAt: iso(deps.now()),
			});
			const envelope = await signEnvelope(
				self.sign,
				CLAIM_CONTEXT,
				toBinary(ClaimSchema, message),
			);
			if (held.has(digest)) return;
			const outcome = await bus.claims.claim(envelope, fleet, digest);
			if (outcome !== "claimed") return;
			const timer = setTimeout(() => {
				waits.delete(timer);
				held.delete(digest);
			}, ORDER_WAIT_MS);
			waits.add(timer);
			held.set(digest, { offer, timer });
			log("hobo_fleet_work_claimed", { digest, fleet, rank });
		} catch (error) {
			log("hobo_fleet_claims_unreachable", {
				digest,
				fleet,
				message: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	// ── Orders: check, sandbox, run ──────────────────────────────────────────
	async function onOrder(
		envelope: SignedEnvelope,
		sequence: number,
	): Promise<void> {
		sequences[ORDERS] = sequence;
		const record = await selfRecord();
		if (record === undefined) return;
		const checked = await orderVerdict(envelope, {
			self: record,
			registry: bus.registry,
			heldClaims: new Set(held.keys()),
			seenOrderIds: seenSet,
			nowMs: deps.now(),
		});
		if (!checked.ok) {
			const order = decode(() => fromBinary(WorkOrderSchema, envelope.payload));
			const check = checked.error.detail?.check ?? "";
			const answerable = [...ATTRIBUTABLE].some((name) => name === check);
			if (order !== undefined && answerable && !seenSet.has(order.orderId)) {
				remember(order.orderId);
				await receipt(order, ReceiptStatus.REFUSED, {
					reason: checked.error.code,
				});
			}
			return;
		}
		const { order, trust, tier } = checked.value;
		remember(order.orderId);
		await persist();
		const digest = parseWorkDigest(order.offer?.workDigest ?? "");
		const claim = held.get(digest);
		if (claim !== undefined) {
			clearTimeout(claim.timer);
			waits.delete(claim.timer);
		}
		const job = run(order, trust, tier, record).finally(() => {
			held.delete(digest);
			runs.delete(job);
		});
		runs.add(job);
	}

	async function run(
		order: WorkOrder,
		trust: TrustClass,
		tier: SandboxTier,
		record: MemberRecord,
	): Promise<void> {
		const offer = order.offer;
		if (offer === undefined) return;
		const driver = drivers.find((candidate) => candidate.tier === tier);
		if (driver === undefined) {
			log("hobo_fleet_sandbox_unavailable", { order: order.orderId, tier });
			return receipt(order, ReceiptStatus.REFUSED, {
				reason: "sandbox-inadequate",
				trust,
			});
		}
		const runner = deps.runners.find(
			(candidate) => candidate.kind === offer.kind,
		);
		if (runner === undefined || order.secret === undefined)
			return receipt(order, ReceiptStatus.REFUSED, {
				reason: "order-invalid",
				trust,
			});
		const fleet = await bus.registry.fleet(parseFleetId(offer.fleet));
		const policy = policyOf(fleet?.policy);
		let secret: Uint8Array;
		try {
			secret = await self.openSealed(
				order.secret,
				ORDER_SECRET_CONTEXT,
				new TextEncoder().encode(`${order.orderId}\0${self.memberId}`),
			);
		} catch {
			return receipt(order, ReceiptStatus.REFUSED, {
				reason: "order-invalid",
				trust,
			});
		}
		let proxy: Awaited<ReturnType<EgressProxyFactory["open"]>> | undefined;
		let sandbox: Sandbox | undefined;
		const abort = new AbortController();
		const startedAt = deps.now();
		try {
			proxy = await deps.egress.open([...order.egressAllow]);
			sandbox = await driver.create({
				orderId: order.orderId,
				image: order.parameters.image ?? "",
				limits: {
					memoryMb: offer.needs?.memoryMb ?? 2_048,
					cpus: 2,
					pids: 1_024,
					diskMb: offer.needs?.diskMb ?? 10_240,
				},
				egressProxyUrl: proxy.url,
				readOnlyMounts: [],
				hostDocker:
					policy.allowHostDocker &&
					record.deviceClass === DeviceClass.DEDICATED &&
					tier === SandboxTier.S1_CONTAINER,
				fence: async (observed) =>
					fenceAllows(order, observed, record, policy, tier),
			});
		} catch {
			secret.fill(0);
			await proxy?.close().catch(() => undefined);
			return receipt(order, ReceiptStatus.ABANDONED, {
				reason: "unavailable",
				trust,
			});
		}
		live.set(order.orderId, { sandbox, abort });
		let logSequence = 0;
		let logs: Promise<void> = Promise.resolve();
		const publishLog = (data: Uint8Array, last: boolean) => {
			const sequence = logSequence;
			logSequence += 1;
			logs = logs
				.then(async () => {
					const chunk = await signLogChunk(self.sign, {
						orderId: order.orderId,
						sequence,
						data,
						last,
					});
					await bus.events.publish(chunk, self.memberId, "log");
				})
				.catch(() => undefined);
		};
		try {
			await receipt(order, ReceiptStatus.STARTED, { trust });
			let outcome: Awaited<ReturnType<WorkRunner["run"]>>;
			try {
				outcome = await runner.run({
					order,
					secret,
					sandbox,
					signal: abort.signal,
					onLog(chunk) {
						for (let at = 0; at < chunk.length; at += LOG_CHUNK_BYTES)
							publishLog(chunk.slice(at, at + LOG_CHUNK_BYTES), false);
					},
					log,
				});
			} catch {
				outcome = {
					status: abort.signal.aborted
						? ReceiptStatus.CANCELLED
						: ReceiptStatus.ABANDONED,
					reason: abort.signal.aborted ? "" : "unavailable",
					outputDigest: "",
					observedWorkKey: "",
				};
			}
			publishLog(new Uint8Array(), true);
			await logs;
			const status =
				outcome.status === ReceiptStatus.UNSPECIFIED ||
				outcome.status === ReceiptStatus.STARTED
					? ReceiptStatus.ABANDONED
					: outcome.status;
			await receipt(order, status, {
				reason: outcome.reason,
				trust,
				sandboxSeconds: Math.max(
					0,
					Math.round((deps.now() - startedAt) / 1_000),
				),
				outputDigest: outcome.outputDigest,
				observedWorkKey:
					outcome.observedWorkKey === offer.workKey
						? ""
						: outcome.observedWorkKey,
			});
		} finally {
			secret.fill(0);
			live.delete(order.orderId);
			await sandbox.destroy().catch(() => undefined);
			await proxy.close().catch(() => undefined);
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────
	async function init(): Promise<void> {
		const state = await deps.state.readState();
		seen = [...state.seenOrderIds].slice(-SEEN_LIMIT);
		seenSet = new Set(seen);
		pending = [...state.pendingReceipts];
		drivers = [];
		for (const driver of deps.sandboxes) {
			const available = await driver.available().catch(() => undefined);
			if (available?.ok === true) drivers.push(driver);
			else log("hobo_fleet_sandbox_unavailable", { tier: driver.tier });
		}
		const record = await selfRecord();
		const fleets = (record?.memberships ?? [])
			.filter((m) => m.roles.includes(Role.EXECUTOR))
			.map((m) => parseFleetId(m.fleet));
		const from = (stream: string) => {
			const after = state.lastSequence[stream];
			return after === undefined ? "new" : { after };
		};
		if (!started) return;
		offerSubscription = bus.offers.subscribe(fleets, OFFERS_FROM, onOffer);
		orderSubscription = bus.orders.subscribe(
			self.memberId,
			from(ORDERS),
			onOrder,
		);
		flushTimer = setInterval(() => void flush(), FLUSH_MS);
		await flush();
	}

	async function settle(): Promise<void> {
		while (runs.size > 0) await Promise.all(runs);
	}

	return {
		start() {
			if (started) return;
			started = true;
			accepting = true;
			ready = init().catch(() => undefined);
		},
		async drain() {
			await ready;
			accepting = false;
			await offerSubscription?.stop();
			offerSubscription = undefined;
			// Claims already held may still receive their orders; then everything runs out.
			while (held.size > 0 || runs.size > 0) {
				await settle();
				if (held.size > 0)
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => {
							waits.delete(timer);
							resolve();
						}, 1_000);
						waits.add(timer);
					});
			}
			await flush();
		},
		async stop() {
			await ready;
			accepting = false;
			started = false;
			for (const timer of waits) clearTimeout(timer);
			waits.clear();
			for (const entry of held.values()) clearTimeout(entry.timer);
			held.clear();
			if (flushTimer !== undefined) clearInterval(flushTimer);
			flushTimer = undefined;
			for (const entry of live.values()) entry.abort.abort();
			await settle();
			await offerSubscription?.stop();
			await orderSubscription?.stop();
			offerSubscription = undefined;
			orderSubscription = undefined;
			await flushing;
			await persist();
		},
		sandboxOf(orderId: string) {
			return live.get(orderId)?.sandbox;
		},
	};
}
