import { createHash, randomBytes } from "node:crypto";
import { appendFile, rename, stat } from "node:fs/promises";
import type { GithubTransport } from "./github.js";

export type TraceFields = Readonly<Record<string, string | number | boolean>>;

export type RelaySpan = Readonly<{
	traceId: string;
	spanId: string;
	parentSpanId: string;
	name: string;
	kind: "internal" | "client";
	startMs: number;
	endMs: number;
	attributes: TraceFields;
	error: boolean;
}>;

export type RelayTraceSink = (payload: string) => Promise<void>;

export type RelayTrace = Readonly<{
	enabled: boolean;
	span(input: {
		name: string;
		kind?: RelaySpan["kind"];
		startMs: number;
		endMs: number;
		attributes?: TraceFields;
		error?: boolean;
		runId?: number;
	}): void;
	event(name: string, fields?: TraceFields, atMs?: number): void;
	flush(): Promise<void>;
	close(): Promise<void>;
}>;

const hex = (text: string, bytes: number) =>
	createHash("sha256")
		.update(text)
		.digest("hex")
		.slice(0, bytes * 2);

export function runTraceId(runId: number): string {
	return hex(`github-actions-run:${runId}`, 16);
}

export type GithubRoute = Readonly<{
	route: string;
	repository: string;
	runId: number;
	jobId: number;
	runnerId: number;
}>;

const ID_AFTER = new Map([
	["runs", "{run_id}"],
	["jobs", "{job_id}"],
	["runners", "{runner_id}"],
	["installations", "{installation_id}"],
	["attempts", "{attempt}"],
	["variables", "{name}"],
	["secrets", "{name}"],
]);

export function githubRoute(path: string): GithubRoute {
	const segments = (path.split("?")[0] ?? "").split("/").filter(Boolean);
	let repository = "";
	let runId = 0;
	let jobId = 0;
	let runnerId = 0;
	const route = segments.map((segment, index) => {
		const previous = segments[index - 1] ?? "";
		const beforePrevious = segments[index - 2] ?? "";
		if (previous === "repos" && index === 1) return "{owner}";
		if (beforePrevious === "repos" && index === 2) {
			repository = `${previous}/${segment}`;
			return "{repo}";
		}
		const placeholder = ID_AFTER.get(previous);
		if (placeholder === undefined)
			return /^\d+$/.test(segment) ? "{id}" : segment;
		const id = /^\d+$/.test(segment) ? Number(segment) : 0;
		if (id === 0 && !["variables", "secrets"].includes(previous))
			return segment;
		if (previous === "runs") runId = id;
		if (previous === "jobs") jobId = id;
		if (previous === "runners") runnerId = id;
		return placeholder;
	});
	return { route: `/${route.join("/")}`, repository, runId, jobId, runnerId };
}

type OtlpValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean };

function otlpValue(value: string | number | boolean): OtlpValue {
	if (value === true || value === false) return { boolValue: value };
	if (Number.isSafeInteger(value)) return { intValue: `${value}` };
	if (Number.isFinite(value)) return { doubleValue: Number(value) };
	return { stringValue: `${value}`.slice(0, 1000) };
}

const nanos = (ms: number) => `${Math.max(0, Math.round(ms))}000000`;

export function toOtlpTraces(
	resource: TraceFields,
	spans: readonly RelaySpan[],
) {
	const attributes = (fields: TraceFields) =>
		Object.entries(fields).map(([key, value]) => ({
			key,
			value: otlpValue(value),
		}));
	return {
		resourceSpans: [
			{
				resource: { attributes: attributes(resource) },
				scopeSpans: [
					{
						scope: { name: "@hobo/ci-gh-actions/relay-trace", version: "1" },
						spans: spans.map((span) => {
							const body = {
								traceId: span.traceId,
								spanId: span.spanId,
								name: span.name.slice(0, 200),
								kind: span.kind === "client" ? 3 : 1,
								startTimeUnixNano: nanos(span.startMs),
								endTimeUnixNano: nanos(Math.max(span.startMs, span.endMs)),
								attributes: attributes(span.attributes),
								status: { code: span.error ? 2 : 0 },
							};
							return span.parentSpanId === ""
								? body
								: { ...body, parentSpanId: span.parentSpanId };
						}),
					},
				],
			},
		],
	};
}

