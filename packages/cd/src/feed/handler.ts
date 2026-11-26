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
import type { EventPosition } from "@hobo/core";
import {
	type CredentialRequest,
	CredentialRequestSchema,
	CredentialResponseSchema,
	type EnrollmentRequest,
	EnrollmentRequestSchema,
	type MemberId,
	parseMemberId,
} from "@hobo/fleet";
import {
	EnrollmentState,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	type ReconcilerRecord,
	ReconcilerRecordSchema,
} from "../_generated/cd_pb.js";
import { AGENT_FAILURES, reasonOf } from "../agent/errors.js";
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
import { asCamp } from "../rollout/journal.js";
import { FEED_FAILURES, feedRefusal, statusFor } from "./errors.js";
import { buildFrame, frameJson, verifiedBlob } from "./frames.js";
import { createFeedJournal } from "./journal.js";
import { headerOf, isNumber, texts } from "./json.js";
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
	readonly heartbeatMs?: number;
	readonly longPollMs?: number;
	readonly maxFramesPerResponse?: number;
};

const FEED_CLEANUP_TIMEOUT_MS = 5_000;

type ChangesQuery = Parameters<DesiredStateReader["changes"]>[0];

const DEFAULT_MAX_FRAMES = 64;
const encoder = new TextEncoder();
const SAFE_FAILURES = new Map([
	...Object.entries(AGENT_FAILURES),
	...Object.entries(FEED_FAILURES),
]);
const FEED_ROUTE_LABELS: ReadonlyMap<string, string> = new Map([
	[FEED_ROUTES.enrollments, "enrollments"],
	[FEED_ROUTES.svidRefresh, "svid"],
	[FEED_ROUTES.leases, "leases"],
	[FEED_ROUTES.leaseRenew, "leases"],
	[FEED_ROUTES.leaseRelease, "leases"],
	[FEED_ROUTES.observations, "observations"],
	[FEED_ROUTES.checkpoints, "checkpoints"],
	[FEED_ROUTES.feed, "feed"],
]);

