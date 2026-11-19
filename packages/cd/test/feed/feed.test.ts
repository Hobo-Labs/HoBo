/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening -- SAFETY: test fixtures brand ids they mint, build partial generated records, and read controlled JSON at the test boundary. */
// Delivery feed + agent HTTP transport end to end (C10, D5, I3, I4, I24):
// Station-only egress converges a target with no target credential at the
// Station; SSE resumes without gaps or duplicates; inline vs digest-only
// resolved sets; fenced leases, reports and checkpoints; enrollment gating.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
	CampManagement,
	ConditionStatus,
	ReasonRecordSchema,
	ReconcileStatus,
	SignalSource,
} from "../../src/_generated/cd_pb.js";
import { createDpopProof, FeedRefusedError } from "../../src/agent/index.js";
import { createMeter } from "../../src/agent/metrics.js";
import {
	CD_EVENTS,
	CD_STREAMS,
	ENROLLMENT_INCOMPLETE,
} from "../../src/events.js";
import {
	createDeliveryFeedHandler,
	createFeedJournal,
} from "../../src/feed/index.js";
import type {
	DesiredStateChange,
	Outcome,
	ReconcilerLease,
} from "../../src/ports.js";
import {
	createFakePosture,
	createFakeTopology,
	resolvedFor,
	TENANT,
} from "./fakes.js";
import {
	BASE_URL,
	camp,
	collect,
	createStation,
	observation,
	provisionAgent,
} from "./harness.js";

function code<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : (outcome.reasons[0]?.code ?? "");
}

function must<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(
			`${outcome.reasons[0]?.code}: ${outcome.reasons[0]?.message}`,
		);
	return outcome.value;
}

const signal = () => new AbortController().signal;

