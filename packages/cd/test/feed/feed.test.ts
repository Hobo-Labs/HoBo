/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: tests inspect controlled JSON bodies. */
// Delivery feed + agent HTTP transport end to end (C10, D5, I3, I4, I24):
// Station-only egress converges a target with no target credential at the
// Station; SSE resumes without gaps or duplicates; inline vs digest-only
// resolved sets; fenced leases, reports and checkpoints; enrollment gating.
import { describe, expect, it } from "vitest";
import { CampManagement, ConditionStatus, ReconcileStatus, SignalSource } from "../../src/_generated/cd_pb.js";
import { FeedRefusedError } from "../../src/agent/index.js";
import { CD_EVENTS, CD_STREAMS, ENROLLMENT_INCOMPLETE } from "../../src/events.js";
import type { Outcome, ReconcilerLease } from "../../src/ports.js";
import { resolvedFor } from "./fakes.js";
import { camp, collect, createStation, observation, provisionAgent } from "./harness.js";

function code<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : (outcome.reasons[0]?.code ?? "");
}

function must<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(`${outcome.reasons[0]?.code}: ${outcome.reasons[0]?.message}`);
	return outcome.value;
}

const signal = () => new AbortController().signal;

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

		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "host-a", ttlMs: 30_000 }));
		const changes = await collect(transport.feed({ lease, signal: signal() }));
		expect(changes.map((c) => c.set.setId)).toEqual([set.setId]);
		const plan = must(await transport.resolved(lease, changes[0]?.set ?? set));
		realize(
			plan.plan.resources.map((r) => r.name),
			TARGET_CREDENTIAL,
		);
		must(await transport.report(lease, observation(lease, set, ReconcileStatus.CONVERGED)));
		must(await transport.checkpoint(lease, changes[0]?.position ?? 0n));

		expect(target.applied).toEqual(["api", "db"]);
		const status = station.store.log.filter((e) => e.event.streamId === CD_STREAMS.campStatus("eu-1")).map((e) => e.event.type);
		expect(status).toEqual([CD_EVENTS.StatusObserved, CD_EVENTS.Converged]);
		// Nothing about the target credential ever crossed to the Station or its journal.
		const wire = JSON.stringify(station.exchanges.map((x) => [x.request, x.body]));
		expect(wire).not.toContain(TARGET_CREDENTIAL);
		expect(JSON.stringify(station.store.log.map((e) => e.event))).not.toContain(TARGET_CREDENTIAL);
		// Every exchange was agent → Station over HTTPS to the feed; the Station never dialled out.
		for (const x of station.exchanges) expect(x.request.url.startsWith("https://station.test/v1/cd/")).toBe(true);
		// The resolved set crosses with secret references only.
		expect(plan.secretRefs).toEqual(["secretref://target/db-password"]);
	});

	it("the first request activates the SVID by key possession and later requests carry it", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const [activation, claim] = station.exchanges.slice(-2);
		expect(activation?.request.url).toBe("https://station.test/v1/cd/svid/refresh");
		expect(activation?.request.headers.authorization).toBeUndefined();
		expect(claim?.request.headers.authorization).toMatch(/^DPoP /);
		expect(claim?.request.headers.dpop).toBeDefined();
	});

	it("refreshes the SVID before expiry and reports the new expiry to CampInventory", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		station.clock.advance(11 * 60_000);
		must(await transport.renew(lease).then((r) => (r.ok ? r : { ok: true as const, value: lease })));
		const refreshes = station.exchanges.filter((x) => x.request.url.endsWith("/svid/refresh"));
		expect(refreshes).toHaveLength(2);
		expect(refreshes[1]?.request.headers.authorization).toMatch(/^DPoP /);
		const credential = station.inventory.observed.filter((o) => o.source === SignalSource.STATION && o.conditions[0]?.status === ConditionStatus.TRUE);
		expect(credential.length).toBeGreaterThanOrEqual(4);
	});
});

