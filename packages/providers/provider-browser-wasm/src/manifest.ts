/**
 * Parse-don't-validate boundary for everything the host origin says.
 *
 * Three documents cross it — the host's capability report, the guest manifest,
 * and the component bytes — and each becomes a derived domain type here or
 * becomes an error. Downstream code never sees a response, a header bag, or a
 * `Uint8Array` it has to check again.
 *
 * The digest is the load-bearing one. A manifest is a claim about bytes;
 * `verifyComponentArtifact` is where the claim is settled, which is the only
 * reason the rest of the package may treat the bundle as the thing the
 * manifest described.
 */
import {
	BrowserWasmProviderError,
	contractChanged,
	redactHostText,
} from "./errors.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { decodeText, headerOf } from "./transport.js";

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u;
const CONTENT_DIGEST = /^sha256-[0-9a-f]{64}$/u;
const WIT_ID =
	/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?(@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)?$/u;
const SAME_ORIGIN_PATH = /^\/[A-Za-z0-9._~/-]{1,512}$/u;

// public-contract: versions host capability manifests.
export const HOST_CAPABILITIES_SCHEMA =
	"hobo.browser-wasm.host-capabilities/v1";
// public-contract: versions browser guest manifests.
export const GUEST_MANIFEST_SCHEMA = "hobo.browser-wasm.guest-manifest/v1";
// public-contract: versions browser host fault reports.
export const HOST_FAULT_SCHEMA = "hobo.browser-wasm.host-fault/v1";

export const PERSISTENCE_MODES = [
	"opfs-sahpool",
	"transient-memory",
	"unavailable",
] as const;
export type PersistenceMode = (typeof PERSISTENCE_MODES)[number];

export const GUEST_PORTS = ["compute", "kv", "queue"] as const;
export type GuestPort = (typeof GUEST_PORTS)[number];

export const RESOURCE_CLASS_FOR_PORT = {
	compute: "browser-wasm:guest",
	kv: "browser-wasm:kv",
	queue: "browser-wasm:queue",
} as const;

function isGuestPort(value: string): value is GuestPort {
	switch (value) {
		case "compute":
		case "kv":
		case "queue":
			return true;
		default:
			return false;
	}
}

function isPersistenceMode(value: string): value is PersistenceMode {
	switch (value) {
		case "opfs-sahpool":
		case "transient-memory":
		case "unavailable":
			return true;
		default:
			return false;
	}
}

/** 64 KiB — the WebAssembly page. Memory limits are whole pages or nothing. */
export const WASM_PAGE_BYTES = 65_536;
export const MIN_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
export const MAX_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;
export const MIN_COMPONENT_BYTES = 8;
export const MAX_COMPONENT_BYTES = 64 * 1024 * 1024;

// public-contract: accepted media type for guest components.
export const COMPONENT_MEDIA_TYPE = "application/wasm";

export type HostCapabilities = {
	readonly origin: string;
	readonly crossOriginIsolated: boolean;
	readonly dedicatedWorkers: boolean;
	readonly persistence: PersistenceMode;
	readonly maxMemoryBytes: number;
};

export type GuestManifest = {
	readonly guestId: string;
	readonly port: GuestPort;
	readonly resourceClass: string;
	readonly world: string;
	readonly componentPath: string;
	readonly contentDigest: string;
	readonly byteLength: number;
	readonly imports: readonly string[];
	readonly exports: readonly string[];
	readonly persistence: PersistenceMode;
	readonly memoryLimitBytes: number;
	readonly sharedMemory: boolean;
};

export type ComponentArtifact = {
	readonly contentDigest: string;
	readonly byteLength: number;
	readonly mediaType: string;
	readonly componentModel: true;
};

export type HostFault = {
	readonly code: "GUEST_NOT_FOUND" | "BUNDLE_UNAVAILABLE" | "HOST_UNSUPPORTED";
	readonly message: string;
	readonly guestId: string;
};

/** `(bytes) => "sha256-<hex>"`. Injected so the digest is never assumed. */
export type DigestPort = (bytes: Uint8Array) => Promise<string>;