describe("feed backend failures", () => {
	it.each([
		"dpop-url-mismatch",
		"unknown",
	] as const)("normalizes %s authentication refusals from the enrollment port", async (kind) => {
		const station = createStation();
		const marker = "synthetic-private-enrollment.invalid";
		const handler = createDeliveryFeedHandler({
			store: station.store,
			tenant: TENANT,
			now: station.clock.now,
			desired: station.desired,
			enrollment: {
				...station.enrollment,
				verify: async () => ({
					ok: false,
					reasons: [
						create(ReasonRecordSchema, {
							code: kind === "unknown" ? marker : kind,
							message: marker,
							remediation: marker,
							subject: marker,
						}),
					],
				}),
			},
			artifacts: station.artifacts,
			posture: createFakePosture([]),
			inventory: station.inventory,
			topology: createFakeTopology(station.camps, []),
			telemetry: station.telemetry,
		});
		const response = await handler.handle(
			{
				method: "POST",
				path: "/v1/cd/leases",
				headers: {},
				body: new TextEncoder().encode("{}"),
			},
			signal(),
		);
		if (!(response.body instanceof Uint8Array))
			throw new Error("fixture refusal missing");
		const body = new TextDecoder().decode(response.body);
		expect(response.status).toBe(kind === "unknown" ? 503 : 401);
		expect(JSON.parse(body).reasons[0].code).toBe(
			kind === "unknown" ? "store-unavailable" : kind,
		);
		expect(body).not.toContain(marker);
		expect(JSON.stringify(station.telemetry.points)).not.toContain(marker);
	});

	it("returns bounded authentication refusals without proof fields", async () => {
		const station = createStation();
		const { key, transport, reconcilerId } = await provisionAgent(station);
		must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const authorization =
			station.exchanges.at(-1)?.request.headers.authorization;
		if (!authorization?.startsWith("DPoP "))
			throw new Error("fixture SVID missing");
		const marker = "synthetic-private-proof.invalid";
		const path = "/v1/cd/leases";
		const make = (method: string, url: string, jti: string) =>
			createDpopProof({
				privateJwk: key.privateJwk,
				method,
				url,
				iatSeconds: Math.floor(station.clock.now() / 1000),
				jti,
				accessToken: authorization.slice(5),
			});
		const valid = make("POST", `${BASE_URL}${path}`, marker);
		const [head, payload, signature] = valid.split(".");
		const header = JSON.parse(
			Buffer.from(head ?? "", "base64url").toString("utf8"),
		);
		const invalidAlg = Buffer.from(
			JSON.stringify({ ...header, alg: marker }),
		).toString("base64url");
		const proofs = [
			{
				proof: make(marker, `${BASE_URL}${path}`, "method"),
				expected: "dpop-method-mismatch",
			},
			{
				proof: make("POST", `https://${marker}/wrong`, "url"),
				expected: "dpop-url-mismatch",
			},
			{
				proof: `${invalidAlg}.${payload}.${signature}`,
				expected: "dpop-invalid",
			},
			{ proof: valid, expected: "request-invalid" },
			{ proof: valid, expected: "dpop-replayed" },
		];
		for (const { proof, expected } of proofs) {
			const response = await station.handler.handle(
				{
					method: "POST",
					path,
					headers: { authorization, dpop: proof },
					body: new TextEncoder().encode("{}"),
				},
				signal(),
			);
			if (!(response.body instanceof Uint8Array))
				throw new Error("fixture refusal missing");
			const body = new TextDecoder().decode(response.body);
			expect(JSON.parse(body).reasons[0].code).toBe(expected);
			expect(body).not.toContain(marker);
		}
		expect(JSON.stringify(station.telemetry.points)).not.toContain(marker);
	});

	it("keeps unknown routes, methods, and malformed paths out of responses and telemetry", async () => {
		const station = createStation();
		const marker = "synthetic-private-route.invalid";
		for (const request of [
			{
				method: "GET",
				path: `/v1/cd/${marker}`,
				expected: 404,
				label: "unknown",
			},
			{ method: marker, path: "/v1/cd/feed", expected: 405, label: "feed" },
			{ method: "GET", path: "http://[", expected: 503, label: "unknown" },
		]) {
			const response = await station.handler.handle(
				{ method: request.method, path: request.path, headers: {} },
				signal(),
			);
			expect(response.status).toBe(request.expected);
			if (!(response.body instanceof Uint8Array))
				throw new Error("fixture refusal missing");
			expect(new TextDecoder().decode(response.body)).not.toContain(marker);
			const point = station.telemetry.points
				.filter((item) => item.name === "hobo.cd.feed.requests")
				.at(-1);
			expect(point?.attributes.route).toBe(request.label);
		}
		expect(JSON.stringify(station.telemetry.points)).not.toContain(marker);
	});

	it("does not echo an untrusted blob identifier in an authenticated refusal", async () => {
		const station = createStation();
		const { key, transport, reconcilerId } = await provisionAgent(station);
		must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const authorization =
			station.exchanges.at(-1)?.request.headers.authorization;
		if (!authorization?.startsWith("DPoP "))
			throw new Error("fixture SVID missing");
		const marker = "synthetic-private-blob.invalid";
		const path = `/v1/cd/blobs/${marker}`;
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "GET",
			url: `${BASE_URL}${path}`,
			iatSeconds: Math.floor(station.clock.now() / 1000),
			jti: "blob-privacy",
			accessToken: authorization.slice(5),
		});
		const response = await station.handler.handle(
			{
				method: "GET",
				path: `${path}?camp=eu-1`,
				headers: { authorization, dpop: proof },
			},
			signal(),
		);
		expect(response.status).toBe(403);
		if (!(response.body instanceof Uint8Array))
			throw new Error("fixture refusal missing");
		expect(new TextDecoder().decode(response.body)).not.toContain(marker);
		expect(JSON.stringify(station.telemetry.points)).not.toContain(marker);
	});

	it.each([
		"claim",
		"renew",
		"report",
		"checkpoint",
	] as const)("redacts a %s journal refusal", async (phase) => {
		const station = createStation();
		const { reconcilerId } = await provisionAgent(station);
		const journal = createFeedJournal({
			store: station.store,
			tenant: "fixture",
		});
		const request = {
			reconcilerId,
			campId: camp("eu-1"),
			holderId: "host-a",
			ttlMs: 30_000,
		};
		const first = must(await journal.claim(request));
		const marker = "synthetic-private-journal.invalid";
		const fail = async () => {
			throw new Error(marker);
		};
		let result: Awaited<
			ReturnType<(typeof journal)["claim" | "renew" | "checkpoint" | "report"]>
		>;
		if (phase === "claim") {
			station.store.claimSubscription = fail;
			result = await journal.claim(request);
		} else if (phase === "renew") {
			station.store.renewSubscription = fail;
			result = await journal.renew(first);
		} else if (phase === "checkpoint") {
			station.store.commitCheckpoint = fail;
			result = await journal.checkpoint(first, 1n as never);
		} else {
			const set = await station.desired.publish(
				"eu-1",
				resolvedFor("eu-1", ["api"]),
			);
			station.store.append = fail;
			result = await journal.report(
				first,
				observation(first, set, ReconcileStatus.BLOCKED),
			);
		}
		expect(result.ok ? "ok" : result.reasons[0]?.code).toBe(
			"store-unavailable",
		);
		if (!result.ok) expect(result.reasons[0]?.remediation).toBeTruthy();
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("redacts a journal claim failure in the authenticated feed response", async () => {
		const station = createStation();
		const { transport, reconcilerId } = await provisionAgent(station);
		const request = {
			reconcilerId,
			campId: camp("eu-1"),
			holderId: "host-a",
			ttlMs: 30_000,
		};
		const first = must(await transport.claim(request));
		await transport.release(first);
		station.store.claimSubscription = async () => {
			throw new Error("synthetic-private-journal.invalid");
		};
		const result = await transport.claim(request);
		expect(code(result)).toBe("store-unavailable");
		expect(station.exchanges.at(-1)?.status).toBe(503);
		expect(station.exchanges.at(-1)?.body).not.toContain(
			"synthetic-private-journal.invalid",
		);
	});

	it.each([
		"read",
		"cleanup",
	] as const)("redacts a feed stream %s failure for a direct handler host", async (phase) => {
		const station = createStation();
		const { key, transport, reconcilerId } = await provisionAgent(station);
		must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const authorization =
			station.exchanges.at(-1)?.request.headers.authorization;
		if (!authorization?.startsWith("DPoP "))
			throw new Error("fixture SVID missing");
		const accessToken = authorization.slice(5);
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "GET",
			url: `${BASE_URL}/v1/cd/feed`,
			iatSeconds: Math.floor(station.clock.now() / 1000),
			jti: "stream-fixture",
			accessToken,
		});
		station.desired.changes = () => ({
			[Symbol.asyncIterator]: () => ({
				async next(): Promise<IteratorResult<DesiredStateChange>> {
					if (phase === "read")
						throw new Error("synthetic-private-journal.invalid");
					return { done: true, value: undefined };
				},
				async return(): Promise<IteratorResult<DesiredStateChange>> {
					if (phase === "cleanup")
						throw new Error("synthetic-private-journal.invalid");
					return { done: true, value: undefined };
				},
			}),
		});
		const response = await station.handler.handle(
			{
				method: "GET",
				path: "/v1/cd/feed?camp=eu-1",
				headers: { authorization, dpop: proof },
			},
			signal(),
		);
		expect(response.status).toBe(200);
		if (response.body instanceof Uint8Array)
			throw new Error("fixture stream missing");
		let failure: Error | undefined;
		let wire = "";
		try {
			for await (const chunk of response.body)
				wire += new TextDecoder().decode(chunk);
		} catch (error) {
			if (error instanceof Error) failure = error;
		}
		expect(failure?.message).toBe("The CD delivery feed stream failed.");
		expect(String(failure)).not.toContain("synthetic-private-journal.invalid");
		expect(wire).not.toContain("event: end");
	});

	it("bounds stuck stream cleanup without a success end frame", async () => {
		const station = createStation();
		const { key, transport, reconcilerId } = await provisionAgent(station);
		must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const authorization =
			station.exchanges.at(-1)?.request.headers.authorization;
		if (!authorization?.startsWith("DPoP "))
			throw new Error("fixture SVID missing");
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "GET",
			url: `${BASE_URL}/v1/cd/feed`,
			iatSeconds: Math.floor(station.clock.now() / 1000),
			jti: "stuck-fixture",
			accessToken: authorization.slice(5),
		});
		let entered = () => {};
		const cleanupStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		station.desired.changes = () => ({
			[Symbol.asyncIterator]: () => ({
				async next(): Promise<IteratorResult<DesiredStateChange>> {
					return { done: true, value: undefined };
				},
				async return(): Promise<IteratorResult<DesiredStateChange>> {
					entered();
					return new Promise(() => {});
				},
			}),
		});
		const response = await station.handler.handle(
			{
				method: "GET",
				path: "/v1/cd/feed?camp=eu-1",
				headers: { authorization, dpop: proof },
			},
			signal(),
		);
		const body = response.body;
		if (body instanceof Uint8Array) throw new Error("fixture stream missing");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let wire = "";
			let failure: Error | undefined;
			const processing = (async () => {
				try {
					for await (const chunk of body)
						wire += new TextDecoder().decode(chunk);
				} catch (error) {
					if (error instanceof Error) failure = error;
				}
			})();
			await cleanupStarted;
			await vi.advanceTimersByTimeAsync(5_001);
			await processing;
			expect(failure?.message).toBe("The CD delivery feed stream failed.");
			expect(wire).not.toContain("event: end");
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		"closed",
		"stuck",
	] as const)("starts %s iterator cleanup immediately when a long poll is cancelled", async (cleanup) => {
		const station = createStation({ heartbeatMs: 60_000, longPollMs: 120_000 });
		const { key, transport, reconcilerId } = await provisionAgent(station);
		must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const authorization =
			station.exchanges.at(-1)?.request.headers.authorization;
		if (!authorization?.startsWith("DPoP "))
			throw new Error("fixture SVID missing");
		const proof = createDpopProof({
			privateJwk: key.privateJwk,
			method: "GET",
			url: `${BASE_URL}/v1/cd/feed`,
			iatSeconds: Math.floor(station.clock.now() / 1000),
			jti: `abort-${cleanup}`,
			accessToken: authorization.slice(5),
		});
		let nextStarted = () => {};
		const reading = new Promise<void>((resolve) => {
			nextStarted = resolve;
		});
		let cleanupStarted = false;
		station.desired.changes = () => ({
			[Symbol.asyncIterator]: () => ({
				async next(): Promise<IteratorResult<DesiredStateChange>> {
					nextStarted();
					return new Promise(() => {});
				},
				async return(): Promise<IteratorResult<DesiredStateChange>> {
					cleanupStarted = true;
					if (cleanup === "stuck") return new Promise(() => {});
					return { done: true, value: undefined };
				},
			}),
		});
		const controller = new AbortController();
		const response = await station.handler.handle(
			{
				method: "GET",
				path: "/v1/cd/feed?camp=eu-1",
				headers: { authorization, dpop: proof },
			},
			controller.signal,
		);
		const body = response.body;
		if (body instanceof Uint8Array) throw new Error("fixture stream missing");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let result: IteratorResult<Uint8Array> | undefined;
			let failure: Error | undefined;
			const processing = body[Symbol.asyncIterator]()
				.next()
				.then(
					(value) => {
						result = value;
					},
					(error) => {
						if (error instanceof Error) failure = error;
					},
				);
			await reading;
			controller.abort();
			await vi.advanceTimersByTimeAsync(5_001);
			expect(cleanupStarted).toBe(true);
			if (cleanup === "stuck")
				expect(failure?.message).toBe("The CD delivery feed stream failed.");
			else expect(result).toEqual({ value: undefined, done: true });
			await processing;
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps synchronous telemetry failures advisory", () => {
		const station = createStation();
		station.telemetry.metrics = () => {
			throw new Error("synthetic-private-provider.invalid");
		};
		const meter = createMeter(station.telemetry, station.clock.now);
		expect(() => meter("fixture", 1)).not.toThrow();
	});

	it("does not read beyond the bounded feed head before delivering its final frame", async () => {
		const station = createStation();
		const set = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["api"]),
		);
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const changes = station.desired.changes.bind(station.desired);
		let calls = 0;
		station.desired.changes = (input) => ({
			[Symbol.asyncIterator]: () => {
				const iterator = changes(input)[Symbol.asyncIterator]();
				return {
					next() {
						calls += 1;
						if (calls > 1) throw new Error("synthetic-private-journal.invalid");
						return iterator.next();
					},
					async return(): Promise<IteratorResult<DesiredStateChange>> {
						return iterator.return
							? await iterator.return()
							: { done: true, value: undefined };
					},
				};
			},
		});
		const received = await collect(transport.feed({ lease, signal: signal() }));
		expect(received.map((change) => change.set.setId)).toEqual([set.setId]);
		expect(calls).toBe(1);
	});

	it("redacts an uncaught enrollment journal failure in the feed response", async () => {
		const station = createStation();
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		station.store.read = () => ({
			[Symbol.asyncIterator]: () => ({
				async next() {
					throw new Error("synthetic-private-journal.invalid");
				},
			}),
		});
		const result = await transport.renew(lease);
		expect(code(result)).toBe("store-unavailable");
		expect(station.exchanges.at(-1)?.status).toBe(503);
		expect(station.exchanges.at(-1)?.body).not.toContain(
			"synthetic-private-journal.invalid",
		);
	});
});

