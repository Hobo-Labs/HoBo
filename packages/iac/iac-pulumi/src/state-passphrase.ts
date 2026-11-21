import { randomBytes } from "node:crypto";
import { PulumiEngineUnavailableError } from "./pulumi-engine-errors.js";

// public-contract: retained Pulumi state cannot be used without its key.
export const PULUMI_STATE_PASSPHRASE_MISSING =
	"pulumi-state-passphrase-missing";

/** Select a stable caller-supplied key, or a process-only key for disposable state. */
export function statePassphrase(
	explicit: string | undefined,
	legacyEnvironment: string | undefined,
	ephemeralState: boolean | undefined,
): string | undefined {
	const supplied = explicit ?? legacyEnvironment;
	if (supplied) return supplied;
	return ephemeralState ? randomBytes(32).toString("base64url") : undefined;
}

/** Never initialize or alter persistent state with an unrecoverable key. */
export function requireStatePassphrase(passphrase: string | undefined): string {
	if (!passphrase)
		throw new PulumiEngineUnavailableError(
			PULUMI_STATE_PASSPHRASE_MISSING,
			"Persistent Pulumi state requires a recoverable passphrase; supply statePassphrase or use ephemeralState only for a disposable workspace.",
		);
	return passphrase;
}
