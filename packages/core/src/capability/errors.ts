import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";
import type { CapabilityDenialCode } from "./types.js";

export class CapabilityParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_CAPABILITY_PARSE", path, expected, received, message);
		this.name = "CapabilityParseError";
	}
}

export class CapabilityDeniedError extends Error {
	readonly code: CapabilityDenialCode;
	readonly componentId?: string;
	readonly importInterface?: string;
	readonly operation?: string;
	readonly resource?: string;
	readonly providerId?: string;
	readonly exportInterface?: string;

	constructor(
		code: CapabilityDenialCode,
		details: {
			componentId?: string;
			importInterface?: string;
			operation?: string;
			resource?: string;
			providerId?: string;
			exportInterface?: string;
		} = {},
	) {
		super(
			`${code}: ${details.componentId ?? "unknown"}:${details.importInterface ?? "unknown"}`,
		);
		this.name = "CapabilityDeniedError";
		this.code = code;
		if (details.componentId !== undefined)
			this.componentId = details.componentId;
		if (details.importInterface !== undefined)
			this.importInterface = details.importInterface;
		if (details.operation !== undefined) this.operation = details.operation;
		if (details.resource !== undefined) this.resource = details.resource;
		if (details.providerId !== undefined) this.providerId = details.providerId;
		if (details.exportInterface !== undefined)
			this.exportInterface = details.exportInterface;
	}
}
