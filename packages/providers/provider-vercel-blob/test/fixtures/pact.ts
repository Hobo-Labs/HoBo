/**
 * The Blob HTTP pact: its scenario, recording, loading, a replaying server
 * for the consumer side, and subset matching for the provider side.
 *
 * Interactions are HTTP exchanges as `@vercel/blob` 2.8.2 sends them, with
 * only the request headers the binding's behaviour depends on
 * (`PINNED_HEADERS`). One interaction is sent by another writer, not by the
 * binding (`sentBy: "another writer"`): it is what makes the binding's next
 * conditional upload fail with `412 precondition_failed`, so the provider side
 * replays it and the consumer side skips it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import {
	type EphemeralEntry,
	type EphemeralStatePort,
	type EphemeralWrite,
	parseEphemeralKey,
	parseEphemeralTtlMs,
	parseEphemeralVersion,
} from "@hobo/core";

import {
	blobPathname,
	createVercelBlobEphemeralState,
	encodeStoredRecord,
	parseStoredRecord,
	parseVercelBlobNamespace,
	purgeExpiredBlobs,
	type VercelBlobPurgeSummary,
	type VercelBlobSdk,
} from "../../src/index.js";
import {
	type BlobEmulator,
	type EmulatorReply,
	type RecordedRequest,
	recordRequest,
} from "./http-emulator.js";

export const PACT_NOW = 1_800_000_000_000;
export const PACT_NAMESPACE = "pact";
const OTHER_WRITER_ID = "other-writer-1";

export type PactJson =
	| string
	| number
	| boolean
	| null
	| readonly PactJson[]
	| { readonly [field: string]: PactJson };

export type PactInteraction = {
	readonly description: string;
	readonly sentBy: "binding" | "another writer";
	readonly request: RecordedRequest;
	readonly response: {
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: PactJson;
	};
};

const key = parseEphemeralKey;
const ttl = parseEphemeralTtlMs(60_000);

/** The descriptions, in order, of the interactions the scenario produces. */
export const PACT_STEPS = [
	"putIfAbsent of a missing key: create-only private upload, accepted",
	"putIfAbsent of a live key: the create-only upload is refused",
	"putIfAbsent of a live key: origin read shows the live record",
	"get: origin read",
	"compareAndSet: origin read for the version and ETag",
	"compareAndSet: upload conditional on the ETag read, accepted",
	"compareAndSet with a stale version: origin read only",
	"getMany: origin read of the present key",
	"getMany: origin read of an absent key is a 404",
	"increment of a missing key: origin read is a 404",
	"increment of a missing key: create-only upload of the step",
	"increment: origin read of the counter",
	"another writer bumps the counter with its own conditional upload",
	"increment: the upload conditional on the ETag it read is refused (412)",
	"increment: origin read after the conflict",
	"increment: upload conditional on the new ETag, accepted",
	"expire of a missing key: origin read is a 404",
	"versioned delete: origin read for the version and ETag",
	"versioned delete: delete conditional on the ETag, accepted",
	"purge: one listing page of the namespace",
] as const;

type ScenarioResult =
	| EphemeralWrite
	| EphemeralEntry
	| readonly (EphemeralEntry | undefined)[]
	| VercelBlobPurgeSummary
	| undefined;

/** The port calls the pact covers, and the results the consumer must see. */
export async function runPactScenario(
	port: EphemeralStatePort,
	sdk: VercelBlobSdk,
	arm: () => void,
): Promise<readonly PactJson[]> {
	const observed: PactJson[] = [];
	const json = (value: ScenarioResult) =>
		value === undefined ? null : JSON.parse(JSON.stringify(value));
	observed.push(
		json(await port.putIfAbsent(key("lease:42"), '{"runner":"r-1"}', ttl)),
	);
	observed.push(
		json(await port.putIfAbsent(key("lease:42"), '{"runner":"r-2"}', ttl)),
	);
	observed.push(json(await port.get(key("lease:42"))));
	observed.push(
		json(
			await port.compareAndSet(
				key("lease:42"),
				parseEphemeralVersion("inc-1:1"),
				'{"runner":"r-1","state":"dispatched"}',
				ttl,
			),
		),
	);
	observed.push(
		json(
			await port.compareAndSet(
				key("lease:42"),
				parseEphemeralVersion("inc-1:1"),
				"stale",
				ttl,
			),
		),
	);
	observed.push(
		json(await port.getMany([key("lease:42"), key("lease:absent")])),
	);
	observed.push(await port.increment(key("rate:a"), 2, ttl));
	arm();
	observed.push(await port.increment(key("rate:a"), 3, ttl));
	observed.push(await port.expire(key("missing"), ttl));
	observed.push(
		await port.delete(key("lease:42"), parseEphemeralVersion("inc-1:2")),
	);
	observed.push(
		json(
			await purgeExpiredBlobs({
				sdk,
				namespace: PACT_NAMESPACE,
				now: () => PACT_NOW,
				maxReads: 0,
			}),
		),
	);
	return observed;
}

