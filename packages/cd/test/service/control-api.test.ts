/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: tests read controlled JSON envelopes. */
// WP12 read API over the CD ports: every route, query parsing, refusals with
// remediation, feed fall-through, and the SSE stream resuming by Last-Event-ID.
import { describe, expect, it } from "vitest";
import { CD_EVENTS } from "../../src/events.js";
import type { FeedRequest } from "../../src/ports.js";
import { CD_API_METRICS } from "../../src/service/index.js";
import { get, json, setupApi, text } from "./harness.js";
import { FREIGHT_ID, RAIL_DIGEST } from "./state.js";

const signal = () => new AbortController().signal;

describe("CD read API — routes", () => {
	it("GET /v1/cd/pipelines/{name}: graph with per-node current Freight and availability", async () => {
		const { api } = setupApi();
		const res = await api.handle(get("/v1/cd/pipelines/shop"), signal());
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/application\/json/);
		const body = await json(res);
		expect(body.ok).toBe(true);
		expect(body.value.pipeline.name).toBe("shop");
		const [staging, prod] = body.value.nodes;
		expect(staging).toMatchObject({
			name: "staging",
			camps: [{ campId: "stg-1", freightId: FREIGHT_ID, setId: "set-1" }],
		});
		expect(staging.edges).toEqual({ fromSources: ["shop-oci"], fromNodes: [] });
		expect(prod.placement).toBe("eu-fleet");
		expect(prod.camps).toEqual([
			{ campId: "eu-1", freightId: FREIGHT_ID, setId: "set-2" },
		]);
		expect(prod.qualified).toEqual({
			campIds: ["eu-1"],
			freightId: FREIGHT_ID,
		});
		expect(prod.available[0]).toMatchObject({
			freightId: FREIGHT_ID,
			via: ["staging"],
		});
	});

	it("unknown pipeline is a typed not-found with remediation", async () => {
		const { api } = setupApi();
		const res = await api.handle(get("/v1/cd/pipelines/nope"), signal());
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.reasons?.[0]).toMatchObject({
			code: "not-found",
			subject: "nope",
		});
		expect(body.reasons?.[0].remediation).not.toBe("");
	});

	it("GET /v1/cd/freight/{id}: timeline across Camps, in time order", async () => {
		const { api } = setupApi();
		const res = await api.handle(
			get(`/v1/cd/freight/${encodeURIComponent(FREIGHT_ID)}`),
			signal(),
		);
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.value.freight.alias).toBe("brave-otter");
		const kinds = body.value.timeline.map(
			(e: { kind: string; campId?: string }) => `${e.kind}:${e.campId ?? ""}`,
		);
		expect(kinds).toEqual([
			"recorded:",
			"promotion:stg-1",
			"qualified:stg-1",
			"approved:eu-2",
			"promotion:eu-1",
		]);
		expect(body.value.camps).toEqual(["eu-1", "eu-2", "stg-1"]);
	});

	it("GET /v1/cd/freight/{id} resolves an alias too", async () => {
		const { api, cd } = setupApi();
		(cd.freight as { getByAlias: (a: string) => Promise<unknown> }).getByAlias =
			async (a: string) =>
				a === "brave-otter" ? cd.state.freight[0] : undefined;
		const res = await api.handle(get("/v1/cd/freight/brave-otter"), signal());
		expect(res.status).toBe(200);
	});

	it("GET /v1/cd/promotions?camp=: filtered and bounded", async () => {
		const { api } = setupApi();
		const all = await json(
			await api.handle(get("/v1/cd/promotions"), signal()),
		);
		expect(all.value.promotions).toHaveLength(2);
		const one = await json(
			await api.handle(get("/v1/cd/promotions?camp=eu-1"), signal()),
		);
		expect(
			one.value.promotions.map((p: { promotionId: string }) => p.promotionId),
		).toEqual(["prm-2"]);
		expect(one.value.promotions[0].state).toBe("PROMOTION_STATE_VERIFYING");
		const bad = await api.handle(get("/v1/cd/promotions?limit=0"), signal());
		expect(bad.status).toBe(400);
		expect((await json(bad)).reasons?.[0]).toMatchObject({
			code: "query-invalid",
			subject: "limit",
		});
	});

	it("GET /v1/cd/camps/{id}/status: desired Set, last observation and inventory", async () => {
		const { api } = setupApi();
		const body = await json(
			await api.handle(get("/v1/cd/camps/stg-1/status"), signal()),
		);
		expect(body.value).toMatchObject({
			campId: "stg-1",
			current: { setId: "set-1" },
			observation: { status: "RECONCILE_STATUS_CONVERGED", fenceToken: "7" },
		});
		const missing = await api.handle(
			get("/v1/cd/camps/ghost/status"),
			signal(),
		);
		expect(missing.status).toBe(404);
	});

	it("GET /v1/cd/camps?set=&taint=&condition=", async () => {
		const { api } = setupApi();
		const ids = async (q: string) =>
			(
				await json(await api.handle(get(`/v1/cd/camps${q}`), signal()))
			).value.camps.map(
				(c: { topology: { campId: string } }) => c.topology.campId,
			);
		expect(await ids("")).toEqual(["eu-1", "eu-2", "stg-1"]);
		expect(await ids("?set=eu")).toEqual(["eu-1", "eu-2"]);
		expect(await ids("?taint=NO_PLACE")).toEqual(["eu-2"]);
		expect(await ids("?taint=hobo.cd/unreachable")).toEqual(["eu-2"]);
		expect(await ids("?condition=READY")).toEqual(["eu-1", "stg-1"]);
		expect(await ids("?condition=ready=false")).toEqual(["eu-2"]);
		expect(await ids("?set=eu&condition=READY")).toEqual(["eu-1"]);
		const bad = await api.handle(get("/v1/cd/camps?condition=SHINY"), signal());
		expect(bad.status).toBe(400);
		expect((await json(bad)).reasons?.[0]).toMatchObject({
			code: "query-invalid",
			subject: "condition",
		});
	});

	it("GET /v1/cd/camps/{id}/inventory: declared topology plus observed status", async () => {
		const { api } = setupApi();
		const body = await json(
			await api.handle(get("/v1/cd/camps/eu-2/inventory"), signal()),
		);
		expect(body.value.topology).toMatchObject({
			campId: "eu-2",
			regions: ["eu-west-1"],
		});
		expect(body.value.status.taints[0]).toMatchObject({
			effect: "TAINT_EFFECT_NO_PLACE",
		});
		expect(
			(await api.handle(get("/v1/cd/camps/ghost/inventory"), signal())).status,
		).toBe(404);
	});

	it("GET /v1/cd/placements/{name}/decisions/{id}", async () => {
		const { api } = setupApi();
		const body = await json(
			await api.handle(
				get("/v1/cd/placements/eu-fleet/decisions/pd-1"),
				signal(),
			),
		);
		expect(body.value.decision).toMatchObject({
			decisionId: "pd-1",
			inventoryDigest: "sha256:cccc",
		});
		// A decision must belong to the named placement.
		expect(
			(
				await api.handle(
					get("/v1/cd/placements/other/decisions/pd-1"),
					signal(),
				)
			).status,
		).toBe(404);
	});

	it("GET /v1/cd/fanouts/{id}", async () => {
		const { api } = setupApi();
		const body = await json(
			await api.handle(get("/v1/cd/fanouts/fan-1"), signal()),
		);
		expect(body.value.fanout).toMatchObject({
			state: "FANOUT_STATE_RUNNING",
			deferred: ["eu-2"],
		});
		expect(
			(await api.handle(get("/v1/cd/fanouts/none"), signal())).status,
		).toBe(404);
	});

	it("GET /v1/cd/failovers?state=", async () => {
		const { api } = setupApi();
		const all = await json(await api.handle(get("/v1/cd/failovers"), signal()));
		expect(all.value.failovers).toHaveLength(2);
		const proposed = await json(
			await api.handle(get("/v1/cd/failovers?state=PROPOSED"), signal()),
		);
		expect(
			proposed.value.failovers.map((f: { failoverId: string }) => f.failoverId),
		).toEqual(["fo-1"]);
		const full = await json(
			await api.handle(
				get("/v1/cd/failovers?state=FAILOVER_STATE_COMPLETED"),
				signal(),
			),
		);
		expect(
			full.value.failovers.map((f: { failoverId: string }) => f.failoverId),
		).toEqual(["fo-0"]);
		expect(
			(await api.handle(get("/v1/cd/failovers?state=LOST"), signal())).status,
		).toBe(400);
	});

	it("GET /v1/cd/compliance?camp=&rail=", async () => {
		const { api } = setupApi();
		const camp = await json(
			await api.handle(get("/v1/cd/compliance?camp=eu-1"), signal()),
		);
		expect(camp.value.compliance).toHaveLength(2);
		const rail = await json(
			await api.handle(
				get(
					`/v1/cd/compliance?camp=eu-1&rail=${encodeURIComponent(RAIL_DIGEST)}`,
				),
				signal(),
			),
		);
		expect(rail.value.compliance).toEqual([
			expect.objectContaining({
				candidate: true,
				state: "COMPLIANCE_STATE_COMPLIANT",
			}),
		]);
		const fleet = await json(
			await api.handle(
				get(`/v1/cd/compliance?rail=${encodeURIComponent(RAIL_DIGEST)}`),
				signal(),
			),
		);
		expect(fleet.value.compliance).toHaveLength(1);
		expect(
			(await api.handle(get("/v1/cd/compliance?rail=md5:x"), signal())).status,
		).toBe(400);
	});

	it("GET /v1/cd/ready mirrors service readiness (503 before start)", async () => {
		const { api, service } = setupApi();
		const before = await api.handle(get("/v1/cd/ready"), signal());
		expect(before.status).toBe(503);
		expect((await json(before)).reasons?.[0]).toMatchObject({
			code: "not-ready",
		});
		await service.start();
		const after = await api.handle(get("/v1/cd/ready"), signal());
		expect(after.status).toBe(200);
		expect((await json(after)).value.ok).toBe(true);
		await service.drain(AbortSignal.timeout(500));
	});

	it("GET /v1/cd/openapi.json lists every read route", async () => {
		const { api } = setupApi();
		const doc = (await json(
			await api.handle(get("/v1/cd/openapi.json"), signal()),
		)) as unknown as {
			openapi: string;
			paths: Record<string, unknown>;
		};
		expect(doc.openapi).toBe("3.1.0");
		expect(Object.keys(doc.paths).sort()).toEqual(
			[
				"/v1/cd/camps",
				"/v1/cd/camps/{id}/inventory",
				"/v1/cd/camps/{id}/status",
				"/v1/cd/compliance",
				"/v1/cd/failovers",
				"/v1/cd/fanouts/{id}",
				"/v1/cd/freight/{id}",
				"/v1/cd/openapi.json",
				"/v1/cd/pipelines/{name}",
				"/v1/cd/placements/{name}/decisions/{id}",
				"/v1/cd/promotions",
				"/v1/cd/ready",
				"/v1/cd/stream",
			].sort(),
		);
		expect(api.openapi()).toEqual(doc);
	});

	it("read routes refuse mutations with method-not-allowed", async () => {
		const { api } = setupApi();
		const res = await api.handle(
			{
				method: "POST",
				path: "/v1/cd/camps",
				headers: {},
				body: new Uint8Array(),
			},
			signal(),
		);
		expect(res.status).toBe(405);
		expect(res.headers.allow).toBe("GET");
	});

	it("non-read /v1/cd/ paths fall through to the delivery feed unchanged", async () => {
		const { api, cd } = setupApi();
		const req: FeedRequest = {
			method: "POST",
			path: "/v1/cd/leases",
			headers: { authorization: "x" },
			body: new Uint8Array([1]),
		};
		const res = await api.handle(req, signal());
		expect(res.status).toBe(404);
		expect(cd.feedRequests).toEqual([req]);
	});

	it("rejects path parameters with control characters or traversal", async () => {
		const { api } = setupApi();
		expect(
			(await api.handle(get("/v1/cd/fanouts/..%2F..%2Fetc"), signal())).status,
		).toBe(400);
		expect((await api.handle(get("/v1/cd/fanouts/%00"), signal())).status).toBe(
			400,
		);
	});

	it("a journal failure on a read is store-unavailable (503), not a crash", async () => {
		const { api, store } = setupApi();
		store.lose();
		const res = await api.handle(
			get(`/v1/cd/freight/${encodeURIComponent(FREIGHT_ID)}`),
			signal(),
		);
		expect(res.status).toBe(503);
		expect((await json(res)).reasons?.[0]).toMatchObject({
			code: "store-unavailable",
		});
	});

	it("emits request metrics through TelemetrySink", async () => {
		const { api, sink } = setupApi();
		await api.handle(get("/v1/cd/fanouts/fan-1"), signal());
		await new Promise((r) => setTimeout(r, 0));
		expect(
			sink.points.some(
				(p) =>
					p.name === CD_API_METRICS.requests &&
					p.attributes.route === "fanouts" &&
					p.attributes.status === 200,
			),
		).toBe(true);
		expect(sink.points.some((p) => p.name === CD_API_METRICS.requestMs)).toBe(
			true,
		);
	});
});