function feedRouteLabel(path: string): string {
	try {
		const pathname = new URL(path, "https://station.invalid").pathname;
		if (pathname.startsWith(FEED_ROUTES.blobs)) return "blobs";
		return FEED_ROUTE_LABELS.get(pathname) ?? "unknown";
	} catch {
		return "unknown";
	}
}

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
	const safe = reasons.map((entry) => {
		const spec = SAFE_FAILURES.get(entry.code);
		return spec
			? reasonOf(
					entry.code,
					"The Station refused the request.",
					spec.remediation,
				)
			: reasonOf(
					"store-unavailable",
					"The Station could not complete the request.",
					FEED_FAILURES["store-unavailable"].remediation,
				);
	});
	if (safe.length === 0)
		safe.push(
			reasonOf(
				"store-unavailable",
				"The Station could not complete the request.",
				FEED_FAILURES["store-unavailable"].remediation,
			),
		);
	return respond(statusFor(safe[0]?.code ?? ""), refusalBody(safe));
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
				"The reconciler is not accepted for the requested Camp.",
			);
		return { ok: true, value: campId as CampId };
	}

	function ownLease(
		record: ReconcilerRecord,
		lease: { reconcilerId: string; campId: string },
	): Outcome<true> {
		if (lease.reconcilerId !== record.reconcilerId)
			return feedRefusal(
				"lease-mismatch",
				"The lease belongs to a different reconciler.",
			);
		const camp = servesCamp(record, lease.campId);
		return camp.ok ? { ok: true, value: true } : camp;
	}

	async function enroll(
		request: FeedRequest,
		body: WireObject,
	): Promise<FeedResponse> {
		const proof = headerOf(request.headers, "dpop");
		if (!proof || !isWireObject(body.request))
			return refuse(
				feedRefusal(
					"request-invalid",
					"send a fleet EnrollmentRequest as `request` and a DPoP proof header",
				).reasons,
			);
		let enrollment: EnrollmentRequest;
		try {
			enrollment = fromJson(EnrollmentRequestSchema, body.request, {
				ignoreUnknownFields: false,
			});
		} catch {
			return refuse(
				feedRefusal("request-invalid", "request must be EnrollmentRequest JSON")
					.reasons,
			);
		}
		const campIds = texts(body.campIds).map(asCamp);
		const result = await d.enrollment.enroll(
			{ request: enrollment, dpopProof: proof, campIds },
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
		const memberText = text(body.memberId);
		if (!memberText || !isWireObject(body.request))
			return refuse(
				feedRefusal(
					"request-invalid",
					"send memberId and a fleet CredentialRequest as `request`",
				).reasons,
			);
		let memberId: MemberId;
		let credential: CredentialRequest;
		try {
			memberId = parseMemberId(memberText);
			credential = fromJson(CredentialRequestSchema, body.request, {
				ignoreUnknownFields: false,
			});
		} catch {
			return refuse(
				feedRefusal(
					"request-invalid",
					"memberId must be a fleet member id and request a CredentialRequest",
				).reasons,
			);
		}
		const refreshed = await d.enrollment.refresh(
			{ memberId, request: credential, dpopProof: proof },
			ctxFor({ kind: "agent", id: `cd-reconciler:${memberId}` }),
		);
		return refreshed.ok
			? respond(200, okBody(toJson(CredentialResponseSchema, refreshed.value)))
			: refuse(refreshed.reasons);
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
		} catch {
			return refuse(
				feedRefusal("request-invalid", "The supplied observation is invalid.")
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
							"An observed attribute is not a declared observe field.",
						).reasons,
					);
				bytes +=
					encoder.encode(key).byteLength + encoder.encode(value).byteLength;
			}
			if (bytes > OBSERVE_ATTRIBUTES_LIMIT_BYTES)
				return refuse(
					feedRefusal(
						"attribute-oversize",
						"Observed attributes exceed the per-resource limit.",
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
					"The requested blob is not referenced by a Set of the Camp.",
				).reasons,
			);
		const blob = await verifiedBlob(d.artifacts, digest);
		if (blob === "missing")
			return refuse(
				feedRefusal(
					"blob-missing",
					"The requested blob is unavailable in the artifact store.",
				).reasons,
			);
		if (blob === "corrupt")
			return refuse(
				feedRefusal(
					"blob-corrupt",
					"The requested blob does not match its digest.",
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
		let notifyCancelled = () => {};
		const cancelled = new Promise<"cancelled">((resolve) => {
			notifyCancelled = () => resolve("cancelled");
		});
		const onAbort = () => {
			controller.abort();
			notifyCancelled();
		};
		input.signal.addEventListener("abort", onAbort, { once: true });
		if (input.signal.aborted) onAbort();
		const deadline = performance.now() + longPollMs;
		const base = { campIds: [input.campId], signal: controller.signal };
		const query: ChangesQuery =
			input.redeliver || input.after === undefined
				? base
				: { ...base, after: input.after };
		let iterator: AsyncIterator<DesiredStateChange> | undefined;
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
		async function frame(
			change: DesiredStateChange,
		): Promise<Uint8Array | undefined> {
			const built = await Promise.race([
				buildFrame(change, input.campId, sources),
				cancelled,
			]);
			if (built === "cancelled" || input.signal.aborted) return undefined;
			frames += 1;
			meter("hobo.cd.feed.frames", 1, { inline: built.resolvedSetJson !== "" });
			return encoder.encode(encodeFrame(built.position, frameJson(built)));
		}
		async function closeIterator(): Promise<void> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					iterator?.return?.(),
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error()),
							FEED_CLEANUP_TIMEOUT_MS,
						);
					}),
				]);
			} catch {
				throw new Error("The CD delivery feed stream failed.");
			} finally {
				clearTimeout(timer);
			}
		}
		try {
			if (input.signal.aborted) return;
			iterator = d.desired.changes(query)[Symbol.asyncIterator]();
			const nothingNewer =
				input.head === undefined ||
				(input.after !== undefined && input.head <= input.after);
			let pending: Promise<IteratorResult<DesiredStateChange>> | undefined;
			for (;;) {
				const remaining = deadline - performance.now();
				if (remaining <= 0 || input.signal.aborted) break;
				pending ??= iterator.next();
				let timer: ReturnType<typeof setTimeout> | undefined;
				const tick = new Promise<"heartbeat">((resolve) => {
					timer = setTimeout(
						() => resolve("heartbeat"),
						Math.min(heartbeatMs, remaining),
					);
				});
				let next:
					| IteratorResult<DesiredStateChange>
					| "heartbeat"
					| "cancelled";
				try {
					next = await Promise.race([pending, tick, cancelled]);
				} finally {
					clearTimeout(timer);
				}
				if (next === "cancelled" || input.signal.aborted) break;
				if (next === "heartbeat") {
					yield encoder.encode(encodeHeartbeat());
					continue;
				}
				pending = undefined;
				if (next.done) {
					if (input.redeliver && nothingNewer && current) {
						const payload = await frame(current);
						if (payload) yield payload;
					}
					end = "caught-up";
					break;
				}
				const change = next.value;
				if (input.after !== undefined && change.position <= input.after) {
					current = change;
					if (input.redeliver && nothingNewer && caughtUp(change.position)) {
						const payload = await frame(change);
						if (payload) yield payload;
						end = "caught-up";
						break;
					}
					continue;
				}
				const payload = await frame(change);
				if (!payload) break;
				yield payload;
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
		} catch {
			throw new Error("The CD delivery feed stream failed.");
		} finally {
			controller.abort();
			input.signal.removeEventListener("abort", onAbort);
			await closeIterator();
			meter("hobo.cd.feed.responses", 1, { end, frames });
		}
		if (!input.signal.aborted) yield encoder.encode(encodeEnd(end));
	}

	async function route(
		request: FeedRequest,
		signal: AbortSignal,
	): Promise<FeedResponse> {
		const url = new URL(request.path, "https://station.invalid");
		const path = url.pathname;
		if (!path.startsWith("/v1/cd/"))
			return refuse(
				feedRefusal(
					"route-unknown",
					"The requested delivery-feed route is unknown.",
				).reasons,
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
				feedRefusal(
					"route-unknown",
					"The requested delivery-feed route is unknown.",
				).reasons,
			);
		if ((knownGet && method !== "GET") || (!knownGet && !isPost))
			return refuse(
				feedRefusal(
					"method-not-allowed",
					"The method is not allowed for this delivery-feed route.",
				).reasons,
			);
		let body: WireObject = {};
		if (isPost) {
			const parsed = parseJsonBody(request.body);
			if (!parsed.ok) return refuse(parsed.reasons);
			body = parsed.value;
		}
		if (path === FEED_ROUTES.enrollments) return enroll(request, body);
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
			} catch {
				response = refuse(
					feedRefusal(
						"store-unavailable",
						"The CD delivery feed is unavailable.",
					).reasons,
				);
			}
			let routeName = "unknown";
			try {
				routeName = feedRouteLabel(request.path);
			} catch {}
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
