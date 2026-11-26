/**
 * Consumer-driven contract verification for the host asset origin.
 *
 * `contracts/provider-browser-wasm-host-origin.pact.json` states what this
 * package expects of the page that is going to run the guest. A pact file
 * nobody replays is a wish, so this suite loads it and drives the real client
 * against each interaction: the request the client emits must match the one the
 * pact describes, and the client must behave as documented when handed the
 * pact's recorded response.
 *
 * The fake sits at the HTTP seam and nowhere else. The parsers, the digest
 * verification (real Web Crypto over the pact's real bytes), the same-origin
 * guard and the driver are all the shipping ones; only `fetch` and the guest
 * runtime are stood in for, because neither exists in Node.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	createHostAssetClient,
	createUnavailableRuntime,
	type GuestManifest,
	type GuestPlacement,
	type GuestRuntimePort,
	isBrowserWasmProviderError,
	negotiatePersistence,
	parseGuestPlacement,
	provisionGuest,
	releaseGuest,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
import type { HostAssetTransport, TransportRequest } from "../src/transport.js";

const HOST_ORIGIN = "https://try-site.browser-wasm.hobo.localhost";

type PactHeaders = Readonly<Record<string, string>>;

type PactInteraction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly headers?: PactHeaders;
	};
	readonly response: {
		readonly status: number;
		readonly headers?: PactHeaders;
		readonly encoding?: "base64";
		readonly body?: JsonValue;
	};
};

type PactFile = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly metadata: {
		readonly source: { readonly url: string; readonly checkedAt: string };
	};
	readonly interactions: readonly PactInteraction[];
};

function jsonStringMap(value: JsonValue | undefined) {
	if (!isJsonObject(value)) return {};
	const mapped: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonString(entry)) mapped[key] = entry;
	}
	return mapped;
}

function parseInteraction(entry: JsonObject): PactInteraction | undefined {
	const request = isJsonObject(entry.request) ? entry.request : undefined;
	const response = isJsonObject(entry.response) ? entry.response : undefined;
	if (
		!isJsonString(entry.description) ||
		request === undefined ||
		response === undefined ||
		!isJsonString(request.method) ||
		!isJsonString(request.path)
	) {
		return undefined;
	}
	return {
		description: entry.description,
		request: {
			method: request.method,
			path: request.path,
			headers: jsonStringMap(request.headers),
		},
		response: {
			status: isJsonNumber(response.status) ? response.status : 0,
			headers: jsonStringMap(response.headers),
			...(response.encoding === "base64" ? { encoding: "base64" } : undefined),
			body: response.body,
		},
	};
}

function loadPact(): PactFile {
	const decoded = parseJsonObject(
		readFileSync(
			fileURLToPath(
				new URL(
					"../contracts/provider-browser-wasm-host-origin.pact.json",
					import.meta.url,
				),
			),
			"utf8",
		),
	);
	const consumer = isJsonObject(decoded.consumer)
		? decoded.consumer
		: undefined;
	const provider = isJsonObject(decoded.provider)
		? decoded.provider
		: undefined;
	const metadata = isJsonObject(decoded.metadata)
		? decoded.metadata
		: undefined;
	const source = isJsonObject(metadata?.source) ? metadata.source : undefined;
	const interactionsRaw = decoded.interactions;
	if (
		!isJsonString(consumer?.name) ||
		!isJsonString(provider?.name) ||
		!isJsonString(source?.checkedAt) ||
		!isJsonString(source?.url) ||
		!isJsonArray(interactionsRaw) ||
		interactionsRaw.length === 0
	) {
		throw new Error("the pact file is malformed");
	}
	const interactions: PactInteraction[] = [];
	for (const entry of interactionsRaw) {
		if (!isJsonObject(entry)) {
			throw new Error("the pact file has a malformed interaction");
		}
		const parsed = parseInteraction(entry);
		if (parsed === undefined) {
			throw new Error("the pact file has a malformed interaction");
		}
		interactions.push(parsed);
	}
	return {
		consumer: { name: consumer.name },
		provider: { name: provider.name },
		metadata: { source: { url: source.url, checkedAt: source.checkedAt } },
		interactions,
	};
}

const pact = loadPact();

function interaction(fragment: string): PactInteraction {
	const found = pact.interactions.find((entry) =>
		entry.description.includes(fragment),
	);
	if (found === undefined) {
		throw new Error(
			`the pact has no interaction matching ${JSON.stringify(fragment)}`,
		);
	}
	return found;
}

/**
 * Recover the recorded body as bytes.
 *
 * A WebAssembly bundle cannot be recorded as JSON, so those interactions carry
 * base64 and say so. Everything else is a JSON document, recorded readably.
 */