describe("Station-only egress (I3)", () => {
	it("an agent with Station-only egress converges a target; the Station never holds a target credential", async () => {
		const station = createStation();
		const resolved = resolvedFor("eu-1", ["api", "db"]);
		const set = await station.desired.publish("eu-1", resolved);
		const { transport, reconcilerId } = await provisionAgent(station);

		// The target lives inside the agent's boundary, with a credential only the agent holds.
		const TARGET_CREDENTIAL = "target-local-token-7f3a9c";
		const target = { applied: [] as string[], credentialSeen: [] as string[] };
		const realize = (names: readonly string[], credential: string) => {
			target.credentialSeen.push(credential);
			target.applied.push(...names);
		};

		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "host-a",
				ttlMs: 30_000,
			}),
		);
		const changes = await collect(transport.feed({ lease, signal: signal() }));
		expect(changes.map((c) => c.set.setId)).toEqual([set.setId]);
		const plan = must(await transport.resolved(lease, changes[0]?.set ?? set));
		realize(
			plan.plan.resources.map((r) => r.name),
			TARGET_CREDENTIAL,
		);
		must(
			await transport.report(
				lease,
				observation(lease, set, ReconcileStatus.CONVERGED),
			),
		);
		must(await transport.checkpoint(lease, changes[0]?.position ?? 0n));

		expect(target.applied).toEqual(["api", "db"]);
		const status = station.store.log
			.filter((e) => e.event.streamId === CD_STREAMS.campStatus("eu-1"))
			.map((e) => e.event.type);
		expect(status).toEqual([CD_EVENTS.StatusObserved, CD_EVENTS.Converged]);
		// Nothing about the target credential ever crossed to the Station or its journal.
		const wire = JSON.stringify(
			station.exchanges.map((x) => [x.request, x.body]),
		);
		expect(wire).not.toContain(TARGET_CREDENTIAL);
		expect(JSON.stringify(station.store.log.map((e) => e.event))).not.toContain(
			TARGET_CREDENTIAL,
		);
		// Every exchange was agent → Station over HTTPS to the feed; the Station never dialled out.
		for (const x of station.exchanges)
			expect(x.request.url.startsWith("https://station.test/v1/cd/")).toBe(
				true,
			);
		// The resolved set crosses with secret references only.
		expect(plan.secretRefs).toEqual(["secretref://target/db-password"]);
	});

	it("the first request activates the SVID by key possession and later requests carry it", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const [activation, claim] = station.exchanges.slice(-2);
		expect(activation?.request.url).toBe(
			"https://station.test/v1/cd/svid/refresh",
		);
		expect(activation?.request.headers.authorization).toBeUndefined();
		expect(claim?.request.headers.authorization).toMatch(/^DPoP /);
		expect(claim?.request.headers.dpop).toBeDefined();
	});

	it("refreshes the SVID before expiry and reports the new expiry to CampInventory", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		station.clock.advance(11 * 60_000);
		must(
			await transport
				.renew(lease)
				.then((r) => (r.ok ? r : { ok: true as const, value: lease })),
		);
		const refreshes = station.exchanges.filter((x) =>
			x.request.url.endsWith("/svid/refresh"),
		);
		expect(refreshes).toHaveLength(2);
		expect(refreshes[1]?.request.headers.authorization).toMatch(/^DPoP /);
		const credential = station.inventory.observed.filter(
			(o) =>
				o.source === SignalSource.STATION &&
				o.conditions[0]?.status === ConditionStatus.TRUE,
		);
		expect(credential.length).toBeGreaterThanOrEqual(4);
	});
});

