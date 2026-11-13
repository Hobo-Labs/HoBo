/**
 * The endpoint's secret key, derived from the device's SIGN key (design §6.4,
 * `TRANSPORT`): SHA-256 over a domain label and the SIGN key's signature of
 * that label. `DeviceKeys` never hands out private material, so the transport
 * asks the key store for one signature instead. Ed25519 signatures are
 * deterministic, so the same SIGN key always yields the same endpoint id; a
 * rotated SIGN key yields a new one, which the rotated key bundle records.
 *
 * The signed bytes are the envelope encoding (`context ‖ 0x00 ‖ payload`, §7.4)
 * of a context no envelope uses, with an empty payload, so no signature the
 * device publishes can equal this one. The derived key and the signature never
 * leave this function.
 */
import { createHash } from "node:crypto";
import type { DeviceKeys } from "@hobo/fleet";

const DERIVATION_CONTEXT = "hobo-fleet/p2p-endpoint-key/v1";

export async function deriveEndpointSecret(
	keys: DeviceKeys,
): Promise<Uint8Array> {
	const label = new TextEncoder().encode(DERIVATION_CONTEXT);
	const signed = new Uint8Array(label.length + 1);
	signed.set(label, 0);
	const signature = await keys.sign.sign(signed);
	return new Uint8Array(
		createHash("sha256").update(label).update(signature).digest(),
	);
}
