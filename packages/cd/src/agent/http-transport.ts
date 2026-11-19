// The agent-side ReconcilerTransport (D5 `agent` mode). It speaks the
// delivery feed (../feed) over the host's HttpTransport, outbound HTTPS only
// (./egress.ts). Every request carries `Authorization: DPoP <JWT-SVID>` and a
// fresh single-use DPoP proof (`htm`, `htu`, `iat`, `jti`, `ath`) signed by
// the agent key, which never leaves the process. The SVID is refreshed
// before expiry (5 min by default) and re-activated by key possession if it
// lapsed. Target credentials stay with the agent's Realizer: nothing here
// carries one.
//
// Feed semantics match the in-process transport: the first feed of a lease
// re-delivers the Camp's current change when nothing newer exists; a cut-off
// SSE response (no `end` event) resumes with `Last-Event-ID`, so changes are
// neither skipped nor repeated.
import { createHash, randomUUID } from "node:crypto";
import {
	fromJson,
	type JsonValue as PbJsonValue,
	toJson,
} from "@bufbuild/protobuf";
import { RESOLVED_SET_SCHEMA, type ResolvedDeploymentSet } from "@hobo/cloud";
import {
	type EventPosition,
	type HttpTransport,
	type JsonObject,
	parseEventPosition,
	type TransportMethod,
	type TransportRequest,
} from "@hobo/core";
import {
	type DeliveryFeedFrame,
	DeliveryFeedFrameSchema,
	type ReasonRecord,
	ReconcileObservationRecordSchema,
	type SetRecord,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, FEED_INLINE_LIMIT_BYTES } from "../events.js";
import { FEED_FAILURES, feedRefusal } from "../feed/errors.js";
import {
	isNumber,
	isText,
	isWireObject,
	type WireObject,
} from "../feed/json.js";
import { decodeSse, FEED_END_REASONS, FEED_SSE_EVENTS } from "../feed/sse.js";
import {
	FEED_ROUTES,
	leaseJson,
	parseEnvelope,
	parseLease,
	parsePosition,
} from "../feed/wire.js";
import type {
	DesiredStateChange,
	Outcome,
	ReconcilerId,
	ReconcilerLease,
	ReconcilerTransport,
	Refusal,
} from "../ports.js";
import { createDpopProof, type DpopProofInput } from "./dpop.js";
import {
	AGENT_MAX_RESPONSE_BYTES,
	AGENT_MAX_TIMEOUT_MS,
	isEgressRefusal,
	parseStationOrigin,
	stationTransport,
} from "./egress.js";
import { AGENT_FAILURES, agentRefusal, reasonOf } from "./errors.js";

export type HttpTransportDeps = Readonly<{
	baseUrl: string;
	http: HttpTransport;
	reconcilerId: ReconcilerId;
	privateJwk: JsonObject;
	svid: string;
	now: () => number;
}>;

const STATION_FAILURES = new Map([
	...Object.entries(AGENT_FAILURES),
	...Object.entries(FEED_FAILURES),
]);

function safeStationRefusal(refusal: Refusal): Refusal {
	const reasons = refusal.reasons.map((reason) => {
		const spec = STATION_FAILURES.get(reason.code);
		return spec
			? reasonOf(
					reason.code,
					"The Station refused the request.",
					spec.remediation,
					"",
				)
			: reasonOf(
					"response-invalid",
					"The Station returned an unrecognized refusal.",
					AGENT_FAILURES["response-invalid"].remediation,
					"",
				);
	});
	return reasons.length > 0
		? { ok: false, reasons }
		: agentRefusal(
				"response-invalid",
				"The Station returned an invalid refusal.",
			);
}

function stationEnvelope(text: string, status: number): Outcome<PbJsonValue> {
	const parsed = parseEnvelope(text);
	if (parsed.ok && (status < 200 || status >= 300))
		return agentRefusal(
			"response-invalid",
			"The Station response status is invalid.",
		);
	return parsed.ok ? parsed : safeStationRefusal(parsed);
}

/** Thrown by `feed()` when the Station refuses the feed; carries the typed reasons. */
export class FeedRefusedError extends Error {
	readonly code: string;
	readonly reasons: readonly ReasonRecord[];
	constructor(refusal: Refusal) {
		const safe = safeStationRefusal(refusal);
		super(safe.reasons.map((r) => `${r.code}: ${r.message}`).join("; "));
		this.name = "FeedRefusedError";
		this.code = safe.reasons[0]?.code ?? "";
		this.reasons = safe.reasons;
	}
}

