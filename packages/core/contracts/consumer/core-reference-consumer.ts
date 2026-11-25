import type {
	PactRequest,
	PactResponse,
	ProviderStub,
} from "@hobo/contract-harness";
// The package's json helpers live in src/, not beside this consumer — the
// anti-slop sweep (#1242) rewrote this import to the by-convention "./json.js"
// and left the whole contract suite failing at module resolution ever since.
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../../src/json.js";

export interface CoreContractSurface {
	readonly schemaVersion: "hobo.core/v1";
	readonly eventMappings: { readonly cloudEventSpecversion: "1.0" };
	readonly publicSurface: { readonly ok: true };
}

export class CoreContractSurfaceParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoreContractSurfaceParseError";
	}
}

export function parseCoreContractSurface(body: JsonValue): CoreContractSurface {
	if (!isJsonObject(body) || body === null || Array.isArray(body)) {
		throw new CoreContractSurfaceParseError("response body must be an object");
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const record = body as JsonObject;
	if (record.schemaVersion !== "hobo.core/v1") {
		throw new CoreContractSurfaceParseError(
			`unsupported schemaVersion: ${String(record.schemaVersion)}`,
		);
	}

	const eventMappings = record.eventMappings;
	if (
		!isJsonObject(eventMappings) ||
		eventMappings === null ||
		Array.isArray(eventMappings) ||
		// SAFETY: assertion required at this I/O or test boundary.
		(eventMappings as JsonObject).cloudEventSpecversion !== "1.0"
	) {
		throw new CoreContractSurfaceParseError(
			"invalid eventMappings.cloudEventSpecversion",
		);
	}

	const publicSurface = record.publicSurface;
	if (
		!isJsonObject(publicSurface) ||
		publicSurface === null ||
		Array.isArray(publicSurface) ||
		// SAFETY: assertion required at this I/O or test boundary.
		(publicSurface as JsonObject).ok !== true
	) {
		throw new CoreContractSurfaceParseError("invalid publicSurface.ok");
	}

	return {
		schemaVersion: "hobo.core/v1",
		eventMappings: { cloudEventSpecversion: "1.0" },
		publicSurface: { ok: true },
	};
}

export async function fetchCoreContractSurface(
	provider: ProviderStub,
	body?: JsonValue,
): Promise<CoreContractSurface> {
	const request: PactRequest = {
		method: "POST",
		path: "/core/contract-surface",
		...(body === undefined ? undefined : { body }),
	};

	const response: PactResponse = await provider.handle(request);
	if (response.status !== 200) {
		throw new CoreContractSurfaceParseError(
			`unexpected status ${response.status}`,
		);
	}

	return parseCoreContractSurface(response.body);
}

export async function fetchUnsupportedSchemaError(
	provider: ProviderStub,
	schemaVersion: string,
): Promise<{ code: string; message: string }> {
	const response = await provider.handle({
		method: "POST",
		path: "/core/contract-surface",
		body: { schemaVersion },
	});

	if (response.status !== 400) {
		throw new Error(`expected status 400, got ${response.status}`);
	}

	const body = response.body;
	if (!isJsonObject(body) || body === null || Array.isArray(body)) {
		throw new Error("error response body must be an object");
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const error = (body as JsonObject).error;
	if (!isJsonObject(error) || error === null || Array.isArray(error)) {
		throw new Error("error envelope missing");
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const record = error as JsonObject;
	if (!isJsonString(record.code) || !isJsonString(record.message)) {
		throw new Error("error envelope must include code and message");
	}

	return { code: record.code, message: record.message };
}
