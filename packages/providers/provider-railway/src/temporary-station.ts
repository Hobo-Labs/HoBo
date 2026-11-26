import type { TemporaryEnvironmentStationResult } from "@hobo/core";
import { PROVIDER_TARGET } from "./options.js";

export const supportsAnonymousTemporaryDeploy = false as const;

export const TEMPORARY_PROVISION_UNAVAILABLE_CODE =
	"HOBO_TEMP_PROVISION_UNAVAILABLE" as const;

const REFUSAL_REASON =
	"Railway has no password-free Temporary Accounts / agent provision API. Examples fail closed — no permanent tokens.";

// domain-view: richer than the wire form — `code` and the support flag are literal types, so a refusal cannot claim `supportsAnonymousTemporaryDeploy: true`. No buf codegen is wired here, so data-models/provider_railway.proto is the design-time view of this record.
export type RailwayTemporaryStationRefusal = {
	readonly providerId: typeof PROVIDER_TARGET;
	readonly code: typeof TEMPORARY_PROVISION_UNAVAILABLE_CODE;
	readonly supportsAnonymousTemporaryDeploy: false;
	readonly reason: string;
};

export function railwayTemporaryStationRefusal(): RailwayTemporaryStationRefusal {
	return Object.freeze({
		providerId: PROVIDER_TARGET,
		code: TEMPORARY_PROVISION_UNAVAILABLE_CODE,
		supportsAnonymousTemporaryDeploy: false,
		reason: REFUSAL_REASON,
	});
}

export class TemporaryProvisionUnavailableError extends Error {
	readonly code = TEMPORARY_PROVISION_UNAVAILABLE_CODE;
	readonly refusal: RailwayTemporaryStationRefusal;

	constructor(refusal: RailwayTemporaryStationRefusal) {
		super(refusal.reason);
		this.name = "TemporaryProvisionUnavailableError";
		this.refusal = refusal;
	}
}

export async function provisionTemporaryEnvironmentStation(_input: {
	readonly stationId: string;
}): Promise<TemporaryEnvironmentStationResult> {
	throw new TemporaryProvisionUnavailableError(
		railwayTemporaryStationRefusal(),
	);
}
