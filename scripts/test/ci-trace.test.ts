import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	parseRunSummary,
	redact,
	secretValues,
	toOtlp,
} from "../ci/ci-trace.mts";

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
			parseRunSummary({
				execution: { startTime: 1, endTime: 2 },
				tasks: [
					{
						taskId: "a#b",
						environmentVariables: { configured: [`TOKEN=${SYNTHETIC}`] },
						command: `echo ${SYNTHETIC}`,
						execution: { startTime: 1, endTime: 2, exitCode: null },
					},
					{ command: "no task id" },
				],
				user: "someone",
			}),
		);
		assert.equal(
			slim,
			'{"execution":{"startTime":1,"endTime":2},"tasks":[{"taskId":"a#b","execution":{"startTime":1,"endTime":2,"exitCode":null}}]}',
		);
		assert.ok(!slim.includes(SYNTHETIC));
		assert.ok(!slim.includes("someone"));
	});

	it("skips a summary without execution timings instead of guessing them", () => {
		assert.equal(
			parseRunSummary({ execution: { startTime: 1 }, tasks: [] }),
			undefined,
		);
		assert.equal(
			parseRunSummary({ execution: { startTime: 1, endTime: 2 } }),
			undefined,
		);
		assert.equal(parseRunSummary([]), undefined);
	});

	it("imports only node builtins, so it runs on a job that skipped install", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../ci/ci-trace.mts", import.meta.url)),
			"utf8",
		);
		const specifiers = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map(
			(match) => match[1],
		);
		assert.ok(specifiers.length > 0);
		assert.deepEqual(
			specifiers.filter((specifier) => !specifier?.startsWith("node:")),
			[],
		);
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