const FAILED_EVENT = /_(?:failed|failure|error|oom|timeout)$/;

const PICKUP_STAGES = [
	["ci.job.queue", "jobCreatedAt", "admittedAt"],
	["ci.job.container_start", "admittedAt", "containerStartedAt"],
	["ci.job.runner_register", "containerStartedAt", "runnerRegisteredAt"],
] as const;

const DISABLED: RelayTrace = {
	enabled: false,
	span() {},
	event() {},
	async flush() {},
	async close() {},
};

export function createRelayTrace(options: {
	sink: RelayTraceSink | undefined;
	resource: TraceFields;
	now?: () => number;
	spanId?: () => string;
	flushIntervalMs?: number;
	maxQueue?: number;
	batchSize?: number;
	onProblem?: (problem: { failedExports: number; dropped: number }) => void;
}): RelayTrace {
	if (!options.sink) return DISABLED;
	const sink: RelayTraceSink = options.sink;
	const now = options.now ?? Date.now;
	const spanId = options.spanId ?? (() => randomBytes(8).toString("hex"));
	const maxQueue = options.maxQueue ?? 4096;
	const batchSize = options.batchSize ?? 512;
	const processTraceId = randomBytes(16).toString("hex");
	const queue: RelaySpan[] = [];
	let dropped = 0;
	let failedExports = 0;
	let reportedAt = 0;
	let flushing: Promise<void> | undefined;

	function report(): void {
		if (dropped + failedExports === 0 || now() - reportedAt < 60_000) return;
		reportedAt = now();
		options.onProblem?.({ failedExports, dropped });
		dropped = 0;
		failedExports = 0;
	}

	function push(span: RelaySpan): void {
		queue.push(span);
		if (queue.length > maxQueue)
			dropped += queue.splice(0, queue.length - maxQueue).length;
	}

	const traceOf = (runId: number | undefined) =>
		runId !== undefined && Number.isSafeInteger(runId) && runId > 0
			? runTraceId(runId)
			: processTraceId;

	async function drain(): Promise<void> {
		while (queue.length > 0) {
			const batch = queue.splice(0, batchSize);
			try {
				await sink(JSON.stringify(toOtlpTraces(options.resource, batch)));
			} catch {
				failedExports += 1;
			}
		}
		report();
	}

	function flush(): Promise<void> {
		flushing ??= drain().finally(() => {
			flushing = undefined;
		});
		return flushing;
	}

	const timer = setInterval(() => {
		void flush();
	}, options.flushIntervalMs ?? 5000);
	timer.unref();

	return {
		enabled: true,
		span(input) {
			push({
				traceId: traceOf(input.runId),
				spanId: spanId(),
				parentSpanId: "",
				name: input.name,
				kind: input.kind ?? "internal",
				startMs: input.startMs,
				endMs: input.endMs,
				attributes: input.attributes ?? {},
				error: input.error ?? false,
			});
		},
		event(name, fields = {}, atMs = now()) {
			const runId = Number.isSafeInteger(fields.runId)
				? Number(fields.runId)
				: undefined;
			const traceId = traceOf(runId);
			const attributes = Object.fromEntries(
				Object.entries(fields).map(([key, value]) => [`hobo.ci.${key}`, value]),
			);
			const id = spanId();
			const stages =
				name === "hobo_ci_job_pickup"
					? PICKUP_STAGES.flatMap(([stage, from, to]) => {
							const startMs = Date.parse(`${fields[from] ?? ""}`);
							const endMs = Date.parse(`${fields[to] ?? ""}`);
							return Number.isFinite(startMs) && Number.isFinite(endMs)
								? [{ stage, startMs, endMs }]
								: [];
						})
					: [];
			const startMs = Math.min(atMs, ...stages.map((stage) => stage.startMs));
			push({
				traceId,
				spanId: id,
				parentSpanId: "",
				name,
				kind: "internal",
				startMs,
				endMs: Math.max(atMs, ...stages.map((stage) => stage.endMs)),
				attributes,
				error: FAILED_EVENT.test(name),
			});
			for (const stage of stages)
				push({
					traceId,
					spanId: spanId(),
					parentSpanId: id,
					name: stage.stage,
					kind: "internal",
					startMs: stage.startMs,
					endMs: stage.endMs,
					attributes: {},
					error: false,
				});
		},
		flush,
		async close() {
			clearInterval(timer);
			await flush();
		},
	};
}

