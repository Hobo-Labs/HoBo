/**
 * The recorder (design §6.9 "recording catches up", §6.14 "Recording",
 * §7.5): reads offers, claims, the signed part of orders, receipts, log
 * chunks and session-close facts from the bus, verifies every envelope, and
 * appends `fleet-work-<WorkDigest>` and `fleet-session-<sessionId>` events.
 *
 * - Idempotent: each event's `meta.idempotencyKey` is its type and the
 *   SHA-256 of the signed payload, so the same fact arriving twice (a replay,
 *   a republish, a second replica) is recorded once.
 * - Resumable: each event's `meta` carries the bus stream and sequence it
 *   came from (`busStream`, `busSequence`); `start` resumes every
 *   subscription from `{ after: <highest recorded> }`. Log chunks are not
 *   journalled: their read store is `FLEET_EVENTS` itself (§7.5), so that
 *   subscription always reads every retained chunk.
 * - Usage (D40): `fleet.work.sandbox` per receipt carrying sandbox seconds,
 *   and `fleet.transport.relay` or `fleet.transport.direct` per session from
 *   the acceptor's close, each emitted only by the append that first recorded
 *   the fact, so a replay never bills twice.
 * - Everything it answers (work status, logs' order owner, reliability) is a
 *   fold of the journal, rebuilt by replay from `readAll`.
 */
import { createHash } from "node:crypto";
import {
	create,
	fromBinary,
	fromJson,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import {
	createUsageEvent,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	EventStoreError,
	type JsonObject,
	type PrincipalRef,
	type UsageEventType,
} from "@hobo/core";
import {
	ClaimSchema,
	ReceiptStatus,
	type ReliabilitySamples,
	SandboxTier,
	SessionCloseSchema,
	type SignedEnvelope,
	type WorkLogChunk,
	WorkLogChunkSchema,
	type WorkLogs,
	WorkLogsSchema,
	type WorkOffer,
	WorkOfferSchema,
	WorkOrderSchema,
	WorkReceiptSchema,
	type WorkStatus,
	WorkStatusSchema,
	WorkSubmissionSchema,
} from "../_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	LOG_CONTEXT,
	OFFER_CONTEXT,
	ORDER_CONTEXT,
	RECEIPT_CONTEXT,
	SESSION_CLOSE_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
} from "../contexts.js";
import { FLEET_LOG_EVENTS, type FleetEventType } from "../events.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseWorkDigest,
	type WorkDigest,
} from "../ids.js";
import { verifyEnvelope } from "../keys/index.js";
import { createReliabilityLedger } from "../observation/index.js";
import type {
	AuthorityDeps,
	BusStart,
	FleetLogEvent,
	Outcome,
	Subscription,
} from "../ports.js";
import { isJsonObject, numberOf, objectOf, pbJson, textOf } from "./json.js";
import { type Checked, dispatches, verifySigned } from "./verify.js";

export type RecorderDeps = Pick<
	AuthorityDeps,
	"tenant" | "store" | "bus" | "metering" | "now" | "log"
>;

const WORK_STREAM = "fleet-work-";
const SESSION_STREAM = "fleet-session-";
const ACTOR: PrincipalRef = { kind: "service", id: "hobo-fleet-recorder" };
/** Up to 8 compare-and-set attempts per append (§7.5). */
const MAX_ATTEMPTS = 8;
/** How often the recorder looks for fleets defined since it started. */
const FLEET_SCAN_MS = 5_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

// public-contract: the bus stream names recorded in each event's meta (§6.7 table).
const BUS = {
	offers: "FLEET_OFFERS",
	claims: "FLEET_CLAIMS",
	orders: "FLEET_ORDERS",
	events: "FLEET_EVENTS",
} as const;

const RECEIPT_EVENTS: ReadonlyMap<ReceiptStatus, FleetEventType> = new Map([
	[ReceiptStatus.STARTED, "fleet.WorkStarted"],
	[ReceiptStatus.SUCCEEDED, "fleet.WorkSucceeded"],
	[ReceiptStatus.FAILED, "fleet.WorkFailed"],
	[ReceiptStatus.CANCELLED, "fleet.WorkCancelled"],
	[ReceiptStatus.ABANDONED, "fleet.WorkAbandoned"],
	[ReceiptStatus.REFUSED, "fleet.WorkRefused"],
]);

type WorkState = {
	submissionId: string;
	memberId: string;
	status: ReceiptStatus;
	reason: string;
	outputDigest: string;
	updatedAt: string;
	latestOrder: string;
	readonly orders: Map<string, string>; // order id → executor
};

