import { OnePasswordError } from "@hobo/adapter-1password";
import { BitwardenError } from "@hobo/adapter-bitwarden";
import { InfisicalError } from "@hobo/adapter-infisical";

import { InfisicalReadOnlyError } from "./infisical-oauth.js";

/**
 * Why a secret store refused, in words safe to show the owner and the
 * agent: only the adapters' own errors, whose messages name the operation,
 * a code and an HTTP status and never a value, a token or a response body.
 * Anything else stays unnamed.
 */
export function storeFailureReason(error: Error): string | undefined {
	return error instanceof InfisicalError || error instanceof BitwardenError
		? error.message
		: undefined;
}

export interface StoreRefusal {
	readonly code: string;
	readonly message: string;
	readonly remediation: readonly string[];
}

export function uncertainStoreOperationRefusal(
	family: "ci" | "cd",
): StoreRefusal {
	return {
		code: `HOBO_${family.toUpperCase()}_STORE_OPERATION_UNCERTAIN`,
		message:
			"A store operation may have completed and needs reconciliation before retrying.",
		remediation: ["Reconcile the store operation before trying setup again."],
	};
}

export function storeWriteUncertain(error: Error): boolean {
	if (error instanceof InfisicalReadOnlyError) return false;
	if (error instanceof InfisicalError) return error.code === "write-uncertain";
	if (error instanceof BitwardenError || error instanceof OnePasswordError)
		return error.code !== "invalid-input";
	return true;
}