const MAX_RESUMES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const VALID_END_REASONS: ReadonlySet<string> = new Set(FEED_END_REASONS);
const MAX_INLINE_ENTRIES = 16;
const MAX_INLINE_CACHE_BYTES = MAX_INLINE_ENTRIES * FEED_INLINE_LIMIT_BYTES;

function inlineKey(set: SetRecord): string {
	return JSON.stringify([set.campId, set.setId, set.resolvedSetDigest]);
}

function expOf(svid: string): number {
	try {
		const claims: PbJsonValue = JSON.parse(
			Buffer.from(svid.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		return isWireObject(claims) && isNumber(claims.exp) ? claims.exp * 1000 : 0;
	} catch {
		return 0;
	}
}

export function createHttpTransport(d: HttpTransportDeps): ReconcilerTransport {
	const origin = parseStationOrigin(d.baseUrl);
	const http = stationTransport(origin, d.http);
	let svid = d.svid;
	let svidExpiresAtMs = expOf(svid);
	const inline = new Map<string, Readonly<{ text: string; bytes: number }>>();
	let inlineBytes = 0;
	const fedLeases = new Map<
		ReconcilerLease["campId"],
		ReconcilerLease["fence"]
	>();

	function rememberInline(set: SetRecord, text: string): void {
		const textBytes = Buffer.byteLength(text, "utf8");
		if (textBytes > FEED_INLINE_LIMIT_BYTES) return;
		const key = inlineKey(set);
		const bytes = textBytes + Buffer.byteLength(key, "utf8");
		if (bytes > MAX_INLINE_CACHE_BYTES) return;
		const existing = inline.get(key);
		if (existing) inlineBytes -= existing.bytes;
		inline.delete(key);
		while (
			inline.size >= MAX_INLINE_ENTRIES ||
			inlineBytes + bytes > MAX_INLINE_CACHE_BYTES
		) {
			const oldest = inline.keys().next().value;
			if (oldest === undefined) break;
			inlineBytes -= inline.get(oldest)?.bytes ?? 0;
			inline.delete(oldest);
		}
		inline.set(key, { text, bytes });
		inlineBytes += bytes;
	}

	type Raw = Readonly<{ status: number; body: string }>;

	async function send(
		method: TransportMethod,
		path: string,
		options: Readonly<{
			body?: JsonObject;
			headers?: Readonly<Record<string, string>>;
			bearer?: boolean;
			timeoutMs?: number;
		}> = {},
	): Promise<Outcome<Raw>> {
		try {
			const url = `${origin.origin}${path}`;
			const bearer = options.bearer !== false;
			const proofBase = {
				privateJwk: d.privateJwk,
				method,
				url,
				iatSeconds: Math.floor(d.now() / 1000),
				jti: randomUUID(),
			};
			const proofInput: DpopProofInput = bearer
				? { ...proofBase, accessToken: svid }
				: proofBase;
			const headers = new Map<string, string>([
				["dpop", createDpopProof(proofInput)],
				["accept", "application/json, text/event-stream"],
			]);
			for (const [key, value] of Object.entries(options.headers ?? {}))
				headers.set(key, value);
			if (bearer) headers.set("authorization", `DPoP ${svid}`);
			if (options.body) headers.set("content-type", "application/json");
			const base = {
				method,
				url,
				headers: Object.fromEntries(headers),
				timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
				maxResponseBytes: AGENT_MAX_RESPONSE_BYTES,
			};
			const request: TransportRequest = options.body
				? { ...base, body: JSON.stringify(options.body) }
				: base;
			const response = await http(request);
			if (
				!Number.isInteger(response.status) ||
				response.status < 100 ||
				response.status > 599 ||
				!isText(response.body)
			)
				return agentRefusal(
					"response-invalid",
					"The Station response is invalid.",
				);
			return {
				ok: true,
				value: { status: response.status, body: response.body },
			};
		} catch (error) {
			let egress = false;
			try {
				egress = isEgressRefusal(error);
			} catch {}
			return egress
				? agentRefusal(
						"egress-refused",
						"The Station egress policy refused the request.",
					)
				: agentRefusal(
						"station-unavailable",
						"The Station request could not be completed.",
					);
		}
	}

	async function ensureSvid(signal?: AbortSignal): Promise<Outcome<true>> {
		if (signal?.aborted)
			return agentRefusal(
				"station-unavailable",
				"The Station request was cancelled.",
			);
		if (d.now() < svidExpiresAtMs - CD_DEFAULTS.svidRefreshBeforeExpiryMs)
			return { ok: true, value: true };
		const live = d.now() < svidExpiresAtMs;
		const raw = live
			? await send("POST", FEED_ROUTES.svidRefresh, { body: {} })
			: await send("POST", FEED_ROUTES.svidRefresh, {
					body: { reconcilerId: d.reconcilerId },
					bearer: false,
				});
		if (signal?.aborted)
			return agentRefusal(
				"station-unavailable",
				"The Station request was cancelled.",
			);
		if (!raw.ok) return raw;
		const envelope = stationEnvelope(raw.value.body, raw.value.status);
		if (!envelope.ok) {
			// An SVID that expired between the check and the call is re-activated by key possession.
			if (live && envelope.reasons[0]?.code === "svid-expired") {
				svidExpiresAtMs = 0;
				return ensureSvid(signal);
			}
			return envelope;
		}
		const value = envelope.value;
		if (
			!isWireObject(value) ||
			!isText(value.svid) ||
			!isNumber(value.expiresAtMs)
		)
			return agentRefusal(
				"response-invalid",
				"svid response lacks svid/expiresAtMs",
			);
		svid = value.svid;
		svidExpiresAtMs = value.expiresAtMs;
		return { ok: true, value: true };
	}

	async function call(
		method: TransportMethod,
		path: string,
		body?: JsonObject,
	): Promise<Outcome<PbJsonValue>> {
		const fresh = await ensureSvid();
		if (!fresh.ok) return fresh;
		const raw =
			body === undefined
				? await send(method, path)
				: await send(method, path, { body });
		if (!raw.ok) return raw;
		return stationEnvelope(raw.value.body, raw.value.status);
	}

	function leaseOf(
		value: PbJsonValue,
		expected: Pick<ReconcilerLease, "campId" | "reconcilerId" | "holderId"> &
			Partial<Pick<ReconcilerLease, "fence">>,
	): Outcome<ReconcilerLease> {
		const lease = parseLease(value);
		if (
			!lease.ok ||
			lease.value.campId !== expected.campId ||
			lease.value.reconcilerId !== expected.reconcilerId ||
			lease.value.holderId !== expected.holderId ||
			(expected.fence !== undefined && lease.value.fence !== expected.fence) ||
			!Number.isSafeInteger(lease.value.expiresAtMs) ||
			lease.value.expiresAtMs <= d.now()
		)
			return agentRefusal(
				"response-invalid",
				"The Station returned an invalid lease.",
			);
		return lease;
	}

	function changeOf(frame: DeliveryFeedFrame): DesiredStateChange | undefined {
		if (!frame.set) return undefined;
		let position: EventPosition;
		try {
			position = parseEventPosition(frame.position);
		} catch {
			return undefined;
		}
		if (frame.resolvedSetJson) rememberInline(frame.set, frame.resolvedSetJson);
		const base = {
			position,
			set: frame.set,
			observeFields: Object.freeze([...frame.observeFields]),
			management: frame.management,
		};
		const change: DesiredStateChange = frame.policy
			? { ...base, policy: frame.policy }
			: base;
		return Object.freeze(change);
	}

	async function* feed(
		input: Readonly<{ lease: ReconcilerLease; signal: AbortSignal }>,
	): AsyncIterable<DesiredStateChange> {
		const { lease, signal } = input;
		const redeliver = fedLeases.get(lease.campId) !== lease.fence;
		let lastId: string | undefined;
		let lastPosition: EventPosition | undefined;
		for (
			let attempt = 0;
			attempt <= MAX_RESUMES && !signal.aborted;
			attempt += 1
		) {
			const fresh = await ensureSvid(signal);
			if (signal.aborted) return;
			if (!fresh.ok) throw new FeedRefusedError(fresh);
			const query = new URLSearchParams({
				camp: lease.campId,
				holder: lease.holderId,
				fence: lease.fence.toString(10),
			});
			if (redeliver && lastId === undefined) query.set("redeliver", "1");
			const raw = await send("GET", `${FEED_ROUTES.feed}?${query.toString()}`, {
				headers: lastId === undefined ? {} : { "last-event-id": lastId },
				timeoutMs: Math.min(
					AGENT_MAX_TIMEOUT_MS,
					CD_DEFAULTS.feedLongPollMs + 30_000,
				),
			});
			if (signal.aborted) return;
			if (!raw.ok) throw new FeedRefusedError(raw);
			if (raw.value.status !== 200) {
				const envelope = stationEnvelope(raw.value.body, raw.value.status);
				throw new FeedRefusedError(
					envelope.ok
						? agentRefusal(
								"response-invalid",
								`feed answered ${raw.value.status}`,
							)
						: envelope,
				);
			}
			let ended = false;
			for (const message of decodeSse(raw.value.body)) {
				if (signal.aborted) return;
				if (message.event === FEED_SSE_EVENTS.end) {
					let valid = false;
					try {
						const payload: PbJsonValue = JSON.parse(message.data);
						valid =
							isWireObject(payload) &&
							isText(payload.reason) &&
							VALID_END_REASONS.has(payload.reason);
					} catch {}
					if (!valid)
						throw new FeedRefusedError(
							agentRefusal("response-invalid", "The feed end is invalid."),
						);
					fedLeases.set(lease.campId, lease.fence);
					ended = true;
					break;
				}
				if (message.event !== FEED_SSE_EVENTS.frame) continue;
				if (message.id === undefined)
					throw new FeedRefusedError(
						agentRefusal("response-invalid", "The feed frame has no position."),
					);
				const position = parsePosition(message.id);
				if (!position.ok)
					throw new FeedRefusedError(
						agentRefusal(
							"response-invalid",
							"The feed frame position is invalid.",
						),
					);
				if (lastPosition !== undefined && position.value <= lastPosition)
					continue;
				let frame: DeliveryFeedFrame;
				try {
					frame = fromJson(DeliveryFeedFrameSchema, JSON.parse(message.data), {
						ignoreUnknownFields: true,
					});
				} catch {
					throw new FeedRefusedError(
						agentRefusal("response-invalid", "The feed frame is invalid."),
					);
				}
				const framePosition = parsePosition(frame.position);
				if (
					!framePosition.ok ||
					framePosition.value !== position.value ||
					frame.set?.campId !== lease.campId
				)
					throw new FeedRefusedError(
						agentRefusal(
							"response-invalid",
							"The feed frame does not match the requested lease.",
						),
					);
				const change = changeOf(frame);
				if (!change)
					throw new FeedRefusedError(
						agentRefusal("response-invalid", "The feed frame is invalid."),
					);
				lastId = message.id;
				lastPosition = position.value;
				if (signal.aborted) return;
				yield change;
			}
			if (ended) return;
			// Cut off before `end`: resume after the last frame received.
		}
	}

	async function resolved(
		lease: ReconcilerLease,
		set: SetRecord,
	): Promise<Outcome<ResolvedDeploymentSet>> {
		if (set.campId !== lease.campId)
			return feedRefusal(
				"resolved-set-mismatch",
				"The resolved set does not match the requested lease.",
			);
		let text = inline.get(inlineKey(set))?.text;
		if (text === undefined) {
			const fresh = await ensureSvid();
			if (!fresh.ok) return fresh;
			const raw = await send(
				"GET",
				`${FEED_ROUTES.blobs}${encodeURIComponent(set.resolvedSetDigest)}?camp=${encodeURIComponent(lease.campId)}`,
			);
			if (!raw.ok) return raw;
			if (raw.value.status !== 200) {
				const envelope = stationEnvelope(raw.value.body, raw.value.status);
				if (envelope.ok)
					return agentRefusal(
						"response-invalid",
						`blob answered ${raw.value.status}`,
					);
				const code = envelope.reasons[0]?.code;
				if (code === "blob-missing")
					return feedRefusal(
						"resolved-set-missing",
						"The resolved set is unavailable.",
					);
				if (code === "blob-corrupt")
					return feedRefusal(
						"resolved-set-mismatch",
						"The resolved set could not be verified.",
					);
				return envelope;
			}
			text = raw.value.body;
		}
		return parseResolvedSet(text, set);
	}

	return Object.freeze({
		async claim(input) {
			if (input.reconcilerId !== d.reconcilerId)
				return agentRefusal(
					"response-invalid",
					"The requested reconciler does not match this agent.",
				);
			const value = await call("POST", FEED_ROUTES.leases, {
				campId: input.campId,
				holderId: input.holderId,
				ttlMs: input.ttlMs,
			});
			return value.ok ? leaseOf(value.value, input) : value;
		},
		async renew(lease) {
			if (lease.reconcilerId !== d.reconcilerId)
				return agentRefusal(
					"response-invalid",
					"The requested reconciler does not match this agent.",
				);
			const value = await call("POST", FEED_ROUTES.leaseRenew, {
				lease: leaseJson(lease),
			});
			return value.ok ? leaseOf(value.value, lease) : value;
		},
		async release(lease) {
			if (fedLeases.get(lease.campId) === lease.fence)
				fedLeases.delete(lease.campId);
			await call("POST", FEED_ROUTES.leaseRelease, { lease: leaseJson(lease) });
		},
		feed,
		resolved,
		async report(lease, observation) {
			// SAFETY: toJson of a message is always a JSON object.
			const body = toJson(
				ReconcileObservationRecordSchema,
				observation,
			) as JsonObject;
			const value = await call("POST", FEED_ROUTES.observations, {
				lease: leaseJson(lease),
				observation: body,
			});
			if (!value.ok) return value;
			const position = parsePosition(
				isWireObject(value.value) ? value.value.position : undefined,
			);
			return position.ok
				? position
				: agentRefusal("response-invalid", "report response lacks a position");
		},
		async checkpoint(lease, position) {
			const value = await call("POST", FEED_ROUTES.checkpoints, {
				lease: leaseJson(lease),
				position: position.toString(10),
			});
			if (!value.ok) return value;
			const committed = parsePosition(
				isWireObject(value.value) ? value.value.position : undefined,
			);
			return committed.ok
				? committed
				: agentRefusal(
						"response-invalid",
						"checkpoint response lacks a position",
					);
		},
	} satisfies ReconcilerTransport);
}

/**
 * Parse don't validate: a resolved set is accepted only when its bytes hash to
 * the gated Set's `resolved_set_digest` (the integrity anchor: the blob is
 * content-addressed), it is structurally a ResolvedDeploymentSet, and its own
 * `contentHash` and `campId` agree with the Set (promote, never rebuild: I1).
 */
export function parseResolvedSet(
	text: string,
	set: SetRecord,
): Outcome<ResolvedDeploymentSet> {
	const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
	if (digest !== set.resolvedSetDigest)
		return feedRefusal(
			"resolved-set-mismatch",
			"The resolved set bytes do not match the expected digest.",
		);
	let json: PbJsonValue;
	try {
		json = JSON.parse(text);
	} catch {
		return feedRefusal(
			"resolved-set-mismatch",
			"The resolved set is not valid JSON.",
		);
	}
	if (
		!isWireObject(json) ||
		json.schemaVersion !== RESOLVED_SET_SCHEMA ||
		!isWireObject(json.plan) ||
		!Array.isArray(json.plan.resources) ||
		!isWireObject(json.gatekeeper) ||
		!Array.isArray(json.matches) ||
		!Array.isArray(json.secretRefs) ||
		!isText(json.planHash) ||
		!isText(json.contentHash)
	)
		return feedRefusal(
			"resolved-set-mismatch",
			"resolved set is not a hobo.resolved-deployment-set/v1",
		);
	if (json.contentHash !== set.contentHash || json.campId !== set.campId)
		return feedRefusal(
			"resolved-set-mismatch",
			"The resolved set does not match the expected content.",
		);
	return { ok: true, value: Object.freeze(asResolvedSet(json)) };
}

/** Called only by parseResolvedSet after the digest anchor and the structural checks. */
function asResolvedSet(json: WireObject): ResolvedDeploymentSet {
	// SAFETY: the digest binds these bytes to the gated Set and every member was checked by parseResolvedSet.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: protobuf JSON and the cloud type share no declared relation; the checks above are the parser.
	return json as unknown as ResolvedDeploymentSet;
}
