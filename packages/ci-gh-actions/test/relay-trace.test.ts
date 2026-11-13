import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTraceId as jobRunTraceId } from "../../../scripts/ci/ci-trace.mts";
import type { GithubTransport } from "../src/github.js";
import { createOrphanJobTracker } from "../src/isolated-worker/orphan-jobs.js";
import {
	createRelayTrace,
	githubRoute,
	otlpFileSink,
	type RelayTraceSink,
	relayTraceSinkFromEnv,
	runTraceId,
	traceGithubTransport,
} from "../src/relay-trace.js";

type ExportedSpan = Readonly<{
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: readonly {
		key: string;
		value: {
			stringValue?: string;
			intValue?: string;
			doubleValue?: number;
			boolValue?: boolean;
		};
	}[];
	status: { code: number };
}>;

function collector() {
	const payloads: string[] = [];
	const sink: RelayTraceSink = async (payload) => {
		payloads.push(payload);
	};
	const spans = (): ExportedSpan[] =>
		payloads.flatMap(
			(payload) => JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans,
		);
	return { sink, payloads, spans };
}

const attribute = (span: ExportedSpan | undefined, key: string) => {
	const value = span?.attributes.find((entry) => entry.key === key)?.value;
	return (
		value?.stringValue ??
		value?.intValue ??
		value?.doubleValue ??
		value?.boolValue
	);
};

function tracer(now = () => 1_000) {
	const out = collector();
	let next = 0;
	const trace = createRelayTrace({
		sink: out.sink,
		resource: { "service.name": "hobo-ci-worker" },
		now,
		spanId: () => (++next).toString(16).padStart(16, "0"),
		flushIntervalMs: 3_600_000,
	});
	return { trace, ...out };
}

describe("githubRoute", () => {
	it("replaces every identifier and keeps the ids it carried", () => {
		expect(
			githubRoute(
				"/repos/Hobo-Labs/HoBo/actions/runs/42738777301/force-cancel",
			),
		).toEqual({
			route: "/repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel",
			repository: "Hobo-Labs/HoBo",
			runId: 42738777301,
			jobId: 0,
			runnerId: 0,
		});
		expect(githubRoute("/repos/o/r/actions/runners/5462").runnerId).toBe(5462);
		expect(githubRoute("/repos/o/r/actions/jobs/77").route).toBe(
			"/repos/{owner}/{repo}/actions/jobs/{job_id}",
		);
		expect(
			githubRoute("/repos/o/r/actions/runs/9/attempts/2/jobs?per_page=100"),
		).toMatchObject({
			route:
				"/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs",
			runId: 9,
		});
	});

	it("keeps verbs, drops the query and hides variable names", () => {
		expect(
			githubRoute("/repos/o/r/actions/runners/generate-jitconfig").route,
		).toBe("/repos/{owner}/{repo}/actions/runners/generate-jitconfig");
		expect(
			githubRoute("/repos/o/r/actions/runners/registration-token?token=s3cret")
				.route,
		).toBe("/repos/{owner}/{repo}/actions/runners/registration-token");
		expect(
			githubRoute("/repos/o/r/actions/variables/EXAMPLE_VARIABLE").route,
		).toBe("/repos/{owner}/{repo}/actions/variables/{name}");
		expect(githubRoute("/app/installations/12/access_tokens").route).toBe(
			"/app/installations/{installation_id}/access_tokens",
		);
	});
});

describe("run trace id", () => {
	it("is the id the job's own Turbo trace uses", () => {
		expect(runTraceId(42738777301)).toBe(jobRunTraceId("42738777301"));
		expect(runTraceId(42738777301)).toMatch(/^[0-9a-f]{32}$/);
		expect(runTraceId(1)).not.toBe(runTraceId(2));
	});
});

