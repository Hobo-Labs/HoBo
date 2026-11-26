/**
 * Parse-don't-validate boundary for the `start-redis` markdown response.
 *
 * The provider hands back a human-readable markdown document with a live REST
 * token in it. That is a hostile shape to parse, because the obvious approach
 * — find something that looks like a URL, find something that looks like a
 * token — keeps "working" after the document is restructured, and hands the
 * caller the wrong string instead of an error.
 *
 * So there is no scraping here:
 *
 * - The document must open with the expected heading. An error page, a
 *   maintenance notice, and a captive portal all fail on the first line
 *   instead of being mined for fields.
 * - Exactly {@link EXPECTED_FIELD_LABELS} are understood, each required, each
 *   permitted once. A **new** labelled field is a rejection, not something to
 *   ignore: the one Upstash is most likely to add is another credential, and
 *   silently skipping it means a token this driver neither deposits nor
 *   redacts.
 * - Every value has an explicit charset and length bound.
 * - The console and metrics URLs must name the same database as the
 *   `Database ID` field. A console link pointing elsewhere is a claim
 *   hijack, and there is no benign reading of it.
 * - Anything unparseable fails closed with `PROVIDER_CONTRACT_CHANGED`. There
 *   is no partial success: a response missing the endpoint is not a database
 *   with an unknown endpoint, it is a document this driver does not
 *   understand.
 *
 * Prose between the fields is ignored on purpose — the quickstart changes
 * often and carries no contract — but the document as a whole stays bounded in
 * bytes, lines, and line length.
 *
 * Sources, checked 2026-08-08 (full list in the README):
 * - https://upstash.com/docs/redis/sdks/ts/getstarted
 * - https://upstash.com/start-redis
 */
import type { StartRedisDatabase as StartRedisDatabaseWire } from "./_generated/temporary_redis_pb.js";
import { redactProviderText, UpstashProviderError } from "./errors.js";
import {
	isJsonNumber,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { DomainView } from "./wire.js";

/**
 * The response shape this parser understands.
 *
 * Bump it — do not widen the parser in place — when the provider changes the
 * document. The version is carried on every parse result so a receipt records
 * which contract produced it.
 */
// public-contract: parser contract id carried on every parse result.
export const UPSTASH_START_REDIS_CONTRACT =
	"upstash.start-redis.markdown/v1" as const;
// public-contract: reviewed live response adds an independent native Redis credential.
export const UPSTASH_START_REDIS_NATIVE_CONTRACT =
	"upstash.start-redis.markdown/v2" as const;

/** The exact heading the document opens with. */
// public-contract: the heading whose change is the drift signal.
export const EXPECTED_HEADING = "# Your Redis is ready";

/** Every label this parser version understands. All are required. */
export const EXPECTED_FIELD_LABELS = [
	"Database ID",
	"Endpoint",
	"Token",
	"Metrics",
	"Expires",
] as const;

export type ExpectedFieldLabel = (typeof EXPECTED_FIELD_LABELS)[number];

export const MAX_PAYLOAD_BYTES = 16_384;
export const MAX_PAYLOAD_LINES = 200;
export const MAX_LINE_LENGTH = 1_024;

// domain-view: this privileged native parser record carries bearer capability
// ids, claim URLs and credentials for their single hop to private custody.
// Public receipts/facts use a separate generated custodial projection.
export type StartRedisDatabase = DomainView<
	StartRedisDatabaseWire,
	{
		contract:
			| typeof UPSTASH_START_REDIS_CONTRACT
			| typeof UPSTASH_START_REDIS_NATIVE_CONTRACT;
		/**
		 * Earliest instant consistent with the reported date.
		 *
		 * `int64` on the wire; epoch milliseconds are a JSON-safe `number`
		 * here, which is what every consumer in this package compares against
		 * a clock reading.
		 */
		expiresAtMs: number;
	},
	"tokenPresent"
> & {
	/**
	 * The bearer token, in plaintext.
	 *
	 * The native database UUID, claim URL and optional native Redis URL are also
	 * bearer capabilities. This entire record belongs in private custody. Use
	 * {@link describeStartRedisDatabase} for public status diagnostics, or the
	 * asynchronous custodial receipt/facts projection for a public resource.
	 */
	readonly token: string;
	/** Native Redis URI is also a credential; it is deposited into custody immediately. */
	readonly redisProtocolUrl?: string;
};

/** Everything about a parsed response that is safe to log. */
export type StartRedisSummary = {
	readonly contract: StartRedisDatabase["contract"];
	readonly expiresAtIso: string;
	readonly tokenBytes: number;
	readonly redisProtocolUrlPresent: boolean;
};

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FIELD_LINE = /^\*\*([A-Za-z][A-Za-z0-9 ]{0,39}):\*\*[ \t]+(.+?)[ \t]*$/u;
const CONSOLE_LINE =
	/^https:\/\/upstash\.com\/start-redis\/console\/([0-9a-f-]{36})$/u;
const ENDPOINT =
	/^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io)$/u;
