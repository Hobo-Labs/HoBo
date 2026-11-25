import { HOST_ATTESTATION_CONTEXT, type Signer } from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";
import {
	ATTESTATION_SCHEMA_VERSION,
	type HostAttestor,
	type LaunchMeasurement,
} from "../attestation.js";
import {
	envelopeAlgorithmName,
	launchMeasurementBytes,
	SIGN_KEY_SUFFIX,
} from "./host-envelope.js";

export function deviceHostAttestor(signer: Signer): HostAttestor {
	if (!signer.keyId.endsWith(SIGN_KEY_SUFFIX)) {
		throw new Error(
			`a device host attestor signs with the device's SIGN key, not ${signer.keyId}`,
		);
	}
	const memberId = signer.keyId.slice(0, -SIGN_KEY_SUFFIX.length);
	const algorithm = envelopeAlgorithmName(signer.algorithm);

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
