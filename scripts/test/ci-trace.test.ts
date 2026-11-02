import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redact, secretValues, slimSummary, toOtlp } from "../ci/ci-trace.mts";

const SYNTHETIC = "synthetic-ci-secret-9f8e7d6c5b4a";

describe("ci-trace", () => {
	it("builds an OTLP trace with a root span and one span per executed task", () => {
		const trace = JSON.stringify(
			toOtlp(
				[
					{
						execution: {
							command: "turbo run test",
							startTime: 1000,
							endTime: 5000,
							exitCode: 0,
						},
						tasks: [
							{
								taskId: "@hobo/ci#test",
								execution: { startTime: 1100, endTime: 4000, exitCode: 0 },
							},
							{ taskId: "@hobo/x#test" },
						],
					},
				],
				"pr-gate",
				"42-1",
			),
		);
		const parsed = JSON.parse(trace);
		const spans = parsed.resourceSpans[0].scopeSpans[0].spans;
		assert.equal(spans.length, 2);
		assert.equal(spans[1].parentSpanId, spans[0].spanId);
		assert.equal(spans[1].startTimeUnixNano, "1100000000");
		assert.equal(spans[0].traceId.length, 32);
	});

	it("drops environment variable lists, commands and identity from summaries", () => {
		const slim = JSON.stringify(
			slimSummary({
				execution: { startTime: 1, endTime: 2 },
				tasks: [
					{
						taskId: "a#b",
						// @ts-expect-error extra turbo fields are stripped by the schema
						environmentVariables: { configured: [`TOKEN=${SYNTHETIC}`] },
						command: `echo ${SYNTHETIC}`,
					},
				],
				user: "someone",
			}),
		);
		assert.ok(!slim.includes(SYNTHETIC));
		assert.ok(!slim.includes("someone"));
	});

	it("scrubs values of secret-named env vars and token shapes", () => {
		const secrets = secretValues({
			NPM_TOKEN: SYNTHETIC,
			HOBO_TURBO_CONCURRENCY: "1",
		});
		assert.deepEqual(secrets, [SYNTHETIC]);
		const out = redact(
			`a ${SYNTHETIC} b ghp_${"x".repeat(36)} npm_${"y".repeat(36)}`,
			secrets,
		);
		assert.ok(!out.includes(SYNTHETIC));
		assert.ok(!out.includes("ghp_"));
		assert.ok(!out.includes("npm_y"));
	});
});
