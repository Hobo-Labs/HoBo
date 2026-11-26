import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json-inspect.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ASSET = /^[a-z0-9][a-z0-9._-]*$/u;

export interface BrowserRuntimeManifest {
	readonly schemaVersion: "hobo.browser-wit-runtime/v1";
	readonly entryModule: string;
	readonly componentDigest: `sha256:${string}`;
	readonly sourceDigest: `sha256:${string}`;
	readonly buildDigest: `sha256:${string}`;
	readonly witWorld: "hobo:try/browser-station@0.1.0";
	readonly toolchain: BrowserRuntimeToolchain;
	readonly assets: readonly string[];
	readonly assetDigests: Sha256DigestMap;
}

export interface BrowserRuntimeToolchain {
	readonly jco: string;
	readonly componentizeJs: string;
	readonly esbuild: string;
}

export interface Sha256DigestMap {
	readonly [asset: string]: `sha256:${string}`;
}

interface MutableSha256DigestMap {
	[asset: string]: `sha256:${string}`;
}

export function parseBrowserRuntimeManifest(
	value: JsonValue,
): BrowserRuntimeManifest {
	if (!isJsonObject(value)) {
		throw new TypeError("Browser WIT runtime manifest must be an object");
	}
	if (value.schemaVersion !== "hobo.browser-wit-runtime/v1") {
		throw new TypeError("Browser WIT runtime schemaVersion is invalid");
	}
	if (
		value.witWorld !== "hobo:try/browser-station@0.1.0" ||
		!isJsonString(value.entryModule) ||
		!value.entryModule.endsWith(".js") ||
		!ASSET.test(value.entryModule) ||
		!isDigest(value.componentDigest) ||
		!isDigest(value.sourceDigest) ||
		!isDigest(value.buildDigest)
	) {
		throw new TypeError("Browser WIT runtime provenance is invalid");
	}
	const assets = parseAssets(value.assets, value.entryModule);
	const assetDigests = parseAssetDigests(
		value.assetDigests,
		assets,
		value.componentDigest,
	);
	const toolchain = parseToolchain(value.toolchain);
	return {
		schemaVersion: "hobo.browser-wit-runtime/v1",
		entryModule: value.entryModule,
		componentDigest: value.componentDigest,
		sourceDigest: value.sourceDigest,
		buildDigest: value.buildDigest,
		witWorld: "hobo:try/browser-station@0.1.0",
		toolchain,
		assets,
		assetDigests,
	};
}

function parseAssets(
	value: JsonValue | undefined,
	entryModule: string,
): string[] {
	if (!isJsonArray(value) || value.length === 0) {
		throw new TypeError("Browser WIT runtime assets are invalid");
	}
	const assets: string[] = [];
	for (const asset of value) {
		if (!isJsonString(asset) || !ASSET.test(asset)) {
			throw new TypeError("Browser WIT runtime assets are invalid");
		}
		assets.push(asset);
	}
	if (
		new Set(assets).size !== assets.length ||
		!assets.includes(entryModule) ||
		!assets.includes("station.component.wasm")
	) {
		throw new TypeError("Browser WIT runtime assets are invalid");
	}
	return assets;
}

function parseAssetDigests(
	value: JsonValue | undefined,
	assets: readonly string[],
	componentDigest: `sha256:${string}`,
): Sha256DigestMap {
	if (!isJsonObject(value)) {
		throw new TypeError("Browser WIT runtime assetDigests are invalid");
	}
	if (Object.keys(value).sort().join("\0") !== [...assets].sort().join("\0")) {
		throw new TypeError("Browser WIT runtime assetDigests are invalid");
	}
	const assetDigests: MutableSha256DigestMap = {};
	for (const asset of assets) {
		const digest = value[asset];
		if (!isDigest(digest)) {
			throw new TypeError("Browser WIT runtime assetDigests are invalid");
		}
		assetDigests[asset] = digest;
	}
	if (assetDigests["station.component.wasm"] !== componentDigest) {
		throw new TypeError("Browser WIT runtime assetDigests are invalid");
	}
	return assetDigests;
}

function parseToolchain(
	value: JsonValue | undefined,
): BrowserRuntimeToolchain {
	if (!isJsonObject(value)) {
		throw new TypeError("Browser WIT runtime toolchain is invalid");
	}
	if (
		!isJsonString(value.jco) ||
		!isJsonString(value.componentizeJs) ||
		!isJsonString(value.esbuild)
	) {
		throw new TypeError("Browser WIT runtime toolchain is invalid");
	}
	return {
		jco: value.jco,
		componentizeJs: value.componentizeJs,
		esbuild: value.esbuild,
	};
}

function isDigest(value: JsonValue | undefined): value is `sha256:${string}` {
	return isJsonString(value) && DIGEST.test(value);
}
