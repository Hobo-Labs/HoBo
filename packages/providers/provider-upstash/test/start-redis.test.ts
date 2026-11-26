import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { isProviderError, type UpstashProviderError } from "../src/errors.js";
import {
	describeStartRedisDatabase,
	EXPECTED_FIELD_LABELS,
	MAX_PAYLOAD_LINES,
	parseStartRedisMetrics,
	parseStartRedisResponse,
	UPSTASH_START_REDIS_CONTRACT,
	UPSTASH_START_REDIS_NATIVE_CONTRACT,
} from "../src/start-redis.js";
import {
	DUPLICATE_TOKEN_PAYLOAD,
	EXTRA_FIELD_PAYLOAD,
	FAKE_CONSOLE_URL,
	FAKE_DATABASE_ID,
	FAKE_METRICS_URL,
	FAKE_REST_HOST,
	FAKE_REST_TOKEN,
	FIXTURE_EXPIRES_AT_MS,
	MISSING_TOKEN_PAYLOAD,
	OVERSIZED_PAYLOAD,
	VALID_PAYLOAD,
} from "./fixtures/index.js";

function expectContractChange(body: string): UpstashProviderError {
	try {
		parseStartRedisResponse(body);
	} catch (error) {
		assert.ok(isProviderError(error), "expected a typed provider error");
		assert.equal(error.code, "PROVIDER_CONTRACT_CHANGED");
		return error;
	}
	throw new Error("expected the parser to refuse this payload");
}

describe("parseStartRedisResponse", () => {
	it("parses every field of the captured response shape", () => {
		const parsed = parseStartRedisResponse(VALID_PAYLOAD);

		assert.equal(parsed.contract, UPSTASH_START_REDIS_CONTRACT);
		assert.equal(parsed.databaseId, FAKE_DATABASE_ID);
		assert.equal(parsed.restEndpointHost, FAKE_REST_HOST);
		assert.equal(parsed.restEndpointUrl, `https://${FAKE_REST_HOST}`);
		assert.equal(parsed.token, FAKE_REST_TOKEN);
		assert.equal(parsed.consoleUrl, FAKE_CONSOLE_URL);
		// The trailing "(JSON: …)" note is discarded, not parsed as part of
		// the URL.
		assert.equal(parsed.metricsUrl, FAKE_METRICS_URL);
	});

	it("records the provider's own expiry rather than computing one", () => {
		const parsed = parseStartRedisResponse(VALID_PAYLOAD);

		assert.equal(parsed.expiresOn, "2026-08-11");
		assert.equal(parsed.statedTtlDays, 3);
		assert.equal(parsed.expiresRaw, "2026-08-11 (3 days from creation).");
		// Start of the stated day: the provider names a date, not an instant,
		// and treating a lease as over early is the cheap mistake.
		assert.equal(parsed.expiresAtMs, FIXTURE_EXPIRES_AT_MS);
		assert.equal(parsed.expiresAtIso, "2026-08-11T00:00:00.000Z");
	});

	it("refuses a document that does not open with the expected heading", () => {
		const error = expectContractChange(
			VALID_PAYLOAD.replace("# Your Redis is ready", "# Oops"),
		);
		assert.match(error.message, /does not open with/u);
	});

	it("refuses a payload whose token is missing", () => {
		const error = expectContractChange(MISSING_TOKEN_PAYLOAD);
		assert.match(error.message, /missing the Token field/u);
	});

	it("refuses an unreviewed field rather than ignoring it", () => {
		// The fixture adds `**Read Only Token:**`. Skipping it would mean a
		// credential this driver never deposits and never redacts.
		const error = expectContractChange(EXTRA_FIELD_PAYLOAD);
		assert.match(error.message, /unreviewed "Read Only Token" field/u);
	});

	it("refuses a repeated field instead of picking one", () => {
		const error = expectContractChange(DUPLICATE_TOKEN_PAYLOAD);
		assert.match(error.message, /repeats the Token field/u);
	});

	it("refuses a payload above the byte ceiling", () => {
		const error = expectContractChange(OVERSIZED_PAYLOAD);
		assert.match(error.message, /byte ceiling/u);
	});

	it("refuses a payload above the line ceiling", () => {
		const padded = `${VALID_PAYLOAD}${"\n".repeat(MAX_PAYLOAD_LINES + 1)}`;
		const error = expectContractChange(padded);
		assert.match(error.message, /line ceiling/u);
	});

	it("refuses an endpoint that is not an upstash.io host", () => {
		const error = expectContractChange(
			VALID_PAYLOAD.replace(
				`https://${FAKE_REST_HOST}`,
				"https://evil.example.com",
			),
		);
		assert.match(error.message, /not an https host under upstash\.io/u);
	});

	it("refuses a console URL that names a different database", () => {
		const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const error = expectContractChange(
			VALID_PAYLOAD.replace(`console/${FAKE_DATABASE_ID}`, `console/${other}`),
		);
		// A console link pointing elsewhere is a claim hijack.
		assert.match(
			error.message,
			/console URL does not address the returned database id/u,
		);
	});

	it("refuses a metrics URL that names a different database", () => {
		const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const error = expectContractChange(
			VALID_PAYLOAD.replace(`metrics/${FAKE_DATABASE_ID}`, `metrics/${other}`),
		);
		assert.match(
			error.message,
			/Metrics URL does not address the returned database id/u,
		);
	});

	it("refuses a token outside the expected bounds without echoing it", () => {
		const error = expectContractChange(
			VALID_PAYLOAD.replace(FAKE_REST_TOKEN, "short!!token with spaces"),
		);
		assert.match(error.message, /charset or length bounds/u);
		assert.ok(
			!JSON.stringify(error.toJSON()).includes("short!!token"),
			"a rejected token must not be echoed back",
		);
	});

	it("refuses a database id that is not a UUIDv4", () => {
		const error = expectContractChange(
			VALID_PAYLOAD.replaceAll(FAKE_DATABASE_ID, "not-a-uuid"),
		);
		assert.match(error.message, /Database ID is not a UUIDv4/u);
	});

	it("refuses an expiry that is not the documented shape", () => {
		const error = expectContractChange(
			VALID_PAYLOAD.replace("2026-08-11 (3 days from creation).", "soon"),
		);
		assert.match(error.message, /Expires field does not match/u);
	});
	it("rejects impossible calendar dates rather than normalizing a longer lease", () => {
		expectContractChange(VALID_PAYLOAD.replace("2026-08-11", "2026-02-30"));
		expectContractChange(
			VALID_PAYLOAD.replace("3 days from creation", "0 days from creation"),
		);
	});

	it("refuses an empty body", () => {
		expectContractChange("");
	});

	it("understands exactly the five reviewed labels", () => {
		// A guard on the contract itself: adding a label here without
		// widening the parser version is the mistake this pins.
		assert.deepEqual(
			[...EXPECTED_FIELD_LABELS],
			["Database ID", "Endpoint", "Token", "Metrics", "Expires"],
		);
	});
});