function bodyBytes(response: PactInteraction["response"]): Uint8Array {
	if (response.body === undefined) return new Uint8Array();
	if (response.encoding === "base64") {
		return new Uint8Array(Buffer.from(String(response.body), "base64"));
	}
	return new TextEncoder().encode(JSON.stringify(response.body));
}

type RecordingTransport = HostAssetTransport & {
	readonly requests: readonly TransportRequest[];
};

function recordedRequest(transport: RecordingTransport): TransportRequest {
	const request = transport.requests[0];
	if (request === undefined) {
		throw new Error("the client made no request");
	}
	return request;
}

function transportReplaying(
	...interactions: readonly PactInteraction[]
): RecordingTransport {
	const requests: TransportRequest[] = [];
	let index = 0;
	return {
		requests,
		async request(request) {
			requests.push(request);
			const next = interactions[index];
			index += 1;
			if (next === undefined) {
				throw new Error(
					`the client made ${requests.length} calls; the pact replay supplied ${interactions.length}`,
				);
			}
			return {
				status: next.response.status,
				headers: Object.fromEntries(
					Object.entries(next.response.headers ?? {}).map(([key, value]) => [
						key.toLowerCase(),
						value,
					]),
				),
				body: bodyBytes(next.response),
			};
		},
	};
}

function clientOver(transport: HostAssetTransport) {
	return createHostAssetClient({ transport, origin: HOST_ORIGIN });
}

function pathOf(request: TransportRequest): string {
	return new URL(request.url).pathname;
}

function headerOf(request: TransportRequest, name: string): string | undefined {
	return Object.entries(request.headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	)?.[1];
}

function assertMatchesPactRequest(
	request: TransportRequest,
	expected: PactInteraction,
): void {
	expect(request.method).toBe(expected.request.method);
	expect(pathOf(request)).toBe(expected.request.path);
	for (const [name, value] of Object.entries(expected.request.headers ?? {})) {
		expect(headerOf(request, name)).toBe(value);
	}
}

const placement: GuestPlacement = parseGuestPlacement({
	guestId: "try-site",
	port: "compute",
	world: "hobo:guest/http-handler@0.1.0",
	persistence: "opfs-sahpool",
	memoryLimitBytes: 268_435_456,
	requiredImports: ["wasi:io/streams@0.2.0"],
});

/** A runtime that records what it was asked to do and does nothing else. */
function runtimeProviding(
	providedImports: readonly string[],
	overrides: Partial<{
		readonly workerName: string;
		readonly partitionId: string;
		readonly partitionDropped: boolean;
		readonly workerTerminated: boolean;
	}> = {},
): GuestRuntimePort & {
	readonly instantiations: readonly unknown[];
	readonly terminations: readonly unknown[];
} {
	const instantiations: unknown[] = [];
	const terminations: unknown[] = [];
	return {
		providedImports,
		instantiations,
		terminations,
		async instantiate(input) {
			instantiations.push(input);
			return {
				workerName: overrides.workerName ?? "guest-try-site",
				partitionId: overrides.partitionId ?? "guest-try-site",
				instantiatedAtMs: Date.UTC(2026, 7, 8, 12, 0, 0),
			};
		},
		async terminate(input) {
			terminations.push(input);
			return {
				workerTerminated: overrides.workerTerminated ?? true,
				partitionDropped: overrides.partitionDropped ?? input.dropPartition,
			};
		},
	};
}

