// The componentize build recipe for resolver components.
//
//   1. Author a guest against `@hobo/resolver-components/guest` and the WIT
//      world in `wit/resolver.wit` (`hobo:resolver/resolver-component`).
//   2. `componentizeResolver` turns the guest source into component bytes:
//      the real lane (`real: true`) runs the pinned componentize-js toolchain
//      through @hobo/componentize and fails closed if it is missing; the
//      default lane emits deterministic contract bytes (wasm header plus a
//      `hobo.resolver.contract` custom section binding the source digest),
//      the same honest-scope floor as @hobo/componentize.
//   3. `buildResolverComponent` stamps the bytes' digest into the manifest,
//      parses it, and returns the registry bundle manifest to sign.
//   4. The publisher signs the registry manifest digest with its identity
//      issuer (`codeVersion.digest`), and ships the bundle.
import { createHash } from "node:crypto";
import {
	createRealComponentize,
	type RealComponentizeOptions,
} from "@hobo/componentize";
import { canonicalJson } from "@hobo/core";
import { bundleManifestDigest, ingestBundleManifest } from "@hobo/registry";
import { resolverRegistryManifest, wasmDigestOf } from "../bundle.js";
import { ResolverComponentError } from "../errors.js";
import type { JsonObject } from "../json.js";
import { type ComponentManifest, parseComponentManifest } from "../manifest.js";
import { RESOLVER_WIT_WORLD } from "../wit.js";

// public-contract: custom section carrying the contract metadata.
export const RESOLVER_CONTRACT_SECTION = "hobo.resolver.contract" as const;
// public-contract: schema id of the contract metadata.
export const RESOLVER_CONTRACT_SCHEMA = "hobo.resolver-components.contract/v1" as const;

export interface ComponentizeResolverInput {
	readonly componentId: string;
	readonly version: string;
	/** The guest source text (or a deterministic bundle of it). */
	readonly source: string;
}

/** Deterministic contract bytes for a guest source (synthetic lane). */
export function componentizeResolver(input: ComponentizeResolverInput): Uint8Array {
	const metadata = canonicalJson({
		schema: RESOLVER_CONTRACT_SCHEMA,
		world: RESOLVER_WIT_WORLD,
		componentId: input.componentId,
		version: input.version,
		sourceDigest: `sha256:${createHash("sha256").update(input.source).digest("hex")}`,
	});
	const name = Buffer.from(RESOLVER_CONTRACT_SECTION, "utf8");
	const payload = Buffer.concat([leb128(name.length), name, Buffer.from(metadata, "utf8")]);
	return Uint8Array.from(
		Buffer.concat([
			Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
			Buffer.from([0x00]),
			leb128(payload.length),
			payload,
		]),
	);
}

export interface RealComponentizeResolverInput {
	readonly sourceRoot: string;
	readonly sourceDateEpoch: string;
	readonly witSource: string;
	readonly entry?: string;
}

/**
 * Real lane: componentize-js against the resolver world. Throws
 * `ComponentizeToolchainError` (fail closed) when the toolchain is absent.
 */
export async function componentizeResolverReal(
	input: RealComponentizeResolverInput,
	options: Omit<RealComponentizeOptions, "wit" | "entry"> = {},
): Promise<Uint8Array> {
	const real = await createRealComponentize({
		...options,
		...(input.entry === undefined ? undefined : { entry: input.entry }),
		wit: {
			source: input.witSource,
			worldName: "resolver-component",
			witWorld: RESOLVER_WIT_WORLD,
		},
	});
	const result = await real.componentize({
		sourceRoot: input.sourceRoot,
		sourceDateEpoch: input.sourceDateEpoch,
	});
	return Uint8Array.from(result.component.bytes);
}

export interface BuiltResolverComponent {
	readonly wasm: Uint8Array;
	readonly manifest: ComponentManifest;
	readonly manifestJson: JsonObject;
	readonly registryManifest: JsonObject;
	/** What the publisher's attestation must carry as codeVersion.digest. */
	readonly registryDigest: string;
}

/** Stamp the bytes' digest into the manifest and derive what to sign. */
export function buildResolverComponent(
	manifestJson: JsonObject,
	wasm: Uint8Array,
): BuiltResolverComponent {
	const stamped: JsonObject = { ...manifestJson, wasmDigest: wasmDigestOf(wasm) };
	const manifest = parseComponentManifest(stamped);
	const registryManifest = resolverRegistryManifest(manifest);
	const ingested = ingestBundleManifest(registryManifest);
	if (!ingested.ok)
		throw new ResolverComponentError(
			"component.manifest-invalid",
			ingested.errors.map((error) => error.message).join("; "),
			manifest.id,
		);
	return Object.freeze({
		wasm,
		manifest,
		manifestJson: stamped,
		registryManifest,
		registryDigest: bundleManifestDigest(ingested.manifest),
	});
}

function leb128(value: number): Buffer {
	const bytes: number[] = [];
	let rest = value;
	do {
		let byte = rest & 0x7f;
		rest >>>= 7;
		if (rest !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (rest !== 0);
	return Buffer.from(bytes);
}