const TOKEN = /^[A-Za-z0-9_=-]{20,1024}$/u;
const EXPIRES = /^(\d{4}-\d{2}-\d{2}) \((\d{1,3}) days? from creation\)\.?$/u;
const METRICS_PREFIX = "https://upstash.com/start-redis/metrics/";
function hasDisallowedControl(text: string): boolean {
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (code === 9 || code === 10 || code === 13) continue;
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function contractError(
	message: string,
	detail?: { preview?: string; length?: number; databaseId?: string },
): never {
	throw new UpstashProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}

function isExpectedFieldLabel(
	value: string,
): value is ExpectedFieldLabel | "Redis URL" {
	switch (value) {
		case "Database ID":
		case "Endpoint":
		case "Token":
		case "Metrics":
		case "Expires":
		case "Redis URL":
			return true;
		default:
			return false;
	}
}

function boundedLines(body: string): readonly string[] {
	if (body.length === 0) {
		contractError("start-redis response body was empty");
	}
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes > MAX_PAYLOAD_BYTES) {
		contractError(
			`start-redis response is ${bytes} bytes, above the ${MAX_PAYLOAD_BYTES} byte ceiling`,
		);
	}
	if (hasDisallowedControl(body)) {
		contractError("start-redis response contains control characters");
	}
	const lines = body.split(/\r?\n/u);
	if (lines.length > MAX_PAYLOAD_LINES) {
		contractError(
			`start-redis response has ${lines.length} lines, above the ${MAX_PAYLOAD_LINES} line ceiling`,
		);
	}
	for (const line of lines) {
		if (line.length > MAX_LINE_LENGTH) {
			contractError(
				`start-redis response contains a line above the ${MAX_LINE_LENGTH} character ceiling`,
			);
		}
	}
	return lines;
}

function readFields(lines: readonly string[]): ReadonlyMap<string, string> {
	const fields = new Map<string, string>();
	for (const line of lines) {
		const match = FIELD_LINE.exec(line.trim());
		if (match === null) continue;
		const label = match[1];
		const value = match[2];
		if (label === undefined || value === undefined) continue;
		if (!isExpectedFieldLabel(label)) {
			// The likeliest new field is another credential. Ignoring it would
			// mean one this driver never deposits and never redacts.
			contractError(
				`start-redis response carries an unreviewed ${JSON.stringify(label)} field`,
			);
		}
		if (fields.has(label)) {
			// Two `Token:` lines is not a document with a token, it is a
			// document whose meaning is ambiguous.
			contractError(`start-redis response repeats the ${label} field`);
		}
		fields.set(label, value);
	}
	return fields;
}

function requireField(
	fields: ReadonlyMap<string, string>,
	label: ExpectedFieldLabel,
	body: string,
): string {
	const value = fields.get(label);
	if (value === undefined) {
		contractError(`start-redis response is missing the ${label} field`, {
			preview: redactProviderText(body, 120),
		});
	}
	return value;
}

/**
 * Parse a `POST https://upstash.com/start-redis` response body.
 *
 * @param body the raw `text/markdown` document
 */