/** A port wired the way the pact was recorded: fixed clock, ids and order. */
export function pactPort(sdk: VercelBlobSdk): EphemeralStatePort {
	let incarnations = 0;
	let writes = 0;
	return createVercelBlobEphemeralState({
		sdk,
		namespace: PACT_NAMESPACE,
		now: () => PACT_NOW,
		newIncarnation: () => `inc-${++incarnations}`,
		newWriteId: () => `w-${++writes}`,
		readConcurrency: 1,
		retry: { sleep: async () => {}, random: () => 0 },
	});
}

/**
 * Wrap `sdk` so that, once armed, the next conditional upload is preceded by
 * `interfere` (another writer's upload) — the consumer passes a no-op.
 */
export type InterferingSdk = {
	readonly sdk: VercelBlobSdk;
	arm(): void;
};

export function withInterference(
	sdk: VercelBlobSdk,
	interfere: (pathname: string) => Promise<void>,
): InterferingSdk {
	let armed = false;
	return {
		arm: () => {
			armed = true;
		},
		sdk: {
			...sdk,
			async put(pathname, body, options) {
				if (armed && options.ifMatch !== undefined) {
					armed = false;
					await interfere(pathname);
				}
				return sdk.put(pathname, body, options);
			},
		},
	};
}

/** Another writer's conditional bump of the counter, sent through `sdk`. */
export function otherWriter(
	emulator: BlobEmulator,
	sdk: VercelBlobSdk,
): (pathname: string) => Promise<void> {
	return async (pathname) => {
		const blob = emulator.store.blobs().get(pathname);
		if (blob === undefined) throw new Error("nothing to interfere with");
		const record = parseStoredRecord(blob.body);
		await sdk.put(
			pathname,
			encodeStoredRecord({
				...record,
				value: "10",
				revision: record.revision + 1,
				writeId: OTHER_WRITER_ID,
			}),
			{
				access: "private",
				contentType: "application/json",
				addRandomSuffix: false,
				cacheControlMaxAge: 60,
				allowOverwrite: true,
				ifMatch: blob.etag,
			},
		);
	};
}

/** URL fields carry the emulator's random port and are not read by the binding. */
const UNPINNED_FIELDS = new Set(["url", "downloadUrl"]);

function withoutUrls(value: PactJson): PactJson {
	if (Array.isArray(value)) return value.map(withoutUrls);
	if (!isPactRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([field]) => !UNPINNED_FIELDS.has(field))
			.map(([field, inner]) => [field, withoutUrls(inner)]),
	);
}

/** API replies are JSON and pinned field by field; a blob read's body is pinned as text. */
function parseBody(request: RecordedRequest, reply: EmulatorReply): PactJson {
	if (request.path.startsWith("/blob/") || reply.body === "") {
		return reply.body;
	}
	const parsed: PactJson = JSON.parse(reply.body);
	return withoutUrls(parsed);
}

/** Turn a recorded run into pact interactions. */
export function toInteractions(
	requests: readonly RecordedRequest[],
	replies: readonly EmulatorReply[],
): PactInteraction[] {
	return requests.map((request, index) => {
		const reply = replies[index];
		if (reply === undefined) throw new Error("a request has no reply");
		const description = PACT_STEPS[index] ?? `unexpected request ${index}`;
		const headers: Record<string, string> = {};
		if (reply.headers.etag !== undefined) headers.etag = reply.headers.etag;
		return {
			description,
			sentBy: request.body.includes(OTHER_WRITER_ID)
				? "another writer"
				: "binding",
			request,
			response: {
				status: reply.status,
				headers,
				body: parseBody(request, reply),
			},
		};
	});
}

