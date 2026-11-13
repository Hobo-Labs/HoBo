// The fleet-envelope form of a workload attestation's host signature (design
// §7.4, context `hobo-fleet/host-attestation/v1`), shared by the device
// attestor and `verifyWorkloadAttestation`. Private to @hobo/identity.
import { KeyAlgorithm } from "@hobo/fleet";
import type { LaunchMeasurement } from "../attestation.js";
import type { JsonObject } from "../json.js";

// public-contract: the `hostSignature.algorithm` values of a document a fleet device signed.
const ALGORITHMS: ReadonlyMap<string, KeyAlgorithm> = new Map([
	["hobo-fleet-envelope/es256", KeyAlgorithm.ES256],
	["hobo-fleet-envelope/eddsa", KeyAlgorithm.EDDSA],
]);

// public-contract: a device SIGN key id is `<member id>#sign` (the key ids of @hobo/fleet ids.ts).
export const SIGN_KEY_SUFFIX = "#sign";

export function fleetEnvelopeAlgorithm(name: string): KeyAlgorithm | undefined {
	return ALGORITHMS.get(name);
}

export function fleetEnvelopeAlgorithmName(algorithm: KeyAlgorithm): string {
	for (const [name, value] of ALGORITHMS) {
		if (value === algorithm) return name;
	}
	throw new Error("a SIGN key is ES256 or EdDSA");
}

/** The launch measurement's JSON bytes, in one field order: what a device signs. */
export function launchMeasurementBytes(
	measurement: LaunchMeasurement | JsonObject,
): string {
	return JSON.stringify({
		runId: measurement.runId,
		tenant: measurement.tenant,
		parentPrincipal: measurement.parentPrincipal,
		codeVersion: measurement.codeVersion,
		componentImageDigest: measurement.componentImageDigest,
		hostId: measurement.hostId,
		issuedAt: measurement.issuedAt,
		expiresAt: measurement.expiresAt,
		nonce: measurement.nonce,
		isolationTier: measurement.isolationTier,
	});
}
