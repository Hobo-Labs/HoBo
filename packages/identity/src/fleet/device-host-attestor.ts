// A fleet device as the host of a workload attestation (design §8.3): the
// launch measurement's JSON bytes are signed as a fleet envelope under
// `hobo-fleet/host-attestation/v1` with the device's SIGN key, and the host id
// is the member id. `verifyWorkloadAttestation` checks such a document against
// the SIGN key published in the member's key bundle.
import {
	HOST_ATTESTATION_CONTEXT,
	KeyAlgorithm,
	type Signer,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";
import {
	ATTESTATION_SCHEMA_VERSION,
	FLEET_ENVELOPE_ALGORITHM_PREFIX,
	type HostAttestor,
	type LaunchMeasurement,
	launchMeasurementBytes,
} from "../attestation.js";

const SIGN_KEY_SUFFIX = "#sign";

export function deviceHostAttestor(signer: Signer): HostAttestor {
	if (!signer.keyId.endsWith(SIGN_KEY_SUFFIX)) {
		throw new Error(
			`a device host attestor signs with the device's SIGN key, not ${signer.keyId}`,
		);
	}
	const memberId = signer.keyId.slice(0, -SIGN_KEY_SUFFIX.length);
	const algorithm = algorithmName(signer.algorithm);

	return Object.freeze({
		async createDocument(input) {
			const measured = hostedBy(input.launchMeasurement, memberId);
			const payload = Buffer.from(launchMeasurementBytes(measured), "utf8");
			const envelope = await signEnvelope(
				signer,
				HOST_ATTESTATION_CONTEXT,
				new Uint8Array(payload),
			);
			return {
				schemaVersion: ATTESTATION_SCHEMA_VERSION,
				runId: measured.runId,
				claimed: input.claimed ?? {},
				launchMeasurement: measured,
				hostSignature: {
					algorithm,
					hostId: memberId,
					keyId: signer.keyId,
					value: `${Buffer.from(envelope.payload).toString("base64url")}.${Buffer.from(envelope.signature).toString("base64url")}`,
				},
			};
		},
		/** None: the verification key is the SIGN key in the member's key bundle, which the verifier reads from the registry. */
		publicKeys() {
			return [];
		},
	} satisfies HostAttestor);
}

function hostedBy(
	measurement: LaunchMeasurement,
	memberId: string,
): LaunchMeasurement {
	if (measurement.hostId === "") return { ...measurement, hostId: memberId };
	if (measurement.hostId !== memberId) {
		throw new Error(
			"a device host attestor measures only its own launches: hostId must be its member id",
		);
	}
	return { ...measurement };
}

function algorithmName(algorithm: KeyAlgorithm): string {
	if (algorithm === KeyAlgorithm.ES256)
		return `${FLEET_ENVELOPE_ALGORITHM_PREFIX}es256`;
	if (algorithm === KeyAlgorithm.EDDSA)
		return `${FLEET_ENVELOPE_ALGORITHM_PREFIX}eddsa`;
	throw new Error("a SIGN key is ES256 or EdDSA");
}