const PACT_PATH = fileURLToPath(
	new URL(
		"../../contracts/vercel-blob-ephemeral-state.pact.json",
		import.meta.url,
	),
);

export function writePact(interactions: readonly PactInteraction[]): void {
	const pact = {
		consumer: {
			name: "@hobo/provider-vercel-blob ephemeral-state binding, through @vercel/blob 2.8.2",
		},
		provider: { name: "Vercel Blob API, private store" },
		metadata: {
			pactSpecification: { version: "3.0.0" },
			note: "HTTP exchanges the binding causes through the pinned SDK, with only the request headers its behaviour depends on. Hand-authored from a run against the local emulator, not captured from or verified against Vercel. The clock, incarnations and write ids are fixed; ETags are the emulator's. The interaction sent by 'another writer' is replayed by the provider side and skipped by the consumer side.",
		},
		interactions,
	};
	writeFileSync(PACT_PATH, `${JSON.stringify(pact, null, "\t")}\n`);
}

export function loadPact(): readonly PactInteraction[] {
	// SAFETY: a checked-in fixture whose structure the pact test pins.
	const pact = JSON.parse(readFileSync(PACT_PATH, "utf8")) as {
		readonly interactions: readonly PactInteraction[];
	};
	return pact.interactions;
}

const tagOf = Object.prototype.toString;

export function isPactText(value: PactJson): value is string {
	return tagOf.call(value) === "[object String]";
}

function isPactRecord(
	value: PactJson,
): value is { readonly [field: string]: PactJson } {
	return tagOf.call(value) === "[object Object]";
}

/** True when every field of `expected` is in `actual` with a matching value. */
export function matchesSubset(expected: PactJson, actual: PactJson): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((item, index) =>
				matchesSubset(item, actual[index] ?? null),
			)
		);
	}
	if (isPactRecord(expected)) {
		return (
			isPactRecord(actual) &&
			Object.entries(expected).every(([field, value]) =>
				matchesSubset(value, actual[field] ?? null),
			)
		);
	}
	return expected === actual;
}

export type ReplayServer = {
	readonly origin: string;
	readonly apiUrl: string;
	/** Requests that did not match the next binding interaction. */
	readonly mismatches: string[];
	/** Binding interactions not yet requested. */
	remaining(): number;
	close(): Promise<void>;
};

/** Answers each request with the next binding interaction's response. */
export async function startReplayServer(
	interactions: readonly PactInteraction[],
): Promise<ReplayServer> {
	const queue = interactions.filter(
		(interaction) => interaction.sentBy === "binding",
	);
	const mismatches: string[] = [];
	let origin = "";
	const server = createServer((incoming, outgoing) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const request = recordRequest(
				incoming.method ?? "GET",
				new URL(incoming.url ?? "/", origin),
				(name) => {
					const value = incoming.headers[name];
					return Array.isArray(value) ? value.join(",") : value;
				},
				Buffer.concat(chunks).toString("utf8"),
			);
			const next = queue.shift();
			if (next === undefined) {
				mismatches.push(`unexpected ${request.method} ${request.path}`);
				outgoing.writeHead(500).end();
				return;
			}
			if (JSON.stringify(request) !== JSON.stringify(next.request)) {
				mismatches.push(
					`${next.description}: sent ${JSON.stringify(request)}, pact ${JSON.stringify(next.request)}`,
				);
			}
			const { status, headers, body } = next.response;
			outgoing.writeHead(status, {
				...headers,
				"content-type": "application/json",
			});
			outgoing.end(isPactText(body) ? body : JSON.stringify(body));
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a TCP server listening on a port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${port}`;
	return {
		origin,
		apiUrl: `${origin}/api/blob`,
		mismatches,
		remaining: () => queue.length,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

/** The counter's pathname, for assertions. */
export const COUNTER_PATHNAME = blobPathname(
	parseVercelBlobNamespace(PACT_NAMESPACE),
	key("rate:a"),
);