export function traceGithubTransport<T extends GithubTransport>(
	github: T,
	trace: RelayTrace,
	now: () => number = Date.now,
): T {
	if (!trace.enabled) return github;
	const request: GithubTransport["request"] = async (
		installationId,
		path,
		method = "GET",
		body,
		ifNoneMatch,
	) => {
		const startMs = now();
		const target = githubRoute(path);
		const record = (status: number) => {
			if (method === "GET" && status < 400 && status !== 0) return;
			trace.span({
				name: `${method} ${target.route}`,
				kind: "client",
				startMs,
				endMs: now(),
				runId: target.runId,
				error: status === 0 || status >= 400,
				attributes: {
					"http.request.method": method,
					"url.template": target.route,
					"http.response.status_code": status,
					"server.address": "api.github.com",
					"github.installation_id": installationId,
					"hobo.ci.repository": target.repository,
					"hobo.ci.run_id": target.runId,
					"hobo.ci.job_id": target.jobId,
					"hobo.ci.runner_id": target.runnerId,
				},
			});
		};
		try {
			const response = await github.request(
				installationId,
				path,
				method,
				body,
				ifNoneMatch,
			);
			record(response.status);
			return response;
		} catch (error) {
			record(0);
			throw error;
		}
	};
	return { ...github, request };
}

export function otlpHttpSink(options: {
	url: string;
	headers?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}): RelayTraceSink {
	const send = options.fetch ?? fetch;
	return async (payload) => {
		const response = await send(options.url, {
			method: "POST",
			headers: { ...options.headers, "Content-Type": "application/json" },
			body: payload,
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		});
		await response.body?.cancel();
		if (!response.ok)
			throw new Error(`OTLP export failed (${response.status})`);
	};
}

export function otlpFileSink(options: {
	path: string;
	maxBytes?: number;
}): RelayTraceSink {
	const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
	return async (payload) => {
		const size = await stat(options.path).then(
			(entry) => entry.size,
			() => 0,
		);
		if (size > maxBytes) await rename(options.path, `${options.path}.1`);
		await appendFile(options.path, `${payload}\n`, { mode: 0o600 });
	};
}

function otlpHeaders(text: string | undefined) {
	const headers = new Map<string, string>();
	for (const pair of (text ?? "").split(",")) {
		const at = pair.indexOf("=");
		if (at <= 0) continue;
		const value = pair.slice(at + 1).trim();
		try {
			headers.set(pair.slice(0, at).trim(), decodeURIComponent(value));
		} catch {
			headers.set(pair.slice(0, at).trim(), value);
		}
	}
	return Object.fromEntries(headers);
}

export type RelayTraceTargets = Readonly<{
	endpoint: string;
	file: string;
}>;

export function relayTraceSinkFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	send?: typeof fetch,
) {
	const none = { sink: undefined, targets: { endpoint: "", file: "" } };
	if (env.OTEL_SDK_DISABLED?.toLowerCase() === "true") return none;
	const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	const raw =
		env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
		(base ? `${base.replace(/\/+$/, "")}/v1/traces` : "");
	let url: URL | undefined;
	try {
		url = raw ? new URL(raw) : undefined;
	} catch {
		url = undefined;
	}
	if (url && !["http:", "https:"].includes(url.protocol)) url = undefined;
	const file = env.HOBO_CI_TRACE_FILE?.trim() ?? "";
	const sinks: RelayTraceSink[] = [];
	if (url)
		sinks.push(
			otlpHttpSink({
				url: url.href,
				headers: otlpHeaders(
					env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
						env.OTEL_EXPORTER_OTLP_HEADERS,
				),
				fetch: send ?? fetch,
			}),
		);
	if (file) sinks.push(otlpFileSink({ path: file }));
	if (sinks.length === 0) return none;
	const sink: RelayTraceSink = async (payload) => {
		const results = await Promise.allSettled(
			sinks.map((each) => each(payload)),
		);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("trace export failed");
	};
	return {
		sink,
		targets: { endpoint: url ? `${url.origin}${url.pathname}` : "", file },
	};
}
