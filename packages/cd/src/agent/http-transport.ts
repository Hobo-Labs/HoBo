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
import { CD_DEFAULTS } from "../events.js";
import { feedRefusal } from "../feed/errors.js";
import {
	isNumber,
	isText,
	isWireObject,
	type WireObject,
} from "../feed/json.js";
import { decodeSse, FEED_SSE_EVENTS } from "../feed/sse.js";
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
import { agentRefusal, messageOf } from "./errors.js";

export type HttpTransportDeps = Readonly<{
	baseUrl: string;
	http: HttpTransport;
	reconcilerId: ReconcilerId;
	privateJwk: JsonObject;
	svid: string;
	now: () => number;
}>;

/** Thrown by `feed()` when the Station refuses the feed; carries the typed reasons. */
export class FeedRefusedError extends Error {
	readonly code: string;
	readonly reasons: readonly ReasonRecord[];
	constructor(refusal: Refusal) {
		super(refusal.reasons.map((r) => `${r.code}: ${r.message}`).join("; "));
		this.name = "FeedRefusedError";
		this.code = refusal.reasons[0]?.code ?? "";
		this.reasons = refusal.reasons;
	}
}

const MAX_RESUMES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

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
	const inline = new Map<string, string>();
	const fedLeases = new Set<string>();

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
		try {
			const response = await http(request);
			return {
				ok: true,
				value: { status: response.status, body: response.body },
			};
		} catch (error) {
			if (isEgressRefusal(error))
				return agentRefusal("egress-refused", messageOf(error));
			return agentRefusal("station-unavailable", messageOf(error));
		}
	}

	async function ensureSvid(): Promise<Outcome<true>> {
		if (d.now() < svidExpiresAtMs - CD_DEFAULTS.svidRefreshBeforeExpiryMs)
			return { ok: true, value: true };
		const live = d.now() < svidExpiresAtMs;
		const raw = live
			? await send("POST", FEED_ROUTES.svidRefresh, { body: {} })
			: await send("POST", FEED_ROUTES.svidRefresh, {
					body: { reconcilerId: d.reconcilerId },
					bearer: false,
				});
		if (!raw.ok) return raw;
		const envelope = parseEnvelope(raw.value.body);
		if (!envelope.ok) {
			// An SVID that expired between the check and the call is re-activated by key possession.
			if (live && envelope.reasons[0]?.code === "svid-expired") {
				svidExpiresAtMs = 0;
				return ensureSvid();
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
		return parseEnvelope(raw.value.body);
	}

	function leaseOf(value: PbJsonValue): Outcome<ReconcilerLease> {
		const lease = parseLease(value);
		return lease.ok
			? lease
			: agentRefusal("response-invalid", "lease response does not parse");
	}

	function changeOf(frame: DeliveryFeedFrame): DesiredStateChange | undefined {
		if (!frame.set) return undefined;
		let position: EventPosition;
		try {
			position = parseEventPosition(frame.position);
		} catch {
			return undefined;
		}
		if (frame.resolvedSetJson)
			inline.set(frame.set.setId, frame.resolvedSetJson);
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
		const key = `${lease.campId}#${lease.fence.toString(10)}`;
		const redeliver = !fedLeases.has(key);
		fedLeases.add(key);
		let lastId: string | undefined;
		for (
			let attempt = 0;
			attempt <= MAX_RESUMES && !signal.aborted;
			attempt += 1
		) {
			const fresh = await ensureSvid();
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
			if (!raw.ok) throw new FeedRefusedError(raw);
			if (raw.value.status !== 200) {
				const envelope = parseEnvelope(raw.value.body);
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
				if (message.event === FEED_SSE_EVENTS.end) {
					ended = true;
					break;
				}
				if (message.event !== FEED_SSE_EVENTS.frame || message.id === undefined)
					continue;
				if (lastId !== undefined && BigInt(message.id) <= BigInt(lastId))
					continue;
				let frame: DeliveryFeedFrame;
				try {
					frame = fromJson(DeliveryFeedFrameSchema, JSON.parse(message.data), {
						ignoreUnknownFields: true,
					});
				} catch {
					throw new FeedRefusedError(
						agentRefusal(
							"response-invalid",
							`frame ${message.id} does not parse`,
						),
					);
				}
				const change = changeOf(frame);
				if (!change || frame.set?.campId !== lease.campId)
					throw new FeedRefusedError(
						agentRefusal(
							"response-invalid",
							`frame ${message.id} is not for Camp ${lease.campId}`,
						),
					);
				lastId = message.id;
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
				`Set ${set.setId} belongs to Camp ${set.campId}, not ${lease.campId}`,
				set.setId,
			);
		let text = inline.get(set.setId);
		if (text === undefined) {
			const fresh = await ensureSvid();
			if (!fresh.ok) return fresh;
			const raw = await send(
				"GET",
				`${FEED_ROUTES.blobs}${encodeURIComponent(set.resolvedSetDigest)}?camp=${encodeURIComponent(lease.campId)}`,
			);
			if (!raw.ok) return raw;
			if (raw.value.status !== 200) {
				const envelope = parseEnvelope(raw.value.body);
				if (envelope.ok)
					return agentRefusal(
						"response-invalid",
						`blob answered ${raw.value.status}`,
					);
				const code = envelope.reasons[0]?.code;
				if (code === "blob-missing")
					return feedRefusal(
						"resolved-set-missing",
						envelope.reasons[0]?.message ?? "",
						set.setId,
					);
				if (code === "blob-corrupt")
					return feedRefusal(
						"resolved-set-mismatch",
						envelope.reasons[0]?.message ?? "",
						set.setId,
					);
				return envelope;
			}
			text = raw.value.body;
		}
		return parseResolvedSet(text, set);
	}

	return Object.freeze({
		async claim(input) {
			const value = await call("POST", FEED_ROUTES.leases, {
				campId: input.campId,
				holderId: input.holderId,
				ttlMs: input.ttlMs,
			});
			return value.ok ? leaseOf(value.value) : value;
		},
		async renew(lease) {
			const value = await call("POST", FEED_ROUTES.leaseRenew, {
				lease: leaseJson(lease),
			});
			return value.ok ? leaseOf(value.value) : value;
		},
		async release(lease) {
			fedLeases.delete(`${lease.campId}#${lease.fence.toString(10)}`);
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
			`resolved set bytes hash to ${digest}, not ${set.resolvedSetDigest}`,
			set.setId,
		);
	let json: PbJsonValue;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return feedRefusal(
			"resolved-set-mismatch",
			`resolved set does not parse: ${messageOf(error)}`,
			set.setId,
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
			set.setId,
		);
	if (json.contentHash !== set.contentHash || json.campId !== set.campId)
		return feedRefusal(
			"resolved-set-mismatch",
			`resolved set content ${json.contentHash} does not match Set ${set.contentHash}`,
			set.setId,
		);
	return { ok: true, value: Object.freeze(asResolvedSet(json)) };
}

/** Called only by parseResolvedSet after the digest anchor and the structural checks. */
function asResolvedSet(json: WireObject): ResolvedDeploymentSet {
	// SAFETY: the digest binds these bytes to the gated Set and every member was checked by parseResolvedSet.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: protobuf JSON and the cloud type share no declared relation; the checks above are the parser.
	return json as unknown as ResolvedDeploymentSet;
}
