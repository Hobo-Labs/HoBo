import type { CloudEvent } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CI_INFRA_EVENT_TYPES,
	ciEventSinkFromEnv,
	cloudEventsHttpSink,
	createCiEventEmitter,
	toCiCloudEvent,
} from "../src/cloud-events.js";

const SOURCE = {
	tenant: "hobo-ci",
	streamId: "ci-worker/box-a/1a2b3c4d",
	actorId: "hobo-ci-worker",
};
const NOW = Date.parse("2026-11-10T03:54:56.923Z");

function emitter(
	overrides: Partial<Parameters<typeof createCiEventEmitter>[0]> = {},
) {
	const batches: (readonly CloudEvent[])[] = [];
	let next = 0;
	const created = createCiEventEmitter({
		source: SOURCE,
		sink: async (events) => {
			batches.push(events);
		},
		now: () => NOW,
		id: () => `id-${++next}`,
		flushIntervalMs: 3_600_000,
		...overrides,
	});
	return { ...created, batches, events: () => batches.flat() };
}

describe("toCiCloudEvent", () => {
	it("maps a named fact to a CloudEvents 1.0 event with the platform's extensions", () => {
		expect(
			toCiCloudEvent({
				name: "hobo_ci_orphan_run_force_cancel",
				fields: { repository: "Org/Repo", runId: 42738777301, status: 202 },
				source: SOURCE,
				seq: 7,
				id: "evt-1",
				time: "2026-11-10T02:18:05.000Z",
			}),
		).toEqual({
			specversion: "1.0",
			id: "evt-1",
			type: "ci.RunForceCancelled",
			source: "hobo://hobo-ci/ci-worker/box-a/1a2b3c4d",
			subject: "ci-worker/box-a/1a2b3c4d",
			time: "2026-11-10T02:18:05.000Z",
			datacontenttype: "application/json",
			data: { repository: "Org/Repo", runId: 42738777301, status: 202 },
			hobov: 1,
			hoboseq: 7,
			hoboactor: { kind: "service", id: "hobo-ci-worker" },
			hobostreamid: "ci-worker/box-a/1a2b3c4d",
			hobotenant: "hobo-ci",
			// Everything about one workflow run shares this.
			hobocorrelationid: "github-actions-run:42738777301",
		});
	});

	it("leaves ordinary log events alone", () => {
		expect(
			toCiCloudEvent({
				name: "hobo_ci_isolated_worker_jobs_polled",
				fields: {},
				source: SOURCE,
				seq: 0,
				id: "x",
				time: "2026-11-10T02:18:05.000Z",
			}),
		).toBeUndefined();
	});

	it("gives every fact a past-tense ci.* type", () => {
		const types = [...CI_INFRA_EVENT_TYPES.values()];
		expect(new Set(types).size).toBe(types.length);
		for (const type of types) expect(type).toMatch(/^ci\.[A-Z][A-Za-z]+$/);
		expect(CI_INFRA_EVENT_TYPES.get("hobo_ci_relay_init_failed")).toBe(
			"ci.RelayStartFailed",
		);
		// What a mesh node says about the jobs it took is delivered too.
		expect(CI_INFRA_EVENT_TYPES.get("hobo_ci_mesh_job_dropped")).toBe(
			"ci.MeshJobDropped",
		);
		expect(CI_INFRA_EVENT_TYPES.get("hobo_ci_mesh_reliability")).toBe(
			"ci.MeshReliabilityChanged",
		);
	});
});

describe("createCiEventEmitter", () => {
	it("is a no-op without a sink", async () => {
		const off = createCiEventEmitter({ source: SOURCE, sink: undefined });
		expect(off.enabled).toBe(false);
		off.emit("hobo_ci_container_oom", { runId: 1 });
		await off.close();
	});

	it("delivers named facts in order with a rising sequence and skips the rest", async () => {
		const { emit, close, events } = emitter();
		emit("hobo_ci_job_pickup", { runId: 9, jobId: 1, pickupMs: 1200 });
		emit("hobo_ci_isolated_worker_jobs_polled", { runs: 3 });
		emit("hobo_ci_container_oom", { runId: 9, jobName: "test" });
		await close();
		expect(
			events().map((event) => [event.type, event.hoboseq, event.id]),
		).toEqual([
			["ci.JobPickedUp", 0, "id-1"],
			["ci.ContainerOomKilled", 1, "id-2"],
		]);
		expect(events()[0]?.time).toBe("2026-11-10T03:54:56.923Z");
	});

	it("drops the oldest past the queue limit, never retries, and reports both", async () => {
		const problems: { failedDeliveries: number; dropped: number }[] = [];
		let calls = 0;
		const { emit, flush, close } = emitter({
			maxQueue: 2,
			sink: async () => {
				calls += 1;
				throw new Error("receiver down");
			},
			now: () => NOW,
			onProblem: (problem) => problems.push(problem),
		});
		for (let jobId = 1; jobId <= 3; jobId += 1)
			emit("hobo_ci_job_pickup", { jobId });
		await flush();
		await flush();
		expect(calls).toBe(1);
		expect(problems).toEqual([{ failedDeliveries: 1, dropped: 1 }]);
		await close();
	});
});

describe("CloudEvents HTTP binding", () => {
	it("posts a batch in structured mode with the configured headers", async () => {
		const requests: { url: string; init: RequestInit | undefined }[] = [];
		const send: typeof fetch = async (input, init) => {
			requests.push({ url: `${input}`, init });
			return new Response(null, { status: 202 });
		};
		const { sink, target } = ciEventSinkFromEnv(
			{
				HOBO_CI_EVENTS_URL: "https://user:pw@events.example/ingest?key=1",
				HOBO_CI_EVENTS_HEADERS: "authorization=Bearer%20abc",
			},
			send,
		);
		// Credentials and the query are for the request, not the startup log.
		expect(target).toBe("https://events.example/ingest");
		const { emit, close } = emitter({ sink });
		emit("hobo_ci_relay_init_failed", { stage: "application" });
		await close();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.headers).toEqual({
			authorization: "Bearer abc",
			"Content-Type": "application/cloudevents-batch+json",
		});
		const body = JSON.parse(`${requests[0]?.init?.body}`);
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({
			specversion: "1.0",
			type: "ci.RelayStartFailed",
			data: { stage: "application" },
		});
	});

	it("is off without a usable URL and fails the batch when the receiver refuses", async () => {
		expect(ciEventSinkFromEnv({}).sink).toBeUndefined();
		expect(
			ciEventSinkFromEnv({ HOBO_CI_EVENTS_URL: "file:///etc/passwd" }).sink,
		).toBeUndefined();
		const sink = cloudEventsHttpSink({
			url: "https://events.example/ingest",
			fetch: async () => new Response(null, { status: 500 }),
		});
		await expect(sink([])).rejects.toThrow("CloudEvents delivery failed (500)");
	});
});
