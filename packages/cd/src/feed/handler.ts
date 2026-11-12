// The delivery feed (D5, I3, I24): the Station side of agent-mode pull
// reconciliation, served under `/v1/cd/`. The agent always dials out; the
// Station never opens a connection to an agent and never holds a target
// credential. Every route except enrollment and first activation requires a
// key-bound JWT-SVID plus a single-use DPoP proof, verified by
// AgentEnrollment.verify (revocation is effective on the next request).
//
//   POST enrollments          bootstrap token + public JWK → PENDING / ACCEPTED
//   POST svid/refresh         DPoP only (activate) or SVID + DPoP (refresh)
//   POST leases               claim the per-Camp lease
//   POST leases/renew         renew it (fenced)
//   POST leases/release       release it (fenced)
//   GET  feed                 SSE DeliveryFeedFrames after the committed
//                             checkpoint (or Last-Event-ID); heartbeat;
//                             long-poll; bounded frames per response
//   GET  blobs/{digest}       a resolved-set blob referenced by an accepted Camp
//   POST observations         fenced status report
//   POST checkpoints          fenced, monotonic checkpoint
import {
	fromJson,
	type JsonValue as PbJsonValue,
	toJson,
} from "@bufbuild/protobuf";
import type { EventPosition, JsonObject } from "@hobo/core";
import {
	type CampClaimRecord,
	CampClaimRecordSchema,
	EnrollmentState,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	type ReconcilerRecord,
	ReconcilerRecordSchema,
} from "../_generated/cd_pb.js";
import { messageOf } from "../agent/errors.js";
import { createMeter } from "../agent/metrics.js";
import {
	CD_DEFAULTS,
	OBSERVE_ATTRIBUTES_LIMIT_BYTES,
	RESOLVED_SET_MEDIA_TYPE,
} from "../events.js";
import type {
	AgentEnrollment,
	ArtifactStore,
	CampId,
	CampInventory,
	CdBase,
	CdContext,
	DeliveryFeedHandler,
	DesiredStateChange,
	DesiredStateReader,
	FeedRequest,
	FeedResponse,
	Outcome,
	PostureService,
	ReconcilerId,
	TelemetrySink,
	TopologyReader,
} from "../ports.js";
import { feedRefusal, statusFor } from "./errors.js";
import { buildFrame, frameJson, verifiedBlob } from "./frames.js";
import { createFeedJournal } from "./journal.js";
import { headerOf, isNumber } from "./json.js";
import {
	encodeEnd,
	encodeFrame,
	encodeHeartbeat,
	type FeedEndReason,
} from "./sse.js";
import {
	FEED_MEDIA_TYPES,
	FEED_ROUTES,
	isWireObject,
	leaseJson,
	okBody,
	parseJsonBody,
	parseLease,
	parsePosition,
	refusalBody,
	text,
	type WireObject,
} from "./wire.js";

export type DeliveryFeedDeps = CdBase & {
	readonly desired: DesiredStateReader;
	readonly enrollment: AgentEnrollment;
	readonly artifacts: ArtifactStore;
	readonly posture: PostureService;
	readonly inventory: CampInventory;
	readonly topology: TopologyReader;
	readonly telemetry?: TelemetrySink;
	/** SSE heartbeat interval; default CD_DEFAULTS.feedHeartbeatMs. */
	readonly heartbeatMs?: number;
	/** Long-poll bound of one feed response; default CD_DEFAULTS.feedLongPollMs. */
	readonly longPollMs?: number;
	/** Back-pressure: frames per response; default 64. */
	readonly maxFramesPerResponse?: number;
};

type ChangesQuery = Parameters<DesiredStateReader["changes"]>[0];

const DEFAULT_MAX_FRAMES = 64;
const encoder = new TextEncoder();

function respond(
	status: number,
	body: string,
	contentType: string = FEED_MEDIA_TYPES.json,
): FeedResponse {
	return {
		status,
		headers: { "content-type": contentType, "cache-control": "no-store" },
		body: encoder.encode(body),
	};
}

function refuse(reasons: readonly ReasonRecord[]): FeedResponse {
	return respond(statusFor(reasons[0]?.code ?? ""), refusalBody(reasons));
}

function recordJson(record: ReconcilerRecord): PbJsonValue {
	return toJson(ReconcilerRecordSchema, record);
}