/**
 * The Web Crypto digest, which is what a browser has. Node exposes the same
 * `crypto.subtle` on `globalThis`, so this is also what the tests run.
 */
export function createWebCryptoDigest(
	subtle: SubtleCrypto = globalThis.crypto.subtle,
): DigestPort {
	return async (bytes) => {
		const buffer = await subtle.digest("SHA-256", bytes.slice());
		const hex = Array.from(new Uint8Array(buffer))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		return `sha256-${hex}`;
	};
}

function decodeJsonObject(body: Uint8Array, what: string): JsonObject {
	const text = decodeText(body);
	let decoded: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		decoded = JSON.parse(text) as JsonValue;
	} catch {
		contractChanged(`${what} was not JSON`, {
			preview: redactHostText(text, 80),
		});
	}
	if (!isJsonObject(decoded)) {
		contractChanged(`${what} was not a JSON object`);
	}
	return decoded;
}

function requireSchema(record: JsonObject, schema: string, what: string): void {
	if (record.schemaVersion !== schema) {
		// A missing or different schema id is a contract change, not something
		// to shrug at: the fields below are only meaningful under this one.
		contractChanged(
			`${what} declares schema ${redactHostText(String(record.schemaVersion), 64)} instead of ${schema}`,
		);
	}
}

function requireBoolean(
	record: JsonObject,
	key: string,
	what: string,
): boolean {
	const value = record[key];
	if (!isJsonBoolean(value)) {
		contractChanged(`${what} field ${key} is not a boolean`);
	}
	return value;
}

function requireMemoryLimit(
	record: JsonObject,
	key: string,
	what: string,
): number {
	const value = record[key];
	if (
		!isJsonNumber(value) ||
		!Number.isInteger(value) ||
		value < MIN_MEMORY_LIMIT_BYTES ||
		value > MAX_MEMORY_LIMIT_BYTES
	) {
		contractChanged(
			`${what} field ${key} is not a memory limit in ${MIN_MEMORY_LIMIT_BYTES}..${MAX_MEMORY_LIMIT_BYTES} bytes`,
		);
	}
	if (value % WASM_PAGE_BYTES !== 0) {
		// The engine rounds up to a whole page. Keeping the unrounded number
		// would make every receipt disagree with the memory the guest got.
		contractChanged(
			`${what} field ${key} is not a whole number of ${WASM_PAGE_BYTES} byte pages`,
		);
	}
	return value;
}

function requirePersistence(record: JsonObject, what: string): PersistenceMode {
	const value = record.persistence;
	if (!isJsonString(value) || !isPersistenceMode(value)) {
		contractChanged(
			`${what} reports persistence ${redactHostText(String(value), 32)}, which is not one of the documented modes`,
		);
	}
	return value;
}

function requireWitIds(
	record: JsonObject,
	key: string,
	what: string,
): readonly string[] {
	const value = record[key];
	if (value === undefined) return [];
	if (!isJsonArray(value)) {
		contractChanged(`${what} field ${key} is not a list`);
	}
	return value.map((entry) => {
		if (!isJsonString(entry) || !WIT_ID.test(entry)) {
			contractChanged(
				`${what} field ${key} holds ${redactHostText(String(entry), 64)}, which is not a WIT interface id`,
			);
		}
		return entry;
	});
}