describe("SSE feed", () => {
	it("resumes without gaps or duplicates after a dropped connection", async () => {
		const station = createStation({ maxFramesPerResponse: 100 });
		const sets = [];
		for (let i = 0; i < 5; i += 1) sets.push(await station.desired.publish("eu-1", resolvedFor("eu-1", [`svc-${i}`])));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		station.cuts.push(2); // the first feed response dies after two frames
		const changes = await collect(transport.feed({ lease, signal: signal() }));
		expect(changes.map((c) => c.set.setId)).toEqual(sets.map((s) => s.setId));
		const feeds = station.exchanges.filter((x) => x.request.url.includes("/v1/cd/feed"));
		expect(feeds).toHaveLength(2);
		expect(feeds[1]?.request.headers["last-event-id"]).toBe(changes[1]?.position.toString(10));
		expect(feeds[1]?.request.url).not.toContain("redeliver");
	});

	it("resumes after the committed checkpoint: only newer changes, and the current one is re-delivered once per lease", async () => {
		const station = createStation();
		const first = await station.desired.publish("eu-1", resolvedFor("eu-1", ["a"]));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		// Same lease, nothing newer: long-poll ends with no frames (no duplicate).
		expect(await collect(transport.feed({ lease, signal: signal() }))).toEqual([]);
		const second = await station.desired.publish("eu-1", resolvedFor("eu-1", ["b"]));
		expect((await collect(transport.feed({ lease, signal: signal() }))).map((c) => c.set.setId)).toEqual([second.setId]);
		// A new lease (restart) re-delivers the current change so the target is re-observed.
		await transport.release(lease);
		const next = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h2", ttlMs: 30_000 }));
		expect((await collect(transport.feed({ lease: next, signal: signal() }))).map((c) => c.set.setId)).toEqual([second.setId]);
		expect(first.setId).not.toBe(second.setId);
	});

	it("sends heartbeats while long-polling and ends with an explicit end event", async () => {
		const station = createStation({ heartbeatMs: 5, longPollMs: 40 });
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		await collect(transport.feed({ lease, signal: signal() }));
		const body = station.exchanges.filter((x) => x.request.url.includes("/v1/cd/feed")).at(-1)?.body ?? "";
		expect(body).toContain(": heartbeat");
		expect(body).toContain('event: end\ndata: {"reason":"long-poll"}');
		expect(set.setId).toBeTruthy();
	});

	it("a change published during the long-poll is delivered at once", async () => {
		const station = createStation({ heartbeatMs: 5, longPollMs: 2_000 });
		await station.desired.publish("eu-1", resolvedFor("eu-1", ["a"]));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		const started = Date.now();
		const pending = collect(transport.feed({ lease, signal: signal() }));
		setTimeout(() => void station.desired.publish("eu-1", resolvedFor("eu-1", ["b"])), 30);
		const delivered = await pending;
		expect(delivered).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(1_500);
	});

	it("bounds frames per response (back-pressure) and continues in the next response", async () => {
		const station = createStation({ maxFramesPerResponse: 2 });
		for (let i = 0; i < 5; i += 1) await station.desired.publish("eu-1", resolvedFor("eu-1", [`s${i}`]));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const first = await collect(transport.feed({ lease, signal: signal() }));
		expect(first).toHaveLength(2);
		must(await transport.checkpoint(lease, first[1]?.position ?? 0n));
		const second = await collect(transport.feed({ lease, signal: signal() }));
		expect(second).toHaveLength(2);
		expect(second[0]?.position).toBeGreaterThan(first[1]?.position ?? 0n);
	});

	it("inlines resolved sets up to 256 KiB and sends larger ones by digest", async () => {
		const station = createStation();
		const small = await station.desired.publish("eu-1", resolvedFor("eu-1", ["a"]));
		const big = await station.desired.publish("eu-1", resolvedFor("eu-1", ["b"], 300_000));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		await collect(transport.feed({ lease, signal: signal() }));
		const body = station.exchanges.filter((x) => x.request.url.includes("/v1/cd/feed")).at(-1)?.body ?? "";
		const frames = body
			.split("\n")
			.filter((l) => l.startsWith("data: {\"position"))
			.map((l) => JSON.parse(l.slice(6)));
		expect(frames[0].resolvedSetJson).toBeTruthy();
		expect(frames[1].resolvedSetJson ?? "").toBe("");
		const before = station.exchanges.length;
		expect(must(await transport.resolved(lease, small)).contentHash).toBe(small.contentHash);
		expect(station.exchanges.length).toBe(before); // inline: no fetch
		expect(must(await transport.resolved(lease, big)).contentHash).toBe(big.contentHash);
		expect(station.exchanges.at(-1)?.request.url).toContain(`/v1/cd/blobs/${encodeURIComponent(big.resolvedSetDigest)}`);
	});

	it("a missing or corrupt blob is a typed refusal at the agent", async () => {
		const station = createStation();
		const missing = await station.desired.publish("eu-1", resolvedFor("eu-1", ["a"], 300_000), { storeBlob: false });
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		expect(code(await transport.resolved(lease, missing))).toBe("resolved-set-missing");
		const corrupt = await station.desired.publish("eu-1", resolvedFor("eu-1", ["c"], 300_000));
		station.artifacts.blobs.set(corrupt.resolvedSetDigest, new TextEncoder().encode("{}"));
		expect(code(await transport.resolved(lease, corrupt))).toBe("resolved-set-mismatch");
	});

	it("OBSERVE_ONLY declared topology wins in the frame", async () => {
		const station = createStation({ observeOnly: ["eu-1"] });
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
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
		const lease = must(await a.transport.claim({ reconcilerId: a.reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		expect(code(await b.transport.claim({ reconcilerId: b.reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }))).toBe("lease-held");
		station.clock.advance(31_000);
		const taken = must(await b.transport.claim({ reconcilerId: b.reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		expect(taken.fence).toBeGreaterThan(lease.fence);
		expect(code(await a.transport.report(lease, observation(lease, set, ReconcileStatus.CONVERGED)))).toBe("stale-fence");
		expect(code(await a.transport.checkpoint(lease, 1n as never))).toBe("stale-fence");
		// A lease cannot be borrowed by another reconciler.
		expect(code(await b.transport.report(lease, observation(lease, set, ReconcileStatus.CONVERGED)))).toBe("lease-mismatch");
	});

	it("checkpoints are monotonic and observations must carry the lease stamp and declared attributes only", async () => {
		const station = createStation();
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		must(await transport.checkpoint(lease, 5n as never));
		expect(code(await transport.checkpoint(lease, 4n as never))).toBe("checkpoint-regression");
		const wrongFence: ReconcilerLease = { ...lease };
		expect(code(await transport.report(wrongFence, observation(lease, set, ReconcileStatus.CONVERGED, { fenceToken: "999" })))).toBe("observation-invalid");
		const undeclared = observation(lease, set, ReconcileStatus.CONVERGED, {
			resources: [{ resource: "api", attributes: { "password.hash": "x" } } as never],
		});
		expect(code(await transport.report(lease, undeclared))).toBe("attribute-undeclared");
		const oversize = observation(lease, set, ReconcileStatus.CONVERGED, {
			resources: [{ resource: "api", attributes: { "tls.minVersion": "x".repeat(17_000) } } as never],
		});
		expect(code(await transport.report(lease, oversize))).toBe("attribute-oversize");
	});

	it("reports land on the status stream, never the spec stream", async () => {
		const station = createStation();
		const set = await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const specBefore = station.store.getStreamHead?.(CD_STREAMS.campSpec("eu-1"))?.revision;
		must(await transport.report(lease, observation(lease, set, ReconcileStatus.CONVERGING)));
		must(await transport.report(lease, observation(lease, set, ReconcileStatus.BLOCKED)));
		expect(station.store.getStreamHead?.(CD_STREAMS.campSpec("eu-1"))?.revision).toBe(specBefore);
		const types = station.store.log.filter((e) => e.event.streamId === CD_STREAMS.campStatus("eu-1")).map((e) => e.event.type);
		expect(types).toEqual([CD_EVENTS.ReconcileStarted, CD_EVENTS.StatusObserved, CD_EVENTS.StatusObserved, CD_EVENTS.ReconcileBlocked]);
	});
});

describe("enrollment gating at the feed (I24)", () => {
	it("a reconciler with only one enrollment grant is refused with enrollment-incomplete", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station, { grants: "key-only" });
		expect(code(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }))).toBe(ENROLLMENT_INCOMPLETE);
		expect(station.exchanges.at(-1)?.status).toBe(403);
	});

	it("a Camp the reconciler is not accepted for is refused", async () => {
		const station = createStation({ camps: ["eu-1", "eu-2"] });
		await station.desired.publish("eu-2", resolvedFor("eu-2"));
		const { transport, reconcilerId } = await provisionAgent(station, { campIds: ["eu-1"] });
		expect(code(await transport.claim({ reconcilerId, campId: camp("eu-2"), holderId: "h", ttlMs: 30_000 }))).toBe("camp-not-accepted");
	});

	it("a revoked agent mid-feed is refused on the next request", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		await collect(transport.feed({ lease, signal: signal() }));
		must(await station.enrollment.revoke(reconcilerId, "compromised", { tenant: "acme", principal: { kind: "user", id: "alice" }, now: station.clock.now }));
		expect(code(await transport.renew(lease))).toBe("reconciler-revoked");
		await expect(collect(transport.feed({ lease, signal: signal() }))).rejects.toBeInstanceOf(FeedRefusedError);
	});

	it("unauthenticated requests and unknown routes are refused with typed envelopes", async () => {
		const station = createStation();
		const send = (method: "GET" | "POST", path: string, body?: string) =>
			station.http({ method, url: `https://station.test${path}`, headers: {}, ...(body ? { body } : {}), timeoutMs: 1000, maxResponseBytes: 1_000_000 });
		const noAuth = await send("POST", "/v1/cd/leases", "{}");
		expect(noAuth.status).toBe(401);
		expect(JSON.parse(noAuth.body).reasons[0].code).toBe("svid-required");
		expect((await send("GET", "/v1/cd/nope")).status).toBe(404);
		expect((await send("GET", "/v1/cd/leases")).status).toBe(405);
		expect((await send("POST", "/v1/cd/enrollments", "not json")).status).toBe(400);
		expect(JSON.parse((await send("POST", "/v1/cd/enrollments", JSON.stringify({ token: "hcd_bt_x", publicJwk: { kty: "EC" } }))).body).reasons[0].code).toBe(
			"jwk-invalid",
		);
	});

	it("emits feed metrics through the TelemetrySink", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = must(await transport.claim({ reconcilerId, campId: camp("eu-1"), holderId: "h", ttlMs: 30_000 }));
		const [change] = await collect(transport.feed({ lease, signal: signal() }));
		must(await transport.checkpoint(lease, change?.position ?? 0n));
		const names = new Set(station.telemetry.points.map((p) => p.name));
		for (const name of ["hobo.cd.feed.requests", "hobo.cd.feed.request_ms", "hobo.cd.feed.frames", "hobo.cd.feed.responses", "hobo.cd.feed.checkpoint_ms"])
			expect(names).toContain(name);
	});
});
