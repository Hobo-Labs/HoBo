import { createHash } from "node:crypto";
import { type DeviceKeys, P2P_ENDPOINT_KEY_CONTEXT } from "@hobo/fleet";

const DERIVATION_CONTEXT = P2P_ENDPOINT_KEY_CONTEXT;

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
