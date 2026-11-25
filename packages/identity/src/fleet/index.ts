import type { Signer } from "@hobo/fleet";
import type { HostAttestor } from "../attestation.js";
import type { KmsLike } from "../issuer.js";
import type { SecretsPort } from "../secrets-port.js";
import { deviceHostAttestor } from "./device-host-attestor.js";
import { loadKeyRing } from "./secret-store-kms.js";

export function loadSecretStoreKms(
	secrets: SecretsPort,
	options: Readonly<{ prefix: string }>,
): Promise<KmsLike> {
	return loadKeyRing(secrets, options.prefix);
}

export function createDeviceHostAttestor(signer: Signer): HostAttestor {
	return deviceHostAttestor(signer);
}
