import { BitwardenError } from "@hobo/adapter-bitwarden";
import { InfisicalError } from "@hobo/adapter-infisical";

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