describe("SSE feed", () => {
	it("resumes without gaps or duplicates after a dropped connection", async () => {
		const station = createStation({ maxFramesPerResponse: 100 });
		const sets = [];
		for (let i = 0; i < 5; i += 1)
			sets.push(
				await station.desired.publish(
					"eu-1",
					resolvedFor("eu-1", [`svc-${i}`]),
				),
			);
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		station.cuts.push(2); // the first feed response dies after two frames
		const changes = await collect(transport.feed({ lease, signal: signal() }));
		expect(changes.map((c) => c.set.setId)).toEqual(sets.map((s) => s.setId));
		const feeds = station.exchanges.filter((x) =>
			x.request.url.includes("/v1/cd/feed"),
		);
		expect(feeds).toHaveLength(2);
		expect(feeds[1]?.request.headers["last-event-id"]).toBe(
			changes[1]?.position.toString(10),
		);
		expect(feeds[1]?.request.url).not.toContain("redeliver");
	});

	it("resumes after the committed checkpoint: only newer changes, and the current one is re-delivered once per lease", async () => {
		const station = createStation();
		const first = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["a"]),
		);
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		// Same lease, nothing newer: long-poll ends with no frames (no duplicate).
		expect(await collect(transport.feed({ lease, signal: signal() }))).toEqual(
			[],
		);
		const second = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["b"]),
		);
		expect(
			(await collect(transport.feed({ lease, signal: signal() }))).map(
				(c) => c.set.setId,
			),
		).toEqual([second.setId]);
		// A new lease (restart) re-delivers the current change so the target is re-observed.
		await transport.release(lease);
		const next = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h2",
				ttlMs: 30_000,
			}),
		);
		expect(
			(await collect(transport.feed({ lease: next, signal: signal() }))).map(
				(c) => c.set.setId,
			),
		).toEqual([second.setId]);
		expect(first.setId).not.toBe(second.setId);
	});

	it("sends heartbeats while long-polling and ends with an explicit end event", async () => {
		const station = createStation({ heartbeatMs: 5, longPollMs: 40 });
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		await collect(transport.feed({ lease, signal: signal() }));
		const body =
			station.exchanges
				.filter((x) => x.request.url.includes("/v1/cd/feed"))
				.at(-1)?.body ?? "";
		expect(body).toContain(": heartbeat");
		expect(body).toContain('event: end\ndata: {"reason":"long-poll"}');
		expect(set.setId).toBeTruthy();
	});

	it("a change published during the long-poll is delivered at once", async () => {
		const station = createStation({ heartbeatMs: 5, longPollMs: 2_000 });
		await station.desired.publish("eu-1", resolvedFor("eu-1", ["a"]));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		const started = Date.now();
		const pending = collect(transport.feed({ lease, signal: signal() }));
		setTimeout(
			() => void station.desired.publish("eu-1", resolvedFor("eu-1", ["b"])),
			30,
		);
		const delivered = await pending;
		expect(delivered).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(1_500);
	});

	it("bounds frames per response (back-pressure) and continues in the next response", async () => {
		const station = createStation({ maxFramesPerResponse: 2 });
		for (let i = 0; i < 5; i += 1)
			await station.desired.publish("eu-1", resolvedFor("eu-1", [`s${i}`]));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const first = await collect(transport.feed({ lease, signal: signal() }));
		expect(first).toHaveLength(2);
		must(await transport.checkpoint(lease, first[1]?.position ?? 0n));
		const second = await collect(transport.feed({ lease, signal: signal() }));
		expect(second).toHaveLength(2);
		expect(second[0]?.position).toBeGreaterThan(first[1]?.position ?? 0n);
	});

	it("inlines resolved sets up to 256 KiB and sends larger ones by digest", async () => {
		const station = createStation();
		const small = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["a"]),
		);
		const big = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["b"], 300_000),
		);
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		await collect(transport.feed({ lease, signal: signal() }));
		const body =
			station.exchanges
				.filter((x) => x.request.url.includes("/v1/cd/feed"))
				.at(-1)?.body ?? "";
		const frames = body
			.split("\n")
			.filter((l) => l.startsWith('data: {"position'))
			.map((l) => JSON.parse(l.slice(6)));
		expect(frames[0].resolvedSetJson).toBeTruthy();
		expect(frames[1].resolvedSetJson ?? "").toBe("");
		const before = station.exchanges.length;
		expect(must(await transport.resolved(lease, small)).contentHash).toBe(
			small.contentHash,
		);
		expect(station.exchanges.length).toBe(before); // inline: no fetch
		expect(must(await transport.resolved(lease, big)).contentHash).toBe(
			big.contentHash,
		);
		expect(station.exchanges.at(-1)?.request.url).toContain(
			`/v1/cd/blobs/${encodeURIComponent(big.resolvedSetDigest)}`,
		);
	});

	it("a missing or corrupt blob is a typed refusal at the agent", async () => {
		const station = createStation();
		const missing = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["a"], 300_000),
			{ storeBlob: false },
		);
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		expect(code(await transport.resolved(lease, missing))).toBe(
			"resolved-set-missing",
		);
		const corrupt = await station.desired.publish(
			"eu-1",
			resolvedFor("eu-1", ["c"], 300_000),
		);
		station.artifacts.blobs.set(
			corrupt.resolvedSetDigest,
			new TextEncoder().encode("{}"),
		);
		expect(code(await transport.resolved(lease, corrupt))).toBe(
			"resolved-set-mismatch",
		);
	});

	it("OBSERVE_ONLY declared topology wins in the frame", async () => {
		const station = createStation({ observeOnly: ["eu-1"] });
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		expect(change?.management).toBe(CampManagement.OBSERVE_ONLY);
		expect(change?.observeFields).toEqual(["tls.minVersion"]);
	});
});

