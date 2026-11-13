/**
 * Identity additions for HoBo Fleet (ADR-0182). Signatures are frozen by the
 * fleet contract commit; the bodies are written by the identity lane.
 */
import { FleetNotImplemented, type Signer } from "@hobo/fleet";
import type { HostAttestor } from "../attestation.js";
import type { KmsLike } from "../issuer.js";
import type { SecretsPort } from "../secrets-port.js";
import { loadKeyRing } from "./secret-store-kms.js";

/**
 * A `KmsLike` whose RSA signing keys are read once from the secret store
 * (created once when absent) under the secret named `options.prefix`. The
 * first key id is `<prefix>#1`; see `secret-store-kms.ts` for the layout and
 * the rotation rule.
 */
export function loadSecretStoreKms(
	secrets: SecretsPort,
	options: Readonly<{ prefix: string }>,
): Promise<KmsLike> {
	return loadKeyRing(secrets, options.prefix);
}

/** Signs launch measurements as fleet envelopes with the device's `SIGN` key; `hostId` is the member id. */
export function createDeviceHostAttestor(signer: Signer): HostAttestor {
	void signer;
	throw new FleetNotImplemented("createDeviceHostAttestor");
}
