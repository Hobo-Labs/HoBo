export * from "./canonical.js";
export * from "./conformance.js";
export * from "./crash-injection.js";
export * from "./custody.js";
export * from "./digest.js";
export * from "./envelope.js";
export * from "./errors.js";
export * from "./executors/copy.js";
export * from "./executors/event-log.js";
export * from "./executors/in-place.js";
export * from "./executors/runtime.js";
export * from "./facts.js";
export {
	canonicalEncode,
	digestOf,
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonText,
	sha256Hex,
} from "./json.js";
export * from "./patterns.js";
export * from "./reference-engine.js";
export * from "./selector.js";
export * from "./spi.js";
export * from "./type-mapping.js";

// public-contract: package id consumers assert against.
export const HOBO_DATA_CORE_PACKAGE = "@hobo/data-core";