describe("describeStartRedisDatabase", () => {
	it("reviews the native Redis credential as v2 without rendering it in summaries", () => {
		const native = `rediss://default:FAKE-native-password-DO-NOT-USE-0000@${FAKE_REST_HOST}:6379`;
		const parsed = parseStartRedisResponse(
			VALID_PAYLOAD.replace(
				"**Token:",
				`**Redis URL:** ${native} (TCP with TLS, for Redis clients)\n**Token:`,
			),
		);
		assert.equal(parsed.contract, UPSTASH_START_REDIS_NATIVE_CONTRACT);
		assert.equal(parsed.redisProtocolUrl, native);
		assert.equal(
			describeStartRedisDatabase(parsed).redisProtocolUrlPresent,
			true,
		);
		assert.equal(
			JSON.stringify(describeStartRedisDatabase(parsed)).includes(
				"FAKE-native-password",
			),
			false,
		);
	});
	it("rejects native credentials for another host, insecure transport, or an ambiguous duplicate", () => {
		const native = `rediss://default:FAKE-native-password-DO-NOT-USE-0000@${FAKE_REST_HOST}:6379`;
		for (const value of [
			native.replace("rediss:", "redis:"),
			native.replace(FAKE_REST_HOST, "attacker.example"),
			`${native}?forward=evil`,
		]) {
			expectContractChange(
				VALID_PAYLOAD.replace("**Token:", `**Redis URL:** ${value}\n**Token:`),
			);
		}
		expectContractChange(
			VALID_PAYLOAD.replace(
				"**Token:",
				`**Redis URL:** ${native}\n**Redis URL:** ${native}\n**Token:`,
			),
		);
	});
	it("summarizes status without native bearer identity, claim URL, endpoint or credentials", () => {
		const summary = describeStartRedisDatabase(
			parseStartRedisResponse(VALID_PAYLOAD),
		);

		assert.equal(summary.tokenBytes, FAKE_REST_TOKEN.length);
		const publicStatus = JSON.stringify(summary);
		for (const privateValue of [
			FAKE_DATABASE_ID,
			FAKE_REST_TOKEN,
			FAKE_CONSOLE_URL,
			FAKE_REST_HOST,
		])
			assert.ok(!publicStatus.includes(privateValue));
	});
});

describe("parseStartRedisMetrics", () => {
	it("reads the documented counters", () => {
		const metrics = parseStartRedisMetrics(
			JSON.stringify({ uptime_seconds: 120, commands_total: 7, keys: 3 }),
			FAKE_DATABASE_ID,
		);

		assert.equal(metrics.uptimeSeconds, 120);
		assert.equal(metrics.commandsTotal, 7);
		assert.equal(metrics.keys, 3);
		// Absent counters stay absent instead of defaulting to zero, which
		// would read as "measured and empty".
		assert.equal(metrics.memoryBytes, undefined);
	});

	it("refuses a non-JSON body", () => {
		assert.throws(
			() =>
				parseStartRedisMetrics("<html>maintenance</html>", FAKE_DATABASE_ID),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses a negative counter", () => {
		assert.throws(
			() =>
				parseStartRedisMetrics(JSON.stringify({ keys: -1 }), FAKE_DATABASE_ID),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
		);
	});
});
