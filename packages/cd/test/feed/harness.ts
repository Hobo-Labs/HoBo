/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test harness wiring over controlled fixtures. */
// A Station double (event store + desired state + artifacts + enrollment +
// delivery feed) and an HttpTransport that carries agent requests into it.
// The double records every exchange so tests can prove direction (agent →
// Station only) and that no target credential ever reaches the Station.
import { create } from "@bufbuild/protobuf";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { createInMemoryKms, JwtSvidIssuer } from "@hobo/identity";
import {
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcilerMode,
	ReconcileStatus,
	type SetRecord,
} from "../../src/_generated/cd_pb.js";
import { type AgentKeyPair, createAgentEnrollment, createHttpTransport, generateAgentKey } from "../../src/agent/index.js";
import { createDeliveryFeedHandler, type DeliveryFeedDeps } from "../../src/feed/index.js";
import type { CampId, ReconcilerId, ReconcilerLease, ReconcilerTransport } from "../../src/ports.js";
import {
	asCamp,
	type Clock,
	createClock,
	createFakeAuthorizer,
	createFakeDesired,
	createFakeInventory,
	createFakePosture,
	createFakeRails,
	createFakeStore,
	createFakeTopology,
	createMemoryArtifacts,
	createRecordingTelemetry,
	ctxAt,
	railWith,
	TENANT,
} from "./fakes.js";

export const BASE_URL = "https://station.test";

export type Exchange = Readonly<{ request: TransportRequest; status: number; body: string }>;

export type StationOptions = Partial<Pick<DeliveryFeedDeps, "heartbeatMs" | "longPollMs" | "maxFramesPerResponse">> & {
	camps?: readonly string[];
	observeFields?: readonly string[];
	observeOnly?: readonly string[];
	clock?: Clock;
};

export function createStation(options: StationOptions = {}) {
	const camps = options.camps ?? ["eu-1", "eu-2"];
	const clock = options.clock ?? createClock();
	const store = createFakeStore(clock);
	const artifacts = createMemoryArtifacts();
	const desired = createFakeDesired(store, artifacts);
	const inventory = createFakeInventory({ fleet: camps });
	const authorizer = createFakeAuthorizer();
	const telemetry = createRecordingTelemetry();
	const kms = createInMemoryKms();
	kms.generateRsaKey("svid-1");
	const issuer = new JwtSvidIssuer({ issuerUrl: `${BASE_URL}/identity`, kms, activeKeyId: "svid-1", jwksKeyIds: ["svid-1"] });
	const enrollment = createAgentEnrollment({
		store,
		tenant: TENANT,
		now: clock.now,
		authorizer,
		rails: createFakeRails(railWith()),
		inventory,
		issuer,
		telemetry,
		publicOrigin: BASE_URL,
	});
	const handler = createDeliveryFeedHandler({
		store,
		tenant: TENANT,
		now: clock.now,
		desired,
		enrollment,
		artifacts,
		posture: createFakePosture(options.observeFields ?? ["tls.minVersion"]),
		inventory,
		topology: createFakeTopology(camps, options.observeOnly ?? []),
		telemetry,
		heartbeatMs: options.heartbeatMs ?? 20,
		longPollMs: options.longPollMs ?? 60,
		...(options.maxFramesPerResponse !== undefined ? { maxFramesPerResponse: options.maxFramesPerResponse } : {}),
	});
	const exchanges: Exchange[] = [];
	/** Cut the next N feed responses after `frames` frames (simulates a dropped connection). */
	const cuts: number[] = [];
	const http: HttpTransport = async (request) => {
		const url = new URL(request.url);
		const response = await handler.handle(
			{
				method: request.method,
				path: `${url.pathname}${url.search}`,
				headers: { ...request.headers, host: url.host },
				body: new TextEncoder().encode(request.body ?? ""),
			},
			new AbortController().signal,
		);
		let body = "";
		if (response.body instanceof Uint8Array) body = new TextDecoder().decode(response.body);
		else {
			const cut = url.pathname === "/v1/cd/feed" ? cuts.shift() : undefined;
			let frames = 0;
			for await (const chunk of response.body) {
				const text = new TextDecoder().decode(chunk);
				if (cut !== undefined && text.includes("event: frame")) {
					if (frames >= cut) break;
					frames += 1;
				}
				body += text;
			}
		}
		exchanges.push({ request, status: response.status, body });
		return { status: response.status, headers: response.headers, body };
	};
	return { clock, store, artifacts, desired, inventory, authorizer, telemetry, issuer, enrollment, handler, http, exchanges, cuts, camps };
}

export type Station = ReturnType<typeof createStation>;

/** Enroll over HTTP with a bootstrap token, grant both opt-ins as two operators, return an agent transport. */
export async function provisionAgent(
	station: Station,
	options: { campIds?: readonly string[]; grants?: "both" | "key-only" | "none"; key?: AgentKeyPair } = {},
): Promise<{ key: AgentKeyPair; reconcilerId: ReconcilerId; transport: ReconcilerTransport }> {
	const campIds = options.campIds ?? station.camps;
	const key = options.key ?? generateAgentKey();
	const token = await station.enrollment.issueToken(
		{ campSet: "fleet", campIds: campIds.map(asCamp), mode: ReconcilerMode.AGENT, ttlMs: 3_600_000 },
		ctxAt(station.clock, { kind: "user", id: "alice" }),
	);
	if (!token.ok) throw new Error(token.reasons[0]?.code);
	const response = await station.http({
		method: "POST",
		url: `${BASE_URL}/v1/cd/enrollments`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: token.value.token, publicJwk: key.publicJwk, claims: [{ name: "region", value: "eu-west-1" }] }),
		timeoutMs: 1000,
		maxResponseBytes: 1_000_000,
	});
	const reconcilerId = JSON.parse(response.body).value.reconciler.reconcilerId as ReconcilerId;
	const grants = options.grants ?? "both";
	if (grants !== "none") await station.enrollment.approveKey(reconcilerId, ctxAt(station.clock, { kind: "user", id: "alice" }));
	if (grants === "both")
		await station.enrollment.accept({ reconcilerId, campIds: campIds.map(asCamp) }, ctxAt(station.clock, { kind: "user", id: "bob" }));
	const transport = createHttpTransport({ baseUrl: BASE_URL, http: station.http, reconcilerId, privateJwk: key.privateJwk, svid: "", now: station.clock.now });
	return { key, reconcilerId, transport };
}

export function observation(lease: ReconcilerLease, set: SetRecord, status: ReconcileStatus, extra: Partial<ReconcileObservationRecord> = {}) {
	return create(ReconcileObservationRecordSchema, {
		campId: lease.campId,
		setId: set.setId,
		reconcilerId: lease.reconcilerId,
		fenceToken: lease.fence.toString(10),
		status,
		observedAt: new Date(0).toISOString(),
		...extra,
	});
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}

export function camp(id: string): CampId {
	return asCamp(id);
}

export { ReconcileStatus };