/** Parse `GET /_hobo/host/capabilities`. */
export function parseHostCapabilities(body: Uint8Array): HostCapabilities {
	const record = decodeJsonObject(body, "host capabilities");
	requireSchema(record, HOST_CAPABILITIES_SCHEMA, "host capabilities");

	const origin = record.origin;
	if (!isJsonString(origin)) {
		contractChanged("host capabilities origin is not a string");
	}
	let parsedOrigin: URL;
	try {
		parsedOrigin = new URL(origin);
	} catch {
		contractChanged("host capabilities origin is not a URL");
	}
	if (parsedOrigin.origin !== origin) {
		contractChanged("host capabilities origin carries a path or query");
	}

	const dedicatedWorkers = requireBoolean(
		record,
		"dedicatedWorkers",
		"host capabilities",
	);
	const persistence = requirePersistence(record, "host capabilities");
	if (persistence === "opfs-sahpool" && !dedicatedWorkers) {
		// OPFS sync access handles are worker-only. A host claiming durable
		// storage without workers is describing something it cannot do.
		contractChanged(
			"host reports durable OPFS persistence without dedicated workers",
		);
	}

	return {
		origin,
		crossOriginIsolated: requireBoolean(
			record,
			"crossOriginIsolated",
			"host capabilities",
		),
		dedicatedWorkers,
		persistence,
		maxMemoryBytes: requireMemoryLimit(
			record,
			"maxMemoryBytes",
			"host capabilities",
		),
	};
}

/** Parse `GET /_hobo/guests/{guestId}/manifest.json`. */
export function parseGuestManifest(
	body: Uint8Array,
	expected: { readonly guestId: string },
): GuestManifest {
	const record = decodeJsonObject(body, "guest manifest");
	requireSchema(record, GUEST_MANIFEST_SCHEMA, "guest manifest");

	const guestId = record.guestId;
	if (!isJsonString(guestId) || !DNS_1123_LABEL.test(guestId)) {
		contractChanged("guest manifest guestId is not an RFC 1123 label");
	}
	if (guestId !== expected.guestId) {
		// Serving a different guest's manifest under this guest's path is
		// exactly how the wrong component gets instantiated.
		contractChanged(
			`guest manifest describes ${guestId} but was served for ${expected.guestId}`,
		);
	}

	const port = record.port;
	if (!isJsonString(port) || !isGuestPort(port)) {
		contractChanged(
			`guest manifest port ${redactHostText(String(port), 32)} is not one this provider serves`,
		);
	}
	const resourceClass = record.resourceClass;
	if (resourceClass !== RESOURCE_CLASS_FOR_PORT[port]) {
		contractChanged(
			`guest manifest resourceClass does not match its ${port} port`,
		);
	}

	const world = record.world;
	if (!isJsonString(world) || !WIT_ID.test(world)) {
		contractChanged("guest manifest world is not a WIT world id");
	}

	const componentPath = record.componentPath;
	if (
		!isJsonString(componentPath) ||
		!SAME_ORIGIN_PATH.test(componentPath) ||
		!componentPath.endsWith(".wasm")
	) {
		contractChanged(
			"guest manifest componentPath is not a same-origin .wasm path",
		);
	}
	if (!componentPath.startsWith(`/_hobo/guests/${guestId}/`)) {
		contractChanged(
			`guest manifest componentPath points outside ${guestId}'s own bundle directory`,
		);
	}

	const contentDigest = record.contentDigest;
	if (!isJsonString(contentDigest) || !CONTENT_DIGEST.test(contentDigest)) {
		contractChanged(
			"guest manifest contentDigest is not a sha256-<hex> digest",
		);
	}

	const byteLength = record.byteLength;
	if (
		!isJsonNumber(byteLength) ||
		!Number.isInteger(byteLength) ||
		byteLength < MIN_COMPONENT_BYTES ||
		byteLength > MAX_COMPONENT_BYTES
	) {
		contractChanged(
			`guest manifest byteLength is outside ${MIN_COMPONENT_BYTES}..${MAX_COMPONENT_BYTES}`,
		);
	}

	const exports = requireWitIds(record, "exports", "guest manifest");
	if (exports.length === 0) {
		contractChanged("guest manifest exports nothing, so nothing can call it");
	}

	return {
		guestId,
		port,
		resourceClass,
		world,
		componentPath,
		contentDigest,
		byteLength,
		imports: requireWitIds(record, "imports", "guest manifest"),
		exports,
		persistence: requirePersistence(record, "guest manifest"),
		memoryLimitBytes: requireMemoryLimit(
			record,
			"memoryLimitBytes",
			"guest manifest",
		),
		sharedMemory: requireBoolean(record, "sharedMemory", "guest manifest"),
	};
}