describe("fenced leases, reports and checkpoints (I4)", () => {
	it("two reconcilers, one Camp: one writer; the other is refused and a stale fence cannot write", async () => {
		const station = createStation();
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const a = await provisionAgent(station);
		const b = await provisionAgent(station);
		const lease = must(
			await a.transport.claim({
				reconcilerId: a.reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		expect(
			code(
				await b.transport.claim({
					reconcilerId: b.reconcilerId,
					campId: camp("eu-1"),
					holderId: "h",
					ttlMs: 30_000,
				}),
			),
		).toBe("lease-held");
		station.clock.advance(31_000);
		const taken = must(
			await b.transport.claim({
				reconcilerId: b.reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		expect(taken.fence).toBeGreaterThan(lease.fence);
		expect(
			code(
				await a.transport.report(
					lease,
					observation(lease, set, ReconcileStatus.CONVERGED),
				),
			),
		).toBe("stale-fence");
		expect(code(await a.transport.checkpoint(lease, 1n as never))).toBe(
			"stale-fence",
		);
		// A lease cannot be borrowed by another reconciler.
		expect(
			code(
				await b.transport.report(
					lease,
					observation(lease, set, ReconcileStatus.CONVERGED),
				),
			),
		).toBe("lease-mismatch");
	});

	it("checkpoints are monotonic and observations must carry the lease stamp and declared attributes only", async () => {
		const station = createStation();
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		must(await transport.checkpoint(lease, 5n as never));
		expect(code(await transport.checkpoint(lease, 4n as never))).toBe(
			"checkpoint-regression",
		);
		const wrongFence: ReconcilerLease = { ...lease };
		expect(
			code(
				await transport.report(
					wrongFence,
					observation(lease, set, ReconcileStatus.CONVERGED, {
						fenceToken: "999",
					}),
				),
			),
		).toBe("observation-invalid");
		const undeclared = observation(lease, set, ReconcileStatus.CONVERGED, {
			resources: [
				{ resource: "api", attributes: { "password.hash": "x" } } as never,
			],
		});
		expect(code(await transport.report(lease, undeclared))).toBe(
			"attribute-undeclared",
		);
		const oversize = observation(lease, set, ReconcileStatus.CONVERGED, {
			resources: [
				{
					resource: "api",
					attributes: { "tls.minVersion": "x".repeat(17_000) },
				} as never,
			],
		});
		expect(code(await transport.report(lease, oversize))).toBe(
			"attribute-oversize",
		);
	});

	it("reports land on the status stream, never the spec stream", async () => {
		const station = createStation();
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const specBefore = station.store.getStreamHead?.(
			CD_STREAMS.campSpec("eu-1"),
		)?.revision;
		must(
			await transport.report(
				lease,
				observation(lease, set, ReconcileStatus.CONVERGING),
			),
		);
		must(
			await transport.report(
				lease,
				observation(lease, set, ReconcileStatus.BLOCKED),
			),
		);
		expect(
			station.store.getStreamHead?.(CD_STREAMS.campSpec("eu-1"))?.revision,
		).toBe(specBefore);
		const types = station.store.log
			.filter((e) => e.event.streamId === CD_STREAMS.campStatus("eu-1"))
			.map((e) => e.event.type);
		expect(types).toEqual([
			CD_EVENTS.ReconcileStarted,
			CD_EVENTS.StatusObserved,
			CD_EVENTS.StatusObserved,
			CD_EVENTS.ReconcileBlocked,
		]);
	});
});

describe("enrollment gating at the feed (I24)", () => {
	it("a reconciler with only one enrollment grant is refused with enrollment-incomplete", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station, {
			grants: "key-only",
		});
		expect(
			code(
				await transport.claim({
					reconcilerId,
					campId: camp("eu-1"),
					holderId: "h",
					ttlMs: 30_000,
				}),
			),
		).toBe(ENROLLMENT_INCOMPLETE);
		expect(station.exchanges.at(-1)?.status).toBe(403);
	});

	it("a Camp the reconciler is not accepted for is refused", async () => {
		const station = createStation({ camps: ["eu-1", "eu-2"] });
		await station.desired.publish("eu-2", resolvedFor("eu-2"));
		const { transport, reconcilerId } = await provisionAgent(station, {
			campIds: ["eu-1"],
		});
		expect(
			code(
				await transport.claim({
					reconcilerId,
					campId: camp("eu-2"),
					holderId: "h",
					ttlMs: 30_000,
				}),
			),
		).toBe("camp-not-accepted");
	});

	it("a revoked agent mid-feed is refused on the next request", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		await collect(transport.feed({ lease, signal: signal() }));
		must(
			await station.enrollment.revoke(reconcilerId, "compromised", {
				tenant: "acme",
				principal: { kind: "user", id: "alice" },
				now: station.clock.now,
			}),
		);
		expect(code(await transport.renew(lease))).toBe("reconciler-revoked");
		await expect(
			collect(transport.feed({ lease, signal: signal() })),
		).rejects.toBeInstanceOf(FeedRefusedError);
	});

	it("unauthenticated requests and unknown routes are refused with typed envelopes", async () => {
		const station = createStation();
		const send = (method: "GET" | "POST", path: string, body?: string) =>
			station.http({
				method,
				url: `https://station.test${path}`,
				headers: {},
				...(body ? { body } : {}),
				timeoutMs: 1000,
				maxResponseBytes: 1_000_000,
			});
		const noAuth = await send("POST", "/v1/cd/leases", "{}");
		expect(noAuth.status).toBe(401);
		expect(JSON.parse(noAuth.body).reasons[0].code).toBe("svid-required");
		expect((await send("GET", "/v1/cd/nope")).status).toBe(404);
		expect((await send("GET", "/v1/cd/leases")).status).toBe(405);
		expect((await send("POST", "/v1/cd/enrollments", "not json")).status).toBe(
			400,
		);
		expect(
			JSON.parse(
				(
					await send(
						"POST",
						"/v1/cd/enrollments",
						JSON.stringify({ token: "hcd_bt_x", publicJwk: { kty: "EC" } }),
					)
				).body,
			).reasons[0].code,
		).toBe("jwk-invalid");
	});

	it("emits feed metrics through the TelemetrySink", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(
			await transport.claim({
				reconcilerId,
				campId: camp("eu-1"),
				holderId: "h",
				ttlMs: 30_000,
			}),
		);
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		const names = new Set(station.telemetry.points.map((p) => p.name));
		for (const name of [
			"hobo.cd.feed.requests",
			"hobo.cd.feed.request_ms",
			"hobo.cd.feed.frames",
			"hobo.cd.feed.responses",
			"hobo.cd.feed.checkpoint_ms",
		])
			expect(names).toContain(name);
	});
});