describe("CD read API — SSE /v1/cd/stream", () => {
	function frames(raw: string) {
		return raw
			.split("\n\n")
			.filter((b) => b.includes("data:"))
			.map((b) => {
				const id = /^id: (.*)$/m.exec(b)?.[1];
				const event = /^event: (.*)$/m.exec(b)?.[1];
				const data = /^data: (.*)$/m.exec(b)?.[1];
				return { id, event, data: data ? JSON.parse(data) : undefined };
			});
	}

	it("streams every cd-* journal fact (inventory, fan-out, failover, compliance) with positions as ids", async () => {
		const { api } = setupApi();
		const res = await api.handle(get("/v1/cd/stream"), signal());
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
		const f = frames(await text(res)).filter((x) => x.event !== "end");
		expect(f.map((x) => x.event)).toEqual([
			CD_EVENTS.FreightRecorded,
			CD_EVENTS.CampTainted,
			CD_EVENTS.FanoutProgressed,
			CD_EVENTS.FailoverProposed,
			CD_EVENTS.ComplianceObserved,
		]);
		expect(f.map((x) => x.id)).toEqual(["1", "2", "4", "5", "6"]);
		expect(f[2]?.data).toMatchObject({
			position: "4",
			streamId: "cd-fanout-fan-1",
			data: { big: "10" },
		});
	});

	it("resumes after Last-Event-ID: nothing skipped, nothing repeated", async () => {
		const { api, store } = setupApi();
		const res = await api.handle(
			get("/v1/cd/stream", { "last-event-id": "4" }),
			signal(),
		);
		const first = frames(await text(res)).filter((x) => x.event !== "end");
		expect(first.map((x) => x.id)).toEqual(["5", "6"]);
		store.push("cd-fanout-fan-1", CD_EVENTS.FanoutCompleted, {
			fanoutId: "fan-1",
		});
		const again = await api.handle(
			get("/v1/cd/stream", { "last-event-id": "6" }),
			signal(),
		);
		expect(
			frames(await text(again))
				.filter((x) => x.event !== "end")
				.map((x) => x.id),
		).toEqual(["7"]);
	});

	it("?after= works for clients that cannot set headers; the header wins when both are set", async () => {
		const { api } = setupApi();
		const q = frames(
			await text(await api.handle(get("/v1/cd/stream?after=5"), signal())),
		);
		expect(q.filter((x) => x.event !== "end").map((x) => x.id)).toEqual(["6"]);
		const both = frames(
			await text(
				await api.handle(
					get("/v1/cd/stream?after=1", { "last-event-id": "5" }),
					signal(),
				),
			),
		);
		expect(both.filter((x) => x.event !== "end").map((x) => x.id)).toEqual([
			"6",
		]);
	});

	it("filters by ?types=", async () => {
		const { api } = setupApi();
		const f = frames(
			await text(
				await api.handle(
					get(
						`/v1/cd/stream?types=${CD_EVENTS.FailoverProposed},${CD_EVENTS.CampTainted}`,
					),
					signal(),
				),
			),
		);
		expect(f.filter((x) => x.event !== "end").map((x) => x.event)).toEqual([
			CD_EVENTS.CampTainted,
			CD_EVENTS.FailoverProposed,
		]);
	});

	it("delivers facts appended while the stream is open, then ends at its long-poll bound", async () => {
		const { api, store } = setupApi({ streamMaxMs: 80 });
		const res = await api.handle(
			get("/v1/cd/stream", { "last-event-id": "6" }),
			signal(),
		);
		setTimeout(
			() =>
				store.push("cd-failover-fo-1", CD_EVENTS.FailoverStarted, {
					failoverId: "fo-1",
				}),
			20,
		);
		const raw = await text(res);
		const f = frames(raw);
		expect(f[0]).toMatchObject({ id: "7", event: CD_EVENTS.FailoverStarted });
		expect(f.at(-1)).toMatchObject({
			event: "end",
			data: { reason: "long-poll", lastEventId: "7" },
		});
		expect(raw).toContain(": heartbeat");
	});

	it("stops when the client disconnects", async () => {
		const { api } = setupApi({ streamMaxMs: 10_000 });
		const controller = new AbortController();
		const res = await api.handle(get("/v1/cd/stream"), controller.signal);
		setTimeout(() => controller.abort(), 30);
		const started = Date.now();
		await text(res);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("refuses a malformed Last-Event-ID", async () => {
		const { api } = setupApi();
		const res = await api.handle(
			get("/v1/cd/stream", { "last-event-id": "abc" }),
			signal(),
		);
		expect(res.status).toBe(400);
		expect((await json(res)).reasons?.[0]).toMatchObject({
			code: "last-event-id-invalid",
		});
	});

	it("a journal failure mid-stream ends with an error event carrying the reason", async () => {
		const { api, store } = setupApi({ streamMaxMs: 200 });
		const res = await api.handle(
			get("/v1/cd/stream", { "last-event-id": "6" }),
			signal(),
		);
		setTimeout(() => store.lose(), 15);
		const f = frames(await text(res));
		expect(f.at(-1)).toMatchObject({
			event: "error",
			data: { code: "store-unavailable" },
		});
	});
});