/** Parse the host origin's error envelope. */
export function parseHostFault(body: Uint8Array): HostFault {
	const record = decodeJsonObject(body, "host fault");
	requireSchema(record, HOST_FAULT_SCHEMA, "host fault");
	const code = record.code;
	if (
		code !== "GUEST_NOT_FOUND" &&
		code !== "BUNDLE_UNAVAILABLE" &&
		code !== "HOST_UNSUPPORTED"
	) {
		contractChanged(
			`host fault code ${redactHostText(String(code), 32)} is not one of the documented codes`,
		);
	}
	const guestId = record.guestId;
	if (!isJsonString(guestId) || !DNS_1123_LABEL.test(guestId)) {
		contractChanged("host fault guestId is not an RFC 1123 label");
	}
	return {
		code,
		message: isJsonString(record.message)
			? redactHostText(record.message, 512)
			: "",
		guestId,
	};
}

/**
 * The component-model preamble: `\0asm`, version 0x0d, layer 0x01.
 *
 * A core module has the same four magic bytes and layer 0. Handing one to a
 * component instantiation fails deep inside the runtime with a message that
 * reads like a host bug, so it is caught here instead.
 */
export function isComponentPreamble(bytes: Uint8Array): boolean {
	if (bytes.byteLength < MIN_COMPONENT_BYTES) return false;
	return (
		bytes[0] === 0x00 &&
		bytes[1] === 0x61 &&
		bytes[2] === 0x73 &&
		bytes[3] === 0x6d &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x00 &&
		bytes[6] === 0x01 &&
		bytes[7] === 0x00
	);
}

/**
 * Settle the manifest's claim about the bytes.
 *
 * Everything downstream is allowed to treat the bundle as "the component the
 * manifest described" precisely because this function ran and agreed.
 */
export async function verifyComponentArtifact(input: {
	readonly bytes: Uint8Array;
	readonly headers: Readonly<Record<string, string>>;
	readonly manifest: GuestManifest;
	readonly digest: DigestPort;
}): Promise<ComponentArtifact> {
	const { bytes, headers, manifest } = input;

	const mediaType = (headerOf(headers, "content-type") ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
	if (mediaType !== COMPONENT_MEDIA_TYPE) {
		// `WebAssembly.compileStreaming` rejects anything else, so accepting a
		// different type here would only move the failure later — and past the
		// point where the diagnosis is obvious.
		throw new BrowserWasmProviderError(
			"BUNDLE_NOT_A_COMPONENT",
			`the host served the bundle as ${redactHostText(mediaType ?? "", 64) || "no media type"}, not ${COMPONENT_MEDIA_TYPE}`,
			{ detail: { guestId: manifest.guestId } },
		);
	}

	if (bytes.byteLength !== manifest.byteLength) {
		throw new BrowserWasmProviderError(
			"BUNDLE_DIGEST_MISMATCH",
			`the bundle is ${bytes.byteLength} bytes; the manifest declared ${manifest.byteLength}`,
			{ detail: { guestId: manifest.guestId } },
		);
	}

	const contentDigest = await input.digest(bytes);
	if (contentDigest !== manifest.contentDigest) {
		throw new BrowserWasmProviderError(
			"BUNDLE_DIGEST_MISMATCH",
			`the bundle digest does not match the manifest for ${manifest.guestId}`,
			{
				detail: {
					guestId: manifest.guestId,
					expected: manifest.contentDigest,
					actual: contentDigest,
				},
			},
		);
	}

	if (!isComponentPreamble(bytes)) {
		throw new BrowserWasmProviderError(
			"BUNDLE_NOT_A_COMPONENT",
			`${manifest.guestId} is not a WebAssembly component`,
			{ detail: { guestId: manifest.guestId } },
		);
	}

	return Object.freeze({
		contentDigest,
		byteLength: bytes.byteLength,
		mediaType: COMPONENT_MEDIA_TYPE,
		componentModel: true as const,
	});
}
