/**
 * Device key stores (L10). Signatures frozen by the fleet contract commit (ADR-0182).
 */
import { FleetNotImplemented, type KeyStore } from "@hobo/fleet";

/** Keys and agent state in a private directory under `home`. */
export function createFileKeyStore(home: string): KeyStore {
	void home;
	throw new FleetNotImplemented("createFileKeyStore");
}

/** Keys held behind an external signer `command`; agent state under `home`. */
export function createExternalSignerKeyStore(
	home: string,
	command: readonly string[],
): KeyStore {
	void home;
	void command;
	throw new FleetNotImplemented("createExternalSignerKeyStore");
}
