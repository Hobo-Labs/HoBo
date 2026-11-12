/**
 * Identity additions for HoBo Fleet (ADR-0182). Signatures are frozen by the
 * fleet contract commit; the bodies are written by the identity lane.
 */
import { FleetNotImplemented, type Signer } from "@hobo/fleet";
import type { HostAttestor } from "../attestation.js";
import type { KmsLike } from "../issuer.js";
import type { SecretsPort } from "../secrets-port.js";

/** A `KmsLike` whose signing key is read once from the secret store, under `options.prefix`. */
export function loadSecretStoreKms(
	secrets: SecretsPort,
	options: Readonly<{ prefix: string }>,
): Promise<KmsLike> {
	void secrets;
	void options;
	throw new FleetNotImplemented("loadSecretStoreKms");
}

/** Signs launch measurements as fleet envelopes with the device's `SIGN` key; `hostId` is the member id. */
export function createDeviceHostAttestor(signer: Signer): HostAttestor {
	void signer;
	throw new FleetNotImplemented("createDeviceHostAttestor");
}