describe("createRelayTrace", () => {
	it("does nothing without a sink", async () => {
		const trace = createRelayTrace({ sink: undefined, resource: {} });
		expect(trace.enabled).toBe(false);
		trace.event("hobo_ci_job_pickup", { runId: 1 });
		await trace.close();
	});

	it("puts an event that names a run in that run's trace", async () => {
		const { trace, spans, payloads } = tracer();
		trace.event("hobo_ci_orphan_run_force_cancel", {
			repository: "Org/Repo",
			runId: 900,
			jobId: 100,
			status: 202,
		});
		trace.event("hobo_ci_host_health", { level: "critical" });
		await trace.close();
		const [cancel, health] = spans();
		expect(cancel?.traceId).toBe(runTraceId(900));
		expect(cancel?.name).toBe("hobo_ci_orphan_run_force_cancel");
		expect(attribute(cancel, "hobo.ci.runId")).toBe("900");
		expect(attribute(cancel, "hobo.ci.repository")).toBe("Org/Repo");
		expect(cancel?.startTimeUnixNano).toBe("1000000000");
		// No run: grouped under the process instead.
		expect(health?.traceId).not.toBe(cancel?.traceId);
		expect(health?.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(JSON.parse(payloads[0] ?? "").resourceSpans[0].resource).toEqual({
			attributes: [
				{ key: "service.name", value: { stringValue: "hobo-ci-worker" } },
			],
		});
	});

	it("marks failure events as errors", async () => {
		const { trace, spans } = tracer();
		trace.event("hobo_ci_launch_failed", { runId: 5 });
		trace.event("hobo_ci_container_oom", { runId: 5 });
		trace.event("hobo_ci_job_pickup", { runId: 5 });
		await trace.close();
		expect(spans().map((span) => span.status.code)).toEqual([2, 2, 0]);
	});

	it("turns a job pickup into the waits it measured", async () => {
		const { trace, spans } = tracer(() => Date.parse("2026-11-10T02:14:07Z"));
		trace.event("hobo_ci_job_pickup", {
			runId: 42738777301,
			jobId: 129574622003,
			jobCreatedAt: "2026-11-10T01:52:39Z",
			admittedAt: "2026-11-10T02:13:50Z",
			containerStartedAt: "2026-11-10T02:14:01Z",
			runnerRegisteredAt: "2026-11-10T02:14:06Z",
			pickupMs: 1_287_000,
		});
		await trace.close();
		const [pickup, ...stages] = spans();
		const seconds = (span: ExportedSpan | undefined) =>
			(Number(span?.endTimeUnixNano) - Number(span?.startTimeUnixNano)) / 1e9;
		// The parent spans the whole wait, not just the instant it was logged.
		expect(seconds(pickup)).toBe(1288);
		expect(
			stages.map((span) => [span.name, seconds(span), span.parentSpanId]),
		).toEqual([
			["ci.job.queue", 1271, pickup?.spanId],
			["ci.job.container_start", 11, pickup?.spanId],
			["ci.job.runner_register", 5, pickup?.spanId],
		]);
		expect(new Set(spans().map((span) => span.traceId))).toEqual(
			new Set([runTraceId(42738777301)]),
		);
	});

	it("drops the oldest spans past the queue limit and reports it", async () => {
		const out = collector();
		const problems: { failedExports: number; dropped: number }[] = [];
		let clock = 100_000;
		const trace = createRelayTrace({
			sink: out.sink,
			resource: {},
			now: () => clock,
			maxQueue: 2,
			flushIntervalMs: 3_600_000,
			onProblem: (problem) => problems.push(problem),
		});
		for (const name of ["a", "b", "c"]) trace.event(name);
		clock += 1;
		await trace.flush();
		expect(out.spans().map((span) => span.name)).toEqual(["b", "c"]);
		expect(problems).toEqual([{ failedExports: 0, dropped: 1 }]);
		await trace.close();
	});

	it("does not retry or grow when the endpoint is down", async () => {
		let calls = 0;
		const problems: { failedExports: number; dropped: number }[] = [];
		const trace = createRelayTrace({
			sink: async () => {
				calls += 1;
				throw new Error("connection refused");
			},
			resource: {},
			now: () => 100_000,
			flushIntervalMs: 3_600_000,
			onProblem: (problem) => problems.push(problem),
		});
		trace.event("a");
		await trace.flush();
		await trace.flush();
		expect(calls).toBe(1);
		expect(problems).toEqual([{ failedExports: 1, dropped: 0 }]);
		await trace.close();
	});
});

describe("traceGithubTransport", () => {
	const transport = (
		respond: (path: string, method: string) => Response,
	): GithubTransport => ({
		request: async (_installation, path, method = "GET") =>
			respond(path, method),
	});

	it("returns the transport untouched when tracing is off", () => {
		const github = transport(() => new Response(null, { status: 204 }));
		expect(
			traceGithubTransport(
				github,
				createRelayTrace({ sink: undefined, resource: {} }),
			),
		).toBe(github);
	});

	it("records writes and refused reads, not successful reads", async () => {
		const { trace, spans } = tracer();
		const github = traceGithubTransport(
			transport((path, method) =>
				method === "GET" && path.endsWith("/jobs/1")
					? new Response("{}", { status: 200 })
					: method === "GET"
						? new Response("{}", { status: 404 })
						: new Response(null, { status: 204 }),
			),
			trace,
			() => 2_000,
		);
		await github.request(7, "/repos/Org/Repo/actions/jobs/1");
		await github.request(7, "/repos/Org/Repo/actions/jobs/2");
		await github.request(7, "/repos/Org/Repo/actions/runners/42", "DELETE");
		await trace.close();
		expect(
			spans().map((span) => [span.name, span.kind, span.status.code]),
		).toEqual([
			["GET /repos/{owner}/{repo}/actions/jobs/{job_id}", 3, 2],
			["DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}", 3, 0],
		]);
		const remove = spans()[1];
		expect(attribute(remove, "http.response.status_code")).toBe("204");
		expect(attribute(remove, "hobo.ci.runner_id")).toBe("42");
		expect(attribute(remove, "hobo.ci.repository")).toBe("Org/Repo");
		expect(attribute(remove, "github.installation_id")).toBe("7");
	});

	it("never records a body, a query string or a token", async () => {
		const { trace, payloads } = tracer();
		const github = traceGithubTransport(
			transport(
				() =>
					new Response('{"encoded_jit_config":"jit-s3cret"}', { status: 201 }),
			),
			trace,
		);
		await github.request(
			7,
			"/repos/Org/Repo/actions/runners/generate-jitconfig?token=query-s3cret",
			"POST",
			'{"name":"runner","labels":["hobo"],"secret":"body-s3cret"}',
		);
		await trace.close();
		expect(payloads.join("")).not.toMatch(/s3cret/);
		expect(payloads.join("")).toContain("generate-jitconfig");
	});

	it("records a request that never got an answer and rethrows", async () => {
		const { trace, spans } = tracer();
		const github = traceGithubTransport(
			{
				request: async () => {
					throw new Error("socket hang up");
				},
			},
			trace,
		);
		await expect(
			github.request(7, "/repos/Org/Repo/actions/runs/9/jobs"),
		).rejects.toThrow("socket hang up");
		await trace.close();
		expect(spans()).toHaveLength(1);
		expect(spans()[0]?.status.code).toBe(2);
		expect(spans()[0]?.traceId).toBe(runTraceId(9));
	});

	it("shows a force-cancel by the orphan-job path in the run's trace", async () => {
		const { trace, spans } = tracer();
		let clock = 0;
		const github = traceGithubTransport(
			transport((path, method) => {
				if (path.endsWith("/actions/jobs/100"))
					return Response.json({
						id: 100,
						run_id: 900,
						status: "in_progress",
						labels: ["hobo"],
						runner_name: "hobo-runner",
					});
				if (method === "DELETE") return new Response(null, { status: 204 });
				if (path.endsWith("/force-cancel"))
					return new Response(null, { status: 202 });
				return Response.json({
					id: 900,
					run_attempt: 1,
					event: "pull_request",
					head_sha: "abc",
					head_branch: "feature",
					path: ".github/workflows/hobo-ci.yml",
					display_title: "t",
					status: "in_progress",
					conclusion: null,
					run_started_at: null,
					updated_at: "2026-11-10T02:18:05Z",
					actor: { id: 1 },
					repository: { id: 2, private: false },
					head_repository: { id: 2 },
				});
			}),
			trace,
		);
		const orphans = createOrphanJobTracker({
			github,
			now: () => clock,
			log: (event, fields) => trace.event(event, fields),
		});
		orphans.enqueue({
			repository: "Org/Repo",
			installationId: 10,
			runId: 900,
			jobId: 100,
			runnerId: 42,
			runnerName: "hobo-runner",
			detectedAtMs: 0,
		});
		clock = 61_000;
		await orphans.reconcile();
		await trace.close();
		const run = spans().filter((span) => span.traceId === runTraceId(900));
		expect(run.map((span) => span.name)).toEqual(
			expect.arrayContaining([
				"hobo_ci_orphan_job_detected",
				"hobo_ci_orphan_job_confirmed",
				"hobo_ci_orphan_run_force_cancel",
				"POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel",
			]),
		);
		// The runner delete names no run: it is in the trace by its runner id.
		expect(
			spans().some(
				(span) =>
					span.name ===
						"DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}" &&
					attribute(span, "hobo.ci.runner_id") === "42",
			),
		).toBe(true);
	});
});

describe("sinks", () => {
	it("appends one export per line and rotates past the size limit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "relay-trace-"));
		try {
			const path = join(dir, "spans.jsonl");
			const sink = otlpFileSink({ path, maxBytes: 10 });
			await sink('{"a":1}');
			await sink('{"b":2}');
			expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
			await sink('{"c":3}');
			expect(readFileSync(path, "utf8")).toBe('{"c":3}\n');
			expect(readFileSync(`${path}.1`, "utf8")).toBe('{"a":1}\n{"b":2}\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is off with nothing configured or OTEL_SDK_DISABLED", () => {
		expect(relayTraceSinkFromEnv({}).sink).toBeUndefined();
		expect(
			relayTraceSinkFromEnv({
				OTEL_SDK_DISABLED: "true",
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
			}).sink,
		).toBeUndefined();
		expect(
			relayTraceSinkFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "file:///etc" })
				.sink,
		).toBeUndefined();
	});

	it("posts OTLP/JSON to the endpoint with the configured headers", async () => {
		const requests: { url: string; init: RequestInit | undefined }[] = [];
		const send: typeof fetch = async (input, init) => {
			requests.push({ url: `${input}`, init });
			return new Response(null, { status: 200 });
		};
		const base = relayTraceSinkFromEnv(
			{
				OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example/base/",
				OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc,x-team=ci",
			},
			send,
		);
		expect(base.targets).toEqual({
			endpoint: "https://otel.example/base/v1/traces",
			file: "",
		});
		await base.sink?.('{"resourceSpans":[]}');
		expect(requests[0]?.url).toBe("https://otel.example/base/v1/traces");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.headers).toEqual({
			authorization: "Bearer abc",
			"x-team": "ci",
			"Content-Type": "application/json",
		});
		// The traces-specific endpoint is used as given.
		const specific = relayTraceSinkFromEnv(
			{
				OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
					"https://user:pw@traces.example/ingest?key=1",
			},
			send,
		);
		// Credentials and the query are for the request, not for the log line.
		expect(specific.targets.endpoint).toBe("https://traces.example/ingest");
	});

	it("fails the export when the endpoint refuses, and still writes the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "relay-trace-"));
		try {
			const path = join(dir, "spans.jsonl");
			writeFileSync(path, "");
			const { sink } = relayTraceSinkFromEnv(
				{
					OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
					HOBO_CI_TRACE_FILE: path,
				},
				async () => new Response(null, { status: 503 }),
			);
			await expect(sink?.('{"x":1}')).rejects.toThrow("trace export failed");
			expect(readFileSync(path, "utf8")).toBe('{"x":1}\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