export function createDeliveryFeedHandler(
	d: DeliveryFeedDeps,
): DeliveryFeedHandler {
	const journal = createFeedJournal({ store: d.store, tenant: d.tenant });
	const meter = createMeter(d.telemetry, d.now);
	const heartbeatMs = d.heartbeatMs ?? CD_DEFAULTS.feedHeartbeatMs;
	const longPollMs = d.longPollMs ?? CD_DEFAULTS.feedLongPollMs;
	const maxFrames = d.maxFramesPerResponse ?? DEFAULT_MAX_FRAMES;

	function ctxFor(principal: CdContext["principal"]): CdContext {
		return { tenant: d.tenant, principal, now: d.now };
	}

	async function authenticated(
		request: FeedRequest,
	): Promise<Outcome<ReconcilerRecord>> {
		return d.enrollment.verify(request);
	}

	function servesCamp(
		record: ReconcilerRecord,
		campId: string,
	): Outcome<CampId> {
		if (
			record.enrollment !== EnrollmentState.ACCEPTED ||
			!record.campIds.includes(campId)
		)
			return feedRefusal(
				"camp-not-accepted",
				`${record.reconcilerId} is not accepted for Camp ${campId}`,
				campId,
			);
		// SAFETY: membership in the accepted Camps was checked above.
		return { ok: true, value: campId as CampId };
	}

	function ownLease(
		record: ReconcilerRecord,
		lease: { reconcilerId: string; campId: string },
	): Outcome<true> {
		if (lease.reconcilerId !== record.reconcilerId)
			return feedRefusal(
				"lease-mismatch",
				`lease belongs to ${lease.reconcilerId}`,
				lease.campId,
			);
		const camp = servesCamp(record, lease.campId);
		return camp.ok ? { ok: true, value: true } : camp;
	}

	// ── Routes ───────────────────────────────────────────────────────────
	async function enroll(body: WireObject): Promise<FeedResponse> {
		const token = text(body.token);
		const publicJwk = body.publicJwk;
		if (!token || !isWireObject(publicJwk))
			return refuse(
				feedRefusal("request-invalid", "send token and publicJwk").reasons,
			);
		let claims: CampClaimRecord[] = [];
		try {
			claims = (Array.isArray(body.claims) ? body.claims : []).map((c) =>
				fromJson(CampClaimRecordSchema, c, { ignoreUnknownFields: false }),
			);
		} catch {
			return refuse(
				feedRefusal("request-invalid", "claims must be CampClaimRecord JSON")
					.reasons,
			);
		}
		const result = await d.enrollment.enroll(
			// SAFETY: a JSON object from the wire; parsePublicJwk in the enrollment narrows it.
			{ token, publicJwk: publicJwk as JsonObject, claims },
			ctxFor({ kind: "agent", id: "bootstrap" }),
		);
		if (!result.ok) return refuse(result.reasons);
		return respond(
			201,
			okBody({
				reconciler: recordJson(result.value.reconciler),
				state: EnrollmentState[result.value.state],
			}),
		);
	}

	async function svid(
		request: FeedRequest,
		body: WireObject,
	): Promise<FeedResponse> {
		const proof = headerOf(request.headers, "dpop");
		if (!proof)
			return refuse(
				feedRefusal("request-invalid", "send a DPoP proof header").reasons,
			);
		const authorization = /^DPoP\s+(\S+)$/u.exec(
			headerOf(request.headers, "authorization") ?? "",
		);
		if (authorization?.[1]) {
			const refreshed = await d.enrollment.refresh(
				{ svid: authorization[1], dpopProof: proof },
				ctxFor({ kind: "agent", id: "svid-refresh" }),
			);
			return refreshed.ok
				? respond(
						200,
						okBody({
							svid: refreshed.value.svid,
							expiresAtMs: refreshed.value.expiresAtMs,
						}),
					)
				: refuse(refreshed.reasons);
		}
		const reconcilerId = text(body.reconcilerId);
		if (!reconcilerId)
			return refuse(
				feedRefusal("request-invalid", "activation needs reconcilerId").reasons,
			);
		const activated = await d.enrollment.activate(
			// SAFETY: the enrollment loads the record by this id or refuses.
			{ reconcilerId: reconcilerId as ReconcilerId, dpopProof: proof },
			ctxFor({ kind: "agent", id: `cd-reconciler:${reconcilerId}` }),
		);
		return activated.ok
			? respond(
					200,
					okBody({
						reconciler: recordJson(activated.value.reconciler),
						svid: activated.value.svid,
						expiresAtMs: activated.value.expiresAtMs,
					}),
				)
			: refuse(activated.reasons);
	}

	async function claim(
		record: ReconcilerRecord,
		body: WireObject,
	): Promise<FeedResponse> {
		const campId = text(body.campId);
		const holderId = text(body.holderId);
		const ttlMs =
			isNumber(body.ttlMs) && body.ttlMs > 0
				? Math.min(body.ttlMs, CD_DEFAULTS.unreachableAfterMs)
				: CD_DEFAULTS.leaseTtlMs;
		if (!campId || !holderId)
			return refuse(
				feedRefusal("request-invalid", "send campId and holderId").reasons,
			);
		const camp = servesCamp(record, campId);
		if (!camp.ok) return refuse(camp.reasons);
		// SAFETY: the reconciler id is the authenticated enrollment's.
		const lease = await journal.claim({
			reconcilerId: record.reconcilerId as ReconcilerId,
			campId: camp.value,
			holderId,
			ttlMs,
		});
		if (!lease.ok) return refuse(lease.reasons);
		return respond(201, okBody(leaseJson(lease.value)));
	}

	async function leaseOp(
		record: ReconcilerRecord,
		body: WireObject,
		op: "renew" | "release",
	): Promise<FeedResponse> {
		const lease = parseLease(body.lease);
		if (!lease.ok) return refuse(lease.reasons);
		const own = ownLease(record, lease.value);
		if (!own.ok) return refuse(own.reasons);
		if (op === "release") {
			await journal.release(lease.value);
			return respond(200, okBody(null));
		}
		const ttlMs =
			isNumber(body.ttlMs) && body.ttlMs > 0
				? Math.min(body.ttlMs, CD_DEFAULTS.unreachableAfterMs)
				: CD_DEFAULTS.leaseTtlMs;
		const renewed = await journal.renew(lease.value, ttlMs);
		return renewed.ok
			? respond(200, okBody(leaseJson(renewed.value)))
			: refuse(renewed.reasons);
	}

	async function observations(
		record: ReconcilerRecord,
		body: WireObject,
	): Promise<FeedResponse> {
		const lease = parseLease(body.lease);
		if (!lease.ok) return refuse(lease.reasons);
		const own = ownLease(record, lease.value);
		if (!own.ok) return refuse(own.reasons);
		let observation: ReconcileObservationRecord;
		try {
			observation = fromJson(
				ReconcileObservationRecordSchema,
				body.observation ?? null,
				{ ignoreUnknownFields: false },
			);
		} catch (error) {
			return refuse(
				feedRefusal("request-invalid", `observation: ${messageOf(error)}`)
					.reasons,
			);
		}
		if (
			observation.campId !== lease.value.campId ||
			observation.reconcilerId !== lease.value.reconcilerId ||
			observation.fenceToken !== lease.value.fence.toString(10)
		)
			return refuse(
				feedRefusal(
					"observation-invalid",
					"observation is not stamped with this lease",
					lease.value.campId,
				).reasons,
			);
		const declared = new Set(await d.posture.observeFields(lease.value.campId));
		for (const resource of observation.resources) {
			let bytes = 0;
			for (const [key, value] of Object.entries(resource.attributes)) {
				if (!declared.has(key))
					return refuse(
						feedRefusal(
							"attribute-undeclared",
							`attribute ${key} of ${resource.resource} is not a declared observe field`,
							resource.resource,
						).reasons,
					);
				bytes +=
					encoder.encode(key).byteLength + encoder.encode(value).byteLength;
			}
			if (bytes > OBSERVE_ATTRIBUTES_LIMIT_BYTES)
				return refuse(
					feedRefusal(
						"attribute-oversize",
						`${resource.resource} reports ${bytes} attribute bytes`,
						resource.resource,
					).reasons,
				);
		}
		const position = await journal.report(lease.value, observation);
		if (!position.ok) return refuse(position.reasons);
		meter("hobo.cd.feed.observations", 1, { status: observation.status });
		return respond(201, okBody({ position: position.value.toString(10) }));
	}

	async function checkpoints(
		record: ReconcilerRecord,
		body: WireObject,
	): Promise<FeedResponse> {
		const started = performance.now();
		const lease = parseLease(body.lease);
		if (!lease.ok) return refuse(lease.reasons);
		const own = ownLease(record, lease.value);
		if (!own.ok) return refuse(own.reasons);
		const position = parsePosition(body.position);
		if (!position.ok) return refuse(position.reasons);
		const committed = await journal.checkpoint(lease.value, position.value);
		if (!committed.ok) return refuse(committed.reasons);
		meter(
			"hobo.cd.feed.checkpoint_ms",
			performance.now() - started,
			{},
			"histogram",
			"ms",
		);
		return respond(200, okBody({ position: committed.value.toString(10) }));
	}

	async function blobs(
		record: ReconcilerRecord,
		path: string,
		query: URLSearchParams,
	): Promise<FeedResponse> {
		const digest = decodeURIComponent(path.slice(FEED_ROUTES.blobs.length));
		const campId = query.get("camp") ?? "";
		const camp = servesCamp(record, campId);
		if (!camp.ok) return refuse(camp.reasons);
		const referenced = (await d.desired.history(camp.value, 20)).some(
			(set) => set.resolvedSetDigest === digest,
		);
		if (!referenced)
			return refuse(
				feedRefusal(
					"blob-not-referenced",
					`${digest} is not referenced by a Set of ${campId}`,
					digest,
				).reasons,
			);
		const blob = await verifiedBlob(d.artifacts, digest);
		if (blob === "missing")
			return refuse(
				feedRefusal(
					"blob-missing",
					`${digest} is not in the artifact store`,
					digest,
				).reasons,
			);
		if (blob === "corrupt")
			return refuse(
				feedRefusal(
					"blob-corrupt",
					`${digest} does not match its bytes`,
					digest,
				).reasons,
			);
		return {
			status: 200,
			headers: {
				"content-type": RESOLVED_SET_MEDIA_TYPE,
				"cache-control": "no-store",
				etag: `"${digest}"`,
			},
			body: blob,
		};
	}

	async function feed(
		record: ReconcilerRecord,
		request: FeedRequest,
		query: URLSearchParams,
		signal: AbortSignal,
	): Promise<FeedResponse> {
		const camp = servesCamp(record, query.get("camp") ?? "");
		if (!camp.ok) return refuse(camp.reasons);
		const campId = camp.value;
		const lastEventId = headerOf(request.headers, "last-event-id");
		let resumeAfter: EventPosition | undefined;
		if (lastEventId !== undefined) {
			const parsed = parsePosition(lastEventId);
			if (!parsed.ok) return refuse(parsed.reasons);
			resumeAfter = parsed.value;
		}
		const checkpoint = await journal.committed(campId);
		const after = maxPosition(checkpoint, resumeAfter);
		const redeliver =
			query.get("redeliver") === "1" && resumeAfter === undefined;
		const head = await journal.specHead(campId);
		const body = streamFrames({
			campId,
			after,
			redeliver,
			head,
			signal,
			reconcilerId: record.reconcilerId,
		});
		return {
			status: 200,
			headers: {
				"content-type": FEED_MEDIA_TYPES.sse,
				"cache-control": "no-store",
			},
			body,
		};
	}

	async function* streamFrames(input: {
		campId: CampId;
		after: EventPosition | undefined;
		redeliver: boolean;
		head: EventPosition | undefined;
		signal: AbortSignal;
		reconcilerId: string;
	}): AsyncIterable<Uint8Array> {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		input.signal.addEventListener("abort", onAbort, { once: true });
		const deadline = performance.now() + longPollMs;
		const base = { campIds: [input.campId], signal: controller.signal };
		const query: ChangesQuery =
			input.redeliver || input.after === undefined
				? base
				: { ...base, after: input.after };
		const iterator = d.desired.changes(query)[Symbol.asyncIterator]();
		let frames = 0;
		let current: DesiredStateChange | undefined;
		let end: FeedEndReason = "long-poll";
		const caughtUp = (position: EventPosition) =>
			input.head !== undefined && position >= input.head;
		const sources = {
			artifacts: d.artifacts,
			posture: d.posture,
			topology: d.topology,
		};
		async function frame(change: DesiredStateChange): Promise<Uint8Array> {
			const built = await buildFrame(change, input.campId, sources);
			frames += 1;
			meter("hobo.cd.feed.frames", 1, { inline: built.resolvedSetJson !== "" });
			return encoder.encode(encodeFrame(built.position, frameJson(built)));
		}
		try {
			// Nothing newer than the checkpoint exists: re-deliver the current change once per lease.
			const nothingNewer =
				input.head === undefined ||
				(input.after !== undefined && input.head <= input.after);
			let pending = iterator.next();
			for (;;) {
				const remaining = deadline - performance.now();
				if (remaining <= 0 || input.signal.aborted) break;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const tick = new Promise<"heartbeat">((resolve) => {
					timer = setTimeout(
						() => resolve("heartbeat"),
						Math.min(heartbeatMs, remaining),
					);
				});
				const next = await Promise.race([pending, tick]);
				clearTimeout(timer);
				if (next === "heartbeat") {
					yield encoder.encode(encodeHeartbeat());
					continue;
				}
				if (next.done) {
					if (input.redeliver && nothingNewer && current)
						yield await frame(current);
					end = "caught-up";
					break;
				}
				const change = next.value;
				pending = iterator.next();
				if (input.after !== undefined && change.position <= input.after) {
					current = change;
					if (input.redeliver && nothingNewer && caughtUp(change.position)) {
						yield await frame(change);
						end = "caught-up";
						break;
					}
					continue;
				}
				yield await frame(change);
				if (
					caughtUp(change.position) ||
					input.head === undefined ||
					nothingNewer
				) {
					end = "caught-up";
					break;
				}
				if (frames >= maxFrames) {
					end = "limit";
					break;
				}
			}
			yield encoder.encode(encodeEnd(end));
		} finally {
			controller.abort();
			input.signal.removeEventListener("abort", onAbort);
			await iterator.return?.();
			meter("hobo.cd.feed.responses", 1, { end, frames });
		}
	}

	// ── Dispatch ─────────────────────────────────────────────────────────
	async function route(
		request: FeedRequest,
		signal: AbortSignal,
	): Promise<FeedResponse> {
		const url = new URL(request.path, "https://station.invalid");
		const path = url.pathname;
		if (!path.startsWith("/v1/cd/"))
			return refuse(
				feedRefusal("route-unknown", `${path} is not a delivery-feed route`)
					.reasons,
			);
		const method = request.method.toUpperCase();
		const isPost = method === "POST";
		const knownPost: readonly string[] = [
			FEED_ROUTES.enrollments,
			FEED_ROUTES.svidRefresh,
			FEED_ROUTES.leases,
			FEED_ROUTES.leaseRenew,
			FEED_ROUTES.leaseRelease,
			FEED_ROUTES.observations,
			FEED_ROUTES.checkpoints,
		];
		const knownGet =
			path === FEED_ROUTES.feed || path.startsWith(FEED_ROUTES.blobs);
		if (!knownPost.includes(path) && !knownGet)
			return refuse(
				feedRefusal("route-unknown", `${path} is not a delivery-feed route`)
					.reasons,
			);
		if ((knownGet && method !== "GET") || (!knownGet && !isPost))
			return refuse(
				feedRefusal("method-not-allowed", `${method} ${path} is not allowed`)
					.reasons,
			);
		let body: WireObject = {};
		if (isPost) {
			const parsed = parseJsonBody(request.body);
			if (!parsed.ok) return refuse(parsed.reasons);
			body = parsed.value;
		}
		if (path === FEED_ROUTES.enrollments) return enroll(body);
		if (path === FEED_ROUTES.svidRefresh) return svid(request, body);
		const auth = await authenticated(request);
		if (!auth.ok) return refuse(auth.reasons);
		const record = auth.value;
		if (path === FEED_ROUTES.leases) return claim(record, body);
		if (path === FEED_ROUTES.leaseRenew) return leaseOp(record, body, "renew");
		if (path === FEED_ROUTES.leaseRelease)
			return leaseOp(record, body, "release");
		if (path === FEED_ROUTES.observations) return observations(record, body);
		if (path === FEED_ROUTES.checkpoints) return checkpoints(record, body);
		if (path === FEED_ROUTES.feed)
			return feed(record, request, url.searchParams, signal);
		return blobs(record, path, url.searchParams);
	}

	return Object.freeze({
		pathPrefix: "/v1/cd/" as const,
		async handle(
			request: FeedRequest,
			signal: AbortSignal,
		): Promise<FeedResponse> {
			const started = performance.now();
			let response: FeedResponse;
			try {
				response = await route(request, signal);
			} catch (error) {
				response = refuse(
					feedRefusal("store-unavailable", messageOf(error)).reasons,
				);
			}
			const routeName =
				(new URL(request.path, "https://station.invalid").pathname
					.slice("/v1/cd/".length)
					.split("/")[0] ??
					"") ||
				"root";
			meter("hobo.cd.feed.requests", 1, {
				route: routeName,
				status: response.status,
			});
			meter(
				"hobo.cd.feed.request_ms",
				performance.now() - started,
				{ route: routeName },
				"histogram",
				"ms",
			);
			return response;
		},
	} satisfies DeliveryFeedHandler);
}

function maxPosition(
	a: EventPosition | undefined,
	b: EventPosition | undefined,
): EventPosition | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a > b ? a : b;
}