type SessionState = {
	initiator: string;
	acceptor: string;
	billed: boolean;
	readonly closes: Map<string, Readonly<{ sent: number; received: number }>>;
};

type LogEntry = Readonly<{ chunk: WorkLogChunk; from: MemberId }>;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function json<T extends Message>(schema: GenMessage<T>, message: T) {
	return pbJson(toJson(schema, message));
}

/** `fleet.WorkStarted` → `hobo_fleet_work_started` (§7.5). */
function logNameOf(type: string): FleetLogEvent | undefined {
	const name = `hobo_fleet_${type
		.replace(/^fleet\./u, "")
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()}`;
	return FLEET_LOG_EVENTS.find((candidate) => candidate === name);
}

/** A grant's party as the grant command journalled it: a member id string, `{ memberId }`, or a `SessionParty` JSON. */
function partyOf(data: JsonObject, field: string): string {
	const value = data[field];
	if (isJsonObject(value)) return textOf(value, "memberId");
	const flat = textOf(data, field);
	if (flat.length > 0) return flat;
	const grant = data.grant;
	return isJsonObject(grant) ? partyOf(grant, field) : "";
}

export function recorder(deps: RecorderDeps) {
	const works = new Map<WorkDigest, WorkState>();
	const submissions = new Map<string, WorkDigest>();
	const sessions = new Map<string, SessionState>();
	const heads = new Map<string, number>();
	const resume = new Map<string, number>();
	const logs = new Map<string, Map<string, LogEntry>>();
	const ledger = createReliabilityLedger();
	let position: EventPosition | undefined;
	let reading: Promise<void> = Promise.resolve();
	let chain: Promise<void> = Promise.resolve();
	let refusals = 0;
	let subscriptions: Subscription[] = [];
	const fleetsWatched = new Set<FleetId>();
	let scan: ReturnType<typeof setInterval> | undefined;
	let running = false;

	// ── The fold ───────────────────────────────────────────────────────────

	function work(digest: WorkDigest): WorkState {
		const existing = works.get(digest);
		if (existing !== undefined) return existing;
		const created: WorkState = {
			submissionId: "",
			memberId: "",
			status: ReceiptStatus.UNSPECIFIED,
			reason: "",
			outputDigest: "",
			updatedAt: "",
			latestOrder: "",
			orders: new Map(),
		};
		works.set(digest, created);
		return created;
	}

	function session(id: string): SessionState {
		const existing = sessions.get(id);
		if (existing !== undefined) return existing;
		const created: SessionState = {
			initiator: "",
			acceptor: "",
			billed: false,
			closes: new Map(),
		};
		sessions.set(id, created);
		return created;
	}

	function mapSubmission(id: string, digest: WorkDigest): void {
		if (id.length > 0 && !submissions.has(id)) submissions.set(id, digest);
	}

	function applyWork(event: EventEnvelope, data: JsonObject): void {
		let digest: WorkDigest;
		try {
			digest = parseWorkDigest(event.streamId.slice(WORK_STREAM.length));
		} catch {
			return;
		}
		const state = work(digest);
		const at = textOf(data, "at") || event.ts;
		switch (event.type) {
			case "fleet.WorkSubmitted":
			case "fleet.WorkOffered":
				if (state.submissionId === "")
					state.submissionId = textOf(data, "submissionId");
				mapSubmission(textOf(data, "submissionId"), digest);
				if (state.updatedAt === "") state.updatedAt = at;
				watch(textOf(data, "fleet"));
				return;
			case "fleet.WorkClaimed":
				state.memberId = textOf(data, "memberId");
				state.status = ReceiptStatus.UNSPECIFIED;
				state.reason = "";
				state.outputDigest = "";
				state.updatedAt = textOf(data, "claimedAt") || at;
				return;
			case "fleet.WorkOrdered": {
				const orderId = textOf(data, "orderId");
				state.orders.set(orderId, textOf(data, "memberId"));
				state.latestOrder = orderId;
				state.memberId = textOf(data, "memberId");
				state.updatedAt = textOf(data, "issuedAt") || at;
				return;
			}
			default:
				break;
		}
		const receiptJson = data.receipt;
		if (!isJsonObject(receiptJson)) return;
		const receipt = fromJson(WorkReceiptSchema, receiptJson, {
			ignoreUnknownFields: true,
		});
		state.memberId = receipt.memberId;
		state.status = receipt.status;
		state.reason = receipt.reason;
		state.outputDigest = receipt.outputDigest;
		state.updatedAt = receipt.at;
		if (!state.orders.has(receipt.orderId))
			state.orders.set(receipt.orderId, receipt.memberId);
		if (state.latestOrder === "") state.latestOrder = receipt.orderId;
		ledger.record(receipt);
	}

	function applySession(event: EventEnvelope, data: JsonObject): void {
		const state = session(event.streamId.slice(SESSION_STREAM.length));
		if (event.type === "fleet.SessionGranted") {
			state.initiator = partyOf(data, "initiator");
			state.acceptor = partyOf(data, "acceptor");
			return;
		}
		if (event.type !== "fleet.SessionClosed") return;
		state.closes.set(textOf(data, "memberId"), {
			sent: numberOf(data, "bytesSent"),
			received: numberOf(data, "bytesReceived"),
		});
		if (data.billed === true) state.billed = true;
	}

	function apply(event: EventEnvelope): void {
		const data = objectOf(event.data);
		if (event.streamId.startsWith(WORK_STREAM)) applyWork(event, data);
		else if (event.streamId.startsWith(SESSION_STREAM))
			applySession(event, data);
		else return;
		heads.set(event.streamId, event.seq);
		const meta = objectOf(event.meta);
		const key = textOf(meta, "busStream");
		const sequence = numberOf(meta, "busSequence");
		if (key.length > 0 && sequence > (resume.get(key) ?? 0))
			resume.set(key, sequence);
	}

	/** Folds every event appended since the last read; one reader at a time. */
	function catchUp(): Promise<void> {
		const run = reading.then(async () => {
			const options = position === undefined ? {} : { after: position };
			for await (const positioned of deps.store.readAll(options)) {
				apply(positioned.event);
				position = positioned.position;
			}
		});
		reading = run.catch(() => {});
		return run;
	}

	// ── Appending ──────────────────────────────────────────────────────────

	/** Appends one event idempotently; true when this call recorded it first. */
	async function record(
		stream: string,
		input: EventInput<JsonObject>,
		envelope: SignedEnvelope,
		bus: string,
		sequence: number,
	): Promise<boolean> {
		const event: EventInput<JsonObject> = {
			...input,
			meta: {
				busStream: bus,
				busSequence: sequence,
				idempotencyKey: `${input.type}:${sha256Hex(envelope.payload)}`,
			},
		};
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			try {
				const result = await deps.store.append(stream, [event], {
					expectedSeq: heads.get(stream) ?? 0,
					actor: ACTOR,
					tenant: deps.tenant,
				});
				await catchUp();
				const fresh = result.appended.length > 0;
				if (fresh) {
					const name = logNameOf(input.type);
					if (name !== undefined)
						deps.log(name, { subject: stream, tenant: deps.tenant });
				}
				return fresh;
			} catch (error) {
				if (
					!(error instanceof EventStoreError) ||
					error.code !== "OPTIMISTIC_SEQUENCE_CONFLICT"
				)
					throw error;
				await catchUp();
			}
		}
		throw new Error(`recorder: compare-and-set on ${stream} kept failing`);
	}

	function refuse(kind: string, reason: string, sequence: number): void {
		refusals += 1;
		deps.log("hobo_fleet_bus_status", {
			recorder: "unverifiable",
			kind,
			reason,
			sequence,
			count: refusals,
		});
	}

	async function emit(
		eventType: UsageEventType,
		resource: string,
		quantity: number,
		unit: string,
		metadata: Readonly<Record<string, string | number | boolean>>,
	): Promise<void> {
		await deps.metering.emit(
			createUsageEvent({
				tenantId: deps.tenant,
				eventType,
				resource,
				quantity,
				unit,
				metadata,
				timestamp: new Date(deps.now()).toISOString(),
			}),
		);
	}

	function digestOf(text: string): WorkDigest | undefined {
		try {
			return parseWorkDigest(text);
		} catch {
			return undefined;
		}
	}

	/** The submission id of an offer's authority-signed submission, when it verifies. */
	function submissionOf(offer: WorkOffer): string {
		const envelope = offer.submission;
		if (envelope === undefined) return "";
		const key = deps.bus.registry
			.trust()
			.authorityKeys.find((candidate) => candidate.keyId === envelope.keyId);
		if (
			key === undefined ||
			!verifyEnvelope(envelope, WORK_SUBMISSION_CONTEXT, key)
		)
			return "";
		try {
			return fromBinary(WorkSubmissionSchema, envelope.payload).submissionId;
		} catch {
			return "";
		}
	}

	// ── Handlers, one per bus feed ─────────────────────────────────────────

	async function onOffer(
		envelope: SignedEnvelope,
		fleet: FleetId,
		sequence: number,
	): Promise<void> {
		const checked = await verifySigned(
			deps.bus.registry,
			envelope,
			OFFER_CONTEXT,
			WorkOfferSchema,
		);
		if (!checked.ok) return refuse("offer", checked.reason, sequence);
		const offer = checked.value;
		if (!dispatches(checked.signer, offer.fleet))
			return refuse("offer", "not-dispatcher", sequence);
		if (offer.dispatcher !== checked.signer.memberId)
			return refuse("offer", "signer-mismatch", sequence);
		const digest = digestOf(offer.workDigest);
		if (offer.fleet !== fleet || digest === undefined)
			return refuse("offer", "payload", sequence);
		await record(
			`${WORK_STREAM}${digest}`,
			{
				type: "fleet.WorkOffered",
				data: {
					workDigest: digest,
					fleet: offer.fleet,
					kind: offer.kind,
					workKey: offer.workKey,
					label: offer.label,
					dispatcher: offer.dispatcher,
					submissionId: submissionOf(offer),
					queuedAt: offer.queuedAt,
					expiresAt: offer.expiresAt,
				},
			},
			envelope,
			`${BUS.offers}.${fleet}`,
			sequence,
		);
	}

	async function onClaim(
		envelope: SignedEnvelope,
		fleet: FleetId,
		digest: WorkDigest,
		sequence: number,
	): Promise<void> {
		const checked = await verifySigned(
			deps.bus.registry,
			envelope,
			CLAIM_CONTEXT,
			ClaimSchema,
		);
		if (!checked.ok) return refuse("claim", checked.reason, sequence);
		const claim = checked.value;
		if (claim.memberId !== checked.signer.memberId)
			return refuse("claim", "signer-mismatch", sequence);
		if (claim.fleet !== fleet || claim.workDigest !== digest)
			return refuse("claim", "payload", sequence);
		await record(
			`${WORK_STREAM}${digest}`,
			{
				type: "fleet.WorkClaimed",
				data: {
					workDigest: digest,
					fleet,
					memberId: claim.memberId,
					dispatcher: claim.dispatcher,
					rank: claim.rank,
					sandboxTier: SandboxTier[claim.sandboxTier],
					claimedAt: claim.claimedAt,
				},
			},
			envelope,
			`${BUS.claims}.${fleet}`,
			sequence,
		);
	}

	async function onOrder(
		envelope: SignedEnvelope,
		to: MemberId,
		sequence: number,
	): Promise<void> {
		const checked = await verifySigned(
			deps.bus.registry,
			envelope,
			ORDER_CONTEXT,
			WorkOrderSchema,
		);
		if (!checked.ok) return refuse("order", checked.reason, sequence);
		const order = checked.value;
		const fleet = order.offer?.fleet ?? "";
		if (!dispatches(checked.signer, fleet))
			return refuse("order", "not-dispatcher", sequence);
		if (order.offer?.dispatcher !== checked.signer.memberId)
			return refuse("order", "signer-mismatch", sequence);
		const digest = digestOf(order.offer?.workDigest ?? "");
		if (order.memberId !== to || digest === undefined)
			return refuse("order", "payload", sequence);
		watch(fleet);
		// The signed part only: the sealed secret is never journalled (§11.3 rule 11).
		await record(
			`${WORK_STREAM}${digest}`,
			{
				type: "fleet.WorkOrdered",
				data: {
					workDigest: digest,
					fleet,
					orderId: order.orderId,
					memberId: order.memberId,
					dispatcher: checked.signer.memberId,
					sandboxTier: SandboxTier[order.sandboxTier],
					egressAllow: [...order.egressAllow],
					issuedAt: order.issuedAt,
					expiresAt: order.expiresAt,
				},
			},
			envelope,
			BUS.orders,
			sequence,
		);
	}

	async function onReceipt(
		envelope: SignedEnvelope,
		from: MemberId,
		sequence: number,
	): Promise<void> {
		const checked = await verifySigned(
			deps.bus.registry,
			envelope,
			RECEIPT_CONTEXT,
			WorkReceiptSchema,
		);
		if (!checked.ok) return refuse("receipt", checked.reason, sequence);
		const receipt = checked.value;
		if (
			checked.signer.memberId !== from ||
			receipt.memberId !== checked.signer.memberId
		)
			return refuse("receipt", "signer-mismatch", sequence);
		const type = RECEIPT_EVENTS.get(receipt.status);
		const digest = digestOf(receipt.workDigest);
		if (type === undefined || digest === undefined)
			return refuse("receipt", "payload", sequence);
		const fresh = await record(
			`${WORK_STREAM}${digest}`,
			{
				type,
				data: {
					workDigest: digest,
					orderId: receipt.orderId,
					memberId: receipt.memberId,
					status: ReceiptStatus[receipt.status],
					reason: receipt.reason,
					at: receipt.at,
					sandboxSeconds: receipt.sandboxSeconds,
					receipt: json(WorkReceiptSchema, receipt),
				},
			},
			envelope,
			BUS.events,
			sequence,
		);
		if (fresh && receipt.sandboxSeconds > 0)
			await emit(
				"fleet.work.sandbox",
				receipt.orderId,
				receipt.sandboxSeconds,
				"second",
				{
					tier: SandboxTier[receipt.sandboxTier],
					memberId: receipt.memberId,
					workDigest: digest,
				},
			);
	}

	async function onSessionClose(
		envelope: SignedEnvelope,
		from: MemberId,
		sequence: number,
	): Promise<void> {
		const checked = await verifySigned(
			deps.bus.registry,
			envelope,
			SESSION_CLOSE_CONTEXT,
			SessionCloseSchema,
		);
		if (!checked.ok) return refuse("session-close", checked.reason, sequence);
		const close = checked.value;
		if (
			checked.signer.memberId !== from ||
			close.memberId !== checked.signer.memberId
		)
			return refuse("session-close", "signer-mismatch", sequence);
		const usage: UsageEventType | undefined =
			close.transport === "bus-relay"
				? "fleet.transport.relay"
				: close.transport === "p2p" || close.transport === "overlay"
					? "fleet.transport.direct"
					: undefined;
		if (!SESSION_ID.test(close.sessionId) || usage === undefined)
			return refuse("session-close", "payload", sequence);
		await catchUp();
		const state = sessions.get(close.sessionId);
		// The acceptor's fact bills; with no grant on record, the first close does.
		const acceptor = state?.acceptor ?? "";
		const bills =
			state?.billed !== true &&
			(acceptor.length === 0 || acceptor === close.memberId);
		const sent = Number(close.bytesSent);
		const received = Number(close.bytesReceived);
		const fresh = await record(
			`${SESSION_STREAM}${close.sessionId}`,
			{
				type: "fleet.SessionClosed",
				data: {
					sessionId: close.sessionId,
					memberId: close.memberId,
					transport: close.transport,
					bytesSent: sent,
					bytesReceived: received,
					at: close.at,
					billed: bills,
				},
			},
			envelope,
			BUS.events,
			sequence,
		);
		if (!fresh || !bills) return;
		const other = [...(state?.closes.entries() ?? [])].find(
			([member]) => member !== close.memberId,
		)?.[1];
		const crossChecked =
			other !== undefined && other.sent === received && other.received === sent;
		await emit(usage, close.sessionId, sent + received, "byte", {
			transport: close.transport,
			memberId: close.memberId,
			crossChecked,
			// The initiator's figures disagree with the acceptor's: billed as the acceptor says, flagged.
			mismatch: other !== undefined && !crossChecked,
		});
	}

	async function onLog(
		envelope: SignedEnvelope,
		from: MemberId,
		sequence: number,
	): Promise<void> {
		const checked: Checked<WorkLogChunk> = await verifySigned(
			deps.bus.registry,
			envelope,
			LOG_CONTEXT,
			WorkLogChunkSchema,
		);
		if (!checked.ok) return refuse("log", checked.reason, sequence);
		if (checked.signer.memberId !== from)
			return refuse("log", "signer-mismatch", sequence);
		const chunk = checked.value;
		const chunks = logs.get(chunk.orderId) ?? new Map<string, LogEntry>();
		const key = `${from}.${chunk.sequence}`;
		if (!chunks.has(key)) chunks.set(key, { chunk, from });
		logs.set(chunk.orderId, chunks);
	}

	// ── Subscriptions ──────────────────────────────────────────────────────

	/** Serialises every recording step, so stream heads stay in order. */
	function serial(task: () => Promise<void>): Promise<void> {
		const run = chain.then(task).catch((error: Error) => {
			deps.log("hobo_fleet_bus_status", {
				recorder: "error",
				message: error.message,
			});
		});
		chain = run;
		return run;
	}

	function from(key: string): BusStart {
		const after = resume.get(key);
		return after === undefined ? "start" : { after };
	}

	function watch(fleetText: string): void {
		if (!running || fleetText.length === 0) return;
		let fleet: FleetId;
		try {
			fleet = parseFleetId(fleetText);
		} catch {
			return;
		}
		if (fleetsWatched.has(fleet)) return;
		fleetsWatched.add(fleet);
		subscriptions.push(
			deps.bus.offers.subscribe(
				[fleet],
				from(`${BUS.offers}.${fleet}`),
				(envelope, sequence) =>
					serial(() => onOffer(envelope, fleet, sequence)),
			),
			deps.bus.claims.subscribe(
				[fleet],
				from(`${BUS.claims}.${fleet}`),
				(envelope, claimFleet, digest, sequence) =>
					serial(() => onClaim(envelope, claimFleet, digest, sequence)),
			),
		);
	}

	async function scanFleets(): Promise<void> {
		for (const fleet of await deps.bus.registry.fleets()) watch(fleet.fleetId);
	}

	async function begin(): Promise<void> {
		await catchUp();
		if (!running) return;
		subscriptions.push(
			deps.bus.orders.observeAll(from(BUS.orders), (envelope, to, sequence) =>
				serial(() => onOrder(envelope, to, sequence)),
			),
			deps.bus.events.subscribe(
				["receipt", "session-close"],
				from(BUS.events),
				(envelope, member, kind, sequence) =>
					serial(() =>
						kind === "receipt"
							? onReceipt(envelope, member, sequence)
							: onSessionClose(envelope, member, sequence),
					),
			),
			deps.bus.events.subscribe(
				["log"],
				"start",
				(envelope, member, _kind, sequence) =>
					serial(() => onLog(envelope, member, sequence)),
			),
		);
		await scanFleets();
	}

	function statusOf(digest: WorkDigest, state: WorkState): WorkStatus {
		return create(WorkStatusSchema, {
			submissionId: state.submissionId,
			workDigest: digest,
			memberId: state.memberId,
			status: state.status,
			reason: state.reason,
			outputDigest: state.outputDigest,
			updatedAt: state.updatedAt,
		});
	}

	async function find(
		submissionId: string,
	): Promise<Outcome<Readonly<{ digest: WorkDigest; state: WorkState }>>> {
		await catchUp();
		const digest = submissions.get(submissionId);
		const state = digest === undefined ? undefined : works.get(digest);
		if (digest === undefined || state === undefined)
			return {
				ok: false,
				error: {
					code: "work-unknown",
					message: `no work ${submissionId}`,
					detail: { submissionId },
				},
			};
		return { ok: true, value: { digest, state } };
	}

	return {
		start(): void {
			if (running) return;
			running = true;
			void begin().catch((error: Error) =>
				deps.log("hobo_fleet_bus_status", {
					recorder: "error",
					message: error.message,
				}),
			);
			scan = setInterval(() => {
				void scanFleets().catch(() => {});
			}, FLEET_SCAN_MS);
			scan.unref?.();
		},
		async stop(): Promise<void> {
			running = false;
			if (scan !== undefined) clearInterval(scan);
			scan = undefined;
			const stopping = subscriptions;
			subscriptions = [];
			fleetsWatched.clear();
			await Promise.all(stopping.map((subscription) => subscription.stop()));
			await chain;
		},
		async workStatus(submissionId: string): Promise<Outcome<WorkStatus>> {
			const found = await find(submissionId);
			if (!found.ok) return found;
			return {
				ok: true,
				value: statusOf(found.value.digest, found.value.state),
			};
		},
		async workLogs(submissionId: string): Promise<Outcome<WorkLogs>> {
			const found = await find(submissionId);
			if (!found.ok) return found;
			const { state } = found.value;
			const owner = state.orders.get(state.latestOrder);
			const chunks = [...(logs.get(state.latestOrder)?.values() ?? [])]
				.filter((entry) => entry.from === owner)
				.map((entry) => entry.chunk)
				.sort((a, b) => a.sequence - b.sequence);
			const first = chunks[0];
			const last = chunks.at(-1);
			const complete =
				first !== undefined &&
				last?.last === true &&
				last.sequence - first.sequence + 1 === chunks.length;
			return {
				ok: true,
				value: create(WorkLogsSchema, { chunks, complete }),
			};
		},
		reliability(): ReadonlyMap<MemberId, ReliabilitySamples> {
			return ledger.samples();
		},
	};
}