export function parseStartRedisResponse(body: string): StartRedisDatabase {
	const lines = boundedLines(body);

	const heading = lines.find((line) => line.trim().length > 0)?.trim();
	if (heading !== EXPECTED_HEADING) {
		contractError(
			`start-redis response does not open with ${JSON.stringify(EXPECTED_HEADING)}`,
		);
	}

	const fields = readFields(lines);

	const databaseId = requireField(fields, "Database ID", body);
	if (!UUID_V4.test(databaseId)) {
		contractError("start-redis Database ID is not a UUIDv4");
	}

	const endpointMatch = ENDPOINT.exec(requireField(fields, "Endpoint", body));
	if (endpointMatch === null) {
		// A database endpoint on someone else's domain is the whole attack.
		contractError("start-redis Endpoint is not an https host under upstash.io");
	}
	const restEndpointHost = endpointMatch[1];
	if (restEndpointHost === undefined) {
		contractError("start-redis Endpoint is not an https host under upstash.io");
	}

	const token = requireField(fields, "Token", body);
	if (!TOKEN.test(token)) {
		// Never echo the value: a token that failed a charset check is still
		// a token.
		contractError(
			"start-redis Token is outside the expected charset or length bounds",
			{
				length: token.length,
			},
		);
	}
	let redisProtocolUrl: string | undefined;
	const nativeField = fields.get("Redis URL");
	if (nativeField !== undefined) {
		const [candidate] = nativeField.split(/\s/u);
		try {
			const url = new URL(candidate ?? "");
			if (
				url.protocol !== "rediss:" ||
				url.username !== "default" ||
				!TOKEN.test(decodeURIComponent(url.password)) ||
				url.hostname !== restEndpointHost ||
				url.port !== "6379" ||
				url.pathname ||
				url.search ||
				url.hash
			)
				throw new Error("invalid native connection scope");
			redisProtocolUrl = url.toString();
		} catch {
			contractError(
				"start-redis Redis URL is not a TLS credential for the returned Redis host",
			);
		}
	}

	// The observed field is the URL followed by a parenthesised note about the
	// JSON it returns, so the prefix is checked and the note is discarded.
	const metrics = requireField(fields, "Metrics", body);
	const expectedMetricsUrl = `${METRICS_PREFIX}${databaseId}`;
	if (
		metrics !== expectedMetricsUrl &&
		!metrics.startsWith(`${expectedMetricsUrl} `)
	) {
		contractError(
			"start-redis Metrics URL does not address the returned database id",
			{
				databaseId,
			},
		);
	}

	const expiresRaw = requireField(fields, "Expires", body);
	const expiresMatch = EXPIRES.exec(expiresRaw);
	if (expiresMatch === null) {
		contractError(
			"start-redis Expires field does not match `<YYYY-MM-DD> (N days from creation)`",
		);
	}
	const expiresOn = expiresMatch[1];
	if (expiresOn === undefined) {
		contractError(
			"start-redis Expires field does not match `<YYYY-MM-DD> (N days from creation)`",
		);
	}
	const expiresAtMs = Date.parse(`${expiresOn}T00:00:00.000Z`);
	if (
		!Number.isFinite(expiresAtMs) ||
		new Date(expiresAtMs).toISOString().slice(0, 10) !== expiresOn
	) {
		contractError("start-redis Expires date is not a real date");
	}
	if (Number(expiresMatch[2]) < 1)
		contractError("start-redis Expires lifetime must be positive");

	const consoleIds = new Set<string>();
	let consoleUrl: string | undefined;
	for (const line of lines) {
		const match = CONSOLE_LINE.exec(line.trim());
		if (match === null) continue;
		const consoleId = match[1];
		if (consoleId === undefined) continue;
		consoleIds.add(consoleId);
		consoleUrl = line.trim();
	}
	if (consoleUrl === undefined) {
		contractError(
			"start-redis response carries no console URL to claim the database with",
		);
	}
	if (consoleIds.size > 1) {
		contractError(
			"start-redis response carries console URLs for more than one database",
		);
	}
	if (!consoleIds.has(databaseId)) {
		contractError(
			"start-redis console URL does not address the returned database id",
			{
				databaseId,
			},
		);
	}

	return {
		contract:
			redisProtocolUrl === undefined
				? UPSTASH_START_REDIS_CONTRACT
				: UPSTASH_START_REDIS_NATIVE_CONTRACT,
		databaseId,
		restEndpointHost,
		restEndpointUrl: `https://${restEndpointHost}`,
		token,
		...(redisProtocolUrl === undefined ? undefined : { redisProtocolUrl }),
		expiresOn,
		expiresAtMs,
		expiresAtIso: new Date(expiresAtMs).toISOString(),
		expiresRaw,
		statedTtlDays: Number(expiresMatch[2]),
		consoleUrl,
		metricsUrl: expectedMetricsUrl,
	};
}

/** The only safe way to render a parsed response. */
export function describeStartRedisDatabase(
	database: StartRedisDatabase,
): StartRedisSummary {
	return {
		contract: database.contract,
		expiresAtIso: database.expiresAtIso,
		tokenBytes: Buffer.byteLength(database.token, "utf8"),
		redisProtocolUrlPresent: database.redisProtocolUrl !== undefined,
	};
}

/**
 * The metrics document, which is JSON rather than markdown.
 *
 * Every counter is optional: the announcement that documents them is not a
 * schema, and failing the whole read because a field was renamed would break
 * observation over something the driver only reports.
 */
export type StartRedisMetrics = {
	readonly databaseId: string;
	readonly uptimeSeconds?: number;
	readonly commandsTotal?: number;
	readonly keys?: number;
	readonly memoryBytes?: number;
	readonly bytesIn?: number;
	readonly bytesOut?: number;
};

function optionalCount(record: JsonObject, key: string): number | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (!isJsonNumber(value) || !Number.isFinite(value) || value < 0) {
		contractError(
			`start-redis metrics field ${key} is not a non-negative number`,
		);
	}
	return value;
}

export function parseStartRedisMetrics(
	body: string,
	databaseId: string,
): StartRedisMetrics {
	let decoded: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		decoded = JSON.parse(body) as JsonValue;
	} catch {
		return contractError("start-redis metrics response was not JSON", {
			preview: redactProviderText(body, 80),
		});
	}
	if (!isJsonObject(decoded)) {
		contractError("start-redis metrics response was not a JSON object");
	}
	const record = decoded;
	const uptimeSeconds = optionalCount(record, "uptime_seconds");
	const commandsTotal = optionalCount(record, "commands_total");
	const keys = optionalCount(record, "keys");
	const memoryBytes = optionalCount(record, "memory_bytes");
	const bytesIn = optionalCount(record, "bytes_in");
	const bytesOut = optionalCount(record, "bytes_out");
	return {
		databaseId,
		...(uptimeSeconds !== undefined ? { uptimeSeconds } : undefined),
		...(commandsTotal !== undefined ? { commandsTotal } : undefined),
		...(keys !== undefined ? { keys } : undefined),
		...(memoryBytes !== undefined ? { memoryBytes } : undefined),
		...(bytesIn !== undefined ? { bytesIn } : undefined),
		...(bytesOut !== undefined ? { bytesOut } : undefined),
	};
}
