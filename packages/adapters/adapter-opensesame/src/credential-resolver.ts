/**
 * The host half of the credential law for resolvers that ask for a credential
 * by locator (`resolveCredential: (credentialRef) => Promise<string>`, as
 * `@hobo/provider-vercel`'s resolver registry does): the answer is the run's
 * surrogate, or a typed refusal. Nothing is ever returned that is not a surrogate.
 */

import type { SecretsPort } from "@hobo/identity";

import { OpenSesameAdapterError } from "./errors.js";

export function createOpenSesameCredentialResolver(
	port: SecretsPort,
): (credentialRef: string) => Promise<string> {
	return async (credentialRef) => {
		const result = await port.access(credentialRef);
		if (result.status === "ok" && result.material !== undefined) {
			return result.material;
		}
		if (result.status === "denied" && result.code === "placeholders_only") {
			throw new OpenSesameAdapterError("placeholders_only", result.reason);
		}
		throw new OpenSesameAdapterError(
			"binding_invalid",
			"no binding answers for this credential reference",
		);
	};
}