const HOST_IMPORTS = [
	"wasi:io/streams@0.2.0",
	"wasi:http/outgoing-handler@0.2.0",
];

describe("the pact file itself", () => {
	it("names this package as the consumer and dates its source", () => {
		expect(pact.consumer.name).toBe("@hobo/provider-browser-wasm");
		expect(pact.provider.name).toBe("BrowserWasmHostAssetOrigin");
		expect(pact.metadata.source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
	});

	it("only describes routes under the /_hobo/ prefix the guard allows", () => {
		for (const entry of pact.interactions) {
			expect(entry.request.path).toMatch(/^\/_hobo\//u);
		}
	});

	it("records every bundle as base64, because a component is not JSON", () => {
		for (const entry of pact.interactions) {
			if (entry.request.path.endsWith(".wasm")) {
				expect(entry.response.encoding).toBe("base64");
			}
		}
	});
});

describe("host capabilities, verified against the pact", () => {
	it("sends the request the pact declares and parses the isolated context", async () => {
		const capabilities = interaction("cross-origin isolated context");
		const transport = transportReplaying(capabilities);

		const host = await clientOver(transport).fetchHostCapabilities();

		assertMatchesPactRequest(recordedRequest(transport), capabilities);
		expect(host.origin).toBe(HOST_ORIGIN);
		expect(host.crossOriginIsolated).toBe(true);
		expect(host.persistence).toBe("opfs-sahpool");
	});

	it("parses a private-mode context as unavailable rather than as an error", async () => {
		// "No durable storage" is an answer, not a failure. Turning it into one
		// here would hide the case the negotiation below exists for.
		const transport = transportReplaying(interaction("private-mode context"));

		const host = await clientOver(transport).fetchHostCapabilities();

		expect(host.persistence).toBe("unavailable");
		expect(host.crossOriginIsolated).toBe(false);
	});
});

describe("the guest manifest, verified against the pact", () => {
	const manifestInteraction = interaction("serve the guest manifest");

	it("sends the request the pact declares", async () => {
		const transport = transportReplaying(manifestInteraction);

		await clientOver(transport).fetchGuestManifest("try-site");

		assertMatchesPactRequest(recordedRequest(transport), manifestInteraction);
	});

	it("parses the recorded manifest into a bounded record", async () => {
		const transport = transportReplaying(manifestInteraction);

		const manifest = await clientOver(transport).fetchGuestManifest("try-site");

		expect(manifest.guestId).toBe("try-site");
		expect(manifest.resourceClass).toBe("browser-wasm:guest");
		expect(manifest.componentPath).toBe(
			"/_hobo/guests/try-site/component.wasm",
		);
		expect(manifest.contentDigest).toMatch(/^sha256-[0-9a-f]{64}$/u);
		expect(manifest.exports).toContain("wasi:http/incoming-handler@0.2.0");
	});

	it("refuses a manifest served for one guest that describes another", async () => {
		const transport = transportReplaying(manifestInteraction);

		await expect(
			clientOver(transport).fetchGuestManifest("other-guest"),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("maps the pact's GUEST_NOT_FOUND fault onto BUNDLE_UNAVAILABLE", async () => {
		const transport = transportReplaying(interaction("GUEST_NOT_FOUND"));

		await expect(
			clientOver(transport).fetchGuestManifest("ghost"),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "BUNDLE_UNAVAILABLE" &&
				error.detail.faultCode === "GUEST_NOT_FOUND",
		);
	});
});

describe("the component bundle, verified against the pact", () => {
	async function manifestFrom(): Promise<GuestManifest> {
		return clientOver(
			transportReplaying(interaction("serve the guest manifest")),
		).fetchGuestManifest("try-site");
	}

	it("verifies the recorded bytes against the recorded digest with real Web Crypto", async () => {
		const manifest = await manifestFrom();
		const bundle = interaction("serve the component bundle");
		const transport = transportReplaying(bundle);

		const { artifact, bytes } =
			await clientOver(transport).fetchComponent(manifest);

		assertMatchesPactRequest(recordedRequest(transport), bundle);
		expect(bytes.byteLength).toBe(8);
		expect(artifact.contentDigest).toBe(manifest.contentDigest);
		expect(artifact.componentModel).toBe(true);
	});

	it("refuses the single-page-app document a misconfigured origin serves instead of a 404", async () => {
		// A 200 `text/html` where a `.wasm` should be is the most common way a
		// static host answers a missing asset, and `compileStreaming` would
		// reject it several layers deeper.
		const manifest = await manifestFrom();
		const transport = transportReplaying(
			interaction("single-page-app document"),
		);

		await expect(
			clientOver(transport).fetchComponent(manifest),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "BUNDLE_NOT_A_COMPONENT",
		);
	});

	it("refuses bytes whose digest does not match the manifest", async () => {
		const manifest = await manifestFrom();
		const transport = transportReplaying(
			interaction("not the ones the manifest describes"),
		);

		await expect(
			clientOver(transport).fetchComponent(manifest),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "BUNDLE_DIGEST_MISMATCH",
		);
	});

	it("refuses a core module whose digest is perfectly correct", async () => {
		// The digest agrees; the bundle is still a core module, which would fail
		// component instantiation with a message that reads like a host bug.
		const manifest = await clientOver(
			transportReplaying(interaction("core module rather than a component")),
		).fetchGuestManifest("legacy-module");
		const transport = transportReplaying(interaction("serve that core module"));

		await expect(
			clientOver(transport).fetchComponent(manifest),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "BUNDLE_NOT_A_COMPONENT",
		);
	});
});

describe("provisioning end to end, replayed from the pact", () => {
	it("reads capabilities, manifest and bundle, then instantiates", async () => {
		const transport = transportReplaying(
			interaction("cross-origin isolated context"),
			interaction("serve the guest manifest"),
			interaction("serve the component bundle"),
		);
		const runtime = runtimeProviding(HOST_IMPORTS);

		const receipt = await provisionGuest({
			client: clientOver(transport),
			runtime,
			placement,
		});

		expect(transport.requests.map(pathOf)).toEqual([
			"/_hobo/host/capabilities",
			"/_hobo/guests/try-site/manifest.json",
			"/_hobo/guests/try-site/component.wasm",
		]);
		expect(receipt.schemaVersion).toBe("hobo.provider-browser-wasm.receipt/v1");
		expect(receipt.effectivePersistence).toBe("opfs-sahpool");
		expect(receipt.handle.phase).toBe("running");
		expect(receipt.handle.partitionId).toBe("guest-try-site");
		expect(runtime.instantiations).toHaveLength(1);
	});

	it("never fetches the bundle when the host cannot supply an import it needs", async () => {
		// The manifest says what the guest needs and the host knows what it
		// supplies, so the refusal happens before a byte of guest code is
		// downloaded, let alone linked.
		const transport = transportReplaying(
			interaction("cross-origin isolated context"),
			interaction("serve the guest manifest"),
		);

		await expect(
			provisionGuest({
				client: clientOver(transport),
				runtime: runtimeProviding(["wasi:io/streams@0.2.0"]),
				placement,
			}),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) && error.code === "HOST_UNSUPPORTED",
		);
		expect(transport.requests).toHaveLength(2);
	});

	it("refuses durable placement in the private-mode context the pact records", async () => {
		// The refusal lands before the bundle is downloaded: persistence is
		// negotiated as soon as the manifest is in hand.
		const transport = transportReplaying(
			interaction("private-mode context"),
			interaction("serve the guest manifest"),
		);

		await expect(
			provisionGuest({
				client: clientOver(transport),
				runtime: runtimeProviding(HOST_IMPORTS),
				placement,
			}),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "PERSISTENCE_UNAVAILABLE",
		);
	});

	it("downgrades to transient memory only when the caller asked for that", async () => {
		const transport = transportReplaying(
			interaction("private-mode context"),
			interaction("serve the guest manifest"),
			interaction("serve the component bundle"),
		);

		const receipt = await provisionGuest({
			client: clientOver(transport),
			runtime: runtimeProviding(HOST_IMPORTS),
			placement,
			allowTransient: true,
		});

		expect(receipt.placement.persistence).toBe("opfs-sahpool");
		expect(receipt.effectivePersistence).toBe("transient-memory");
		// The downgrade is legible in the receipt and the handle holds no
		// partition, so nothing downstream can claim durability.
		expect(receipt.handle.partitionId).toBe("");
	});

	it("refuses shared memory in a context that is not cross-origin isolated", async () => {
		const transport = transportReplaying(interaction("private-mode context"));

		await expect(
			provisionGuest({
				client: clientOver(transport),
				runtime: runtimeProviding(HOST_IMPORTS),
				placement: parseGuestPlacement({
					guestId: "try-site",
					persistence: "transient-memory",
					sharedMemory: true,
				}),
			}),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) && error.code === "HOST_UNSUPPORTED",
		);
	});
});

describe("release", () => {
	async function provisioned() {
		const runtime = runtimeProviding(HOST_IMPORTS);
		const receipt = await provisionGuest({
			client: clientOver(
				transportReplaying(
					interaction("cross-origin isolated context"),
					interaction("serve the guest manifest"),
					interaction("serve the component bundle"),
				),
			),
			runtime,
			placement,
		});
		return { runtime, receipt };
	}

	it("reports released when the worker stopped and the partition went", async () => {
		const { runtime, receipt } = await provisioned();

		const outcome = await releaseGuest({
			runtime,
			receipt,
			now: () => Date.UTC(2026, 7, 8, 13, 0, 0),
		});

		expect(outcome.state).toBe("released");
		expect(outcome.partitionDropped).toBe(true);
	});

	it("reports retained, with a reason, when the partition is kept", async () => {
		const { runtime, receipt } = await provisioned();

		const outcome = await releaseGuest({
			runtime,
			receipt,
			now: () => Date.UTC(2026, 7, 8, 13, 0, 0),
			retainPartition: true,
		});

		expect(outcome.state).toBe("retained");
		expect(outcome.retainedReason).toBe("partition-reuse");
	});

	it("refuses to call cleanup done while the worker is still up", async () => {
		const { receipt } = await provisioned();
		const stubborn = runtimeProviding(HOST_IMPORTS, {
			workerTerminated: false,
		});

		await expect(
			releaseGuest({
				runtime: stubborn,
				receipt,
				now: () => Date.UTC(2026, 7, 8, 13, 0, 0),
			}),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) &&
				error.code === "CLEANUP_INCOMPLETE",
		);
	});
});

describe("the default runtime", () => {
	it("refuses to instantiate rather than pretend a guest ran", async () => {
		// Outside a browser there is no runtime, and a stand-in that "ran" the
		// guest would make every downstream receipt a claim about an
		// instantiation that never happened.
		const runtime = createUnavailableRuntime("this is not a browser");

		expect(runtime.providedImports).toEqual([]);
		await expect(
			runtime.terminate({
				guestId: "try-site",
				workerName: "",
				partitionId: "",
				dropPartition: true,
			}),
		).rejects.toSatisfy(
			(error: Error) =>
				isBrowserWasmProviderError(error) && error.code === "HOST_UNSUPPORTED",
		);
	});
});

describe("negotiatePersistence", () => {
	it("never upgrades what the host reported", () => {
		expect(
			negotiatePersistence({
				placement,
				host: {
					origin: HOST_ORIGIN,
					crossOriginIsolated: true,
					dedicatedWorkers: true,
					persistence: "transient-memory",
					maxMemoryBytes: 1_073_741_824,
				},
				allowTransient: true,
			}),
		).toBe("transient-memory");
	});
});
