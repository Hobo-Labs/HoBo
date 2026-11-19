import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { HttpTransport } from "@hobo/core";
import { test } from "vitest";
import {
	createOtlpSpanExporter,
	createTrajectoryCapture,
	OtlpPartialSuccessError,
} from "../src/index.js";

function captureWith(exporter: ReturnType<typeof createOtlpSpanExporter>) {
	let sequence = 0;
	let time = 0;
	return createTrajectoryCapture({
		exporter,
		idGenerator: {
			traceId: () => "1".repeat(32),
			spanId: () => (++sequence).toString(16).padStart(16, "0"),
		},
		now: () => new Date(Date.UTC(2026, 0, 1) + time++ * 1000).toISOString(),
	});
}

test("exports captured parent and child spans to an OTLP HTTP collector", async () => {
	const requests: Array<{
		url: string | undefined;
		contentType: string | undefined;
		body: string;
	}> = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({
			url: request.url,
			contentType: request.headers["content-type"],
			body,
		});
		response.writeHead(200, { "content-type": "application/json" });
		response.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && address instanceof Object);
		const exporter = createOtlpSpanExporter({
			endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
			resourceAttributes: { "service.name": "trajectory-test" },
		});
		const capture = captureWith(exporter);
		const root = capture.startSpan("agent", {
			kind: "AGENT",
			input: { question: "hello" },
		});
		const child = capture.startSpan("tool", { kind: "TOOL", parent: root });
		child.end({ status: "ERROR", statusMessage: "not found" });
		root.end({ output: { answer: "world" } });
		await exporter.shutdown();

		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.url, "/v1/traces");
		assert.equal(requests[0]?.contentType, "application/json");
		const document = JSON.parse(requests[0]?.body ?? "");
		const resource = document.resourceSpans[0];
		assert.deepEqual(resource.resource.attributes, [
			{ key: "service.name", value: { stringValue: "trajectory-test" } },
		]);
		assert.equal(resource.scopeSpans[0].scope.name, "@hobo/training-pipeline");
		const [tool, agent] = resource.scopeSpans[0].spans;
		assert.equal(tool.traceId, "1".repeat(32));
		assert.equal(tool.spanId, child.spanId);
		assert.equal(tool.parentSpanId, root.spanId);
		assert.equal(
			tool.startTimeUnixNano,
			(BigInt(Date.UTC(2026, 0, 1) + 1000) * 1_000_000n).toString(),
		);
		assert.deepEqual(tool.status, { code: 2, message: "not found" });
		assert.equal(agent.parentSpanId, undefined);
		assert.deepEqual(agent.status, { code: 1 });
		assert.ok(
			agent.attributes.some(
				(attribute: { key: string; value: { stringValue: string } }) =>
					attribute.key === "input.value" &&
					attribute.value.stringValue === '{"question":"hello"}',
			),
		);
		assert.ok(
			agent.attributes.some(
				(attribute: { key: string; value: { stringValue: string } }) =>
					attribute.key === "output.value" &&
					attribute.value.stringValue === '{"answer":"world"}',
			),
		);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("retains failed batches in order and retries them during flush", async () => {
	const bodies: string[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		bodies.push(body);
		response.writeHead(bodies.length === 1 ? 503 : 200);
		response.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && address instanceof Object);
		const exporter = createOtlpSpanExporter({
			endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
			maxBatchSize: 1,
		});
		const capture = captureWith(exporter);
		capture.startSpan("first", { kind: "TOOL" }).end();
		capture.startSpan("second", { kind: "TOOL" }).end();
		await assert.rejects(exporter.flush(), /HTTP 503/);
		await exporter.flush();
		assert.equal(bodies.length, 3);
		assert.equal(bodies[0], bodies[1]);
		assert.equal(
			JSON.parse(bodies[1] ?? "").resourceSpans[0].scopeSpans[0].spans[0].name,
			"first",
		);
		assert.equal(
			JSON.parse(bodies[2] ?? "").resourceSpans[0].scopeSpans[0].spans[0].name,
			"second",
		);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("reports collector partial success without resending an accepted batch", async () => {
	const bodies: string[] = [];
	const http: HttpTransport = async (request) => {
		bodies.push(request.body ?? "");
		return {
			status: 200,
			headers: {},
			body:
				bodies.length === 1
					? '{"partialSuccess":{"rejectedSpans":"1","errorMessage":"invalid span"}}'
					: "{}",
		};
	};
	const exporter = createOtlpSpanExporter({
		endpoint: "http://collector.test/v1/traces",
		http,
		maxBatchSize: 1,
	});
	const capture = captureWith(exporter);
	capture.startSpan("first", { kind: "TOOL" }).end();
	capture.startSpan("second", { kind: "TOOL" }).end();
	await assert.rejects(
		exporter.flush(),
		(error) =>
			error instanceof OtlpPartialSuccessError &&
			error.rejectedSpans === 1 &&
			error.message.includes("invalid span"),
	);
	await exporter.flush();
	assert.equal(bodies.length, 2);
	assert.equal(
		JSON.parse(bodies[1] ?? "").resourceSpans[0].scopeSpans[0].spans[0].name,
		"second",
	);
});

test("bounds the queue including in-flight spans and serializes concurrent flushes", async () => {
	let release = () => {};
	const firstRequest = new Promise<void>((resolve) => {
		release = resolve;
	});
	const names: string[] = [];
	const http: HttpTransport = async (request) => {
		names.push(
			JSON.parse(request.body ?? "").resourceSpans[0].scopeSpans[0].spans[0]
				.name,
		);
		if (names.length === 1) await firstRequest;
		return { status: 200, headers: {}, body: "{}" };
	};
	const exporter = createOtlpSpanExporter({
		endpoint: "http://collector.test/v1/traces",
		http,
		maxBatchSize: 1,
		maxBufferedSpans: 2,
	});
	const capture = captureWith(exporter);
	capture.startSpan("first", { kind: "TOOL" }).end();
	const firstFlush = exporter.flush();
	const secondFlush = exporter.flush();
	capture.startSpan("second", { kind: "TOOL" }).end();
	const third = capture.startSpan("third", { kind: "TOOL" });
	assert.throws(() => third.end(), /buffer is full/);
	assert.equal(capture.openSpanCount(), 1);
	release();
	await Promise.all([firstFlush, secondFlush]);
	third.end();
	await exporter.shutdown();
	assert.deepEqual(names, ["first", "second", "third"]);
	assert.throws(
		() => capture.startSpan("late", { kind: "TOOL" }).end(),
		/shut down/,
	);
});

test("permits retrying a failed shutdown flush", async () => {
	let attempts = 0;
	const http: HttpTransport = async () => ({
		status: ++attempts === 1 ? 503 : 200,
		headers: {},
		body: "{}",
	});
	const exporter = createOtlpSpanExporter({
		endpoint: "http://collector.test/v1/traces",
		http,
	});
	captureWith(exporter).startSpan("run", { kind: "AGENT" }).end();
	await assert.rejects(exporter.shutdown(), /HTTP 503/);
	await exporter.flush();
	assert.equal(attempts, 2);
});

test("retains a batch when a response cannot be decoded", async () => {
	let attempts = 0;
	const http: HttpTransport = async () => ({
		status: 200,
		headers: {},
		body: ++attempts === 1 ? "not-json" : "{}",
	});
	const exporter = createOtlpSpanExporter({
		endpoint: "http://collector.test/v1/traces",
		http,
	});
	captureWith(exporter).startSpan("run", { kind: "AGENT" }).end();
	await assert.rejects(exporter.flush());
	await exporter.flush();
	assert.equal(attempts, 2);
});
