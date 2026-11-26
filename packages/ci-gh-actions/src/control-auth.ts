import { createHash, timingSafeEqual } from "node:crypto";
import { fromJsonString } from "@bufbuild/protobuf";
import { type ControlCredential, ControlCredentialsSchema } from "@hobo/ci";

/** Who an account API request acts as: one account, its installations and its scopes. */
export type ControlPrincipal = Pick<
	ControlCredential,
	"accountId" | "installationIds" | "scopes"
>;
/** Resolves a request's `Authorization` header to a principal, or refuses it. */
export type ControlAuthenticator = (
	authorization: string | undefined,
) => ControlPrincipal | undefined | Promise<ControlPrincipal | undefined>;
/** The file-backed authenticator: bearer tokens are matched by their SHA-256 digests. */
export function createControlAuthenticator(json: string): ControlAuthenticator {
	const credentials = fromJsonString(ControlCredentialsSchema, json);
	if (credentials.tokens.length < 1 || credentials.tokens.length > 1000)
		throw new Error("invalid control credential count");
	const hashes = new Set<string>();
	const installationOwners = new Map<number, string>();
	for (const credential of credentials.tokens) {
		if (
			!/^[a-zA-Z0-9_-]{1,80}$/.test(credential.accountId) ||
			!/^[a-f0-9]{64}$/.test(credential.tokenSha256) ||
			hashes.has(credential.tokenSha256) ||
			credential.installationIds.some(
				(id) => !Number.isSafeInteger(id) || id < 1,
			) ||
			credential.scopes.length === 0 ||
			credential.scopes.some(
				(scope) =>
					![
						"policy:read",
						"policy:write",
						"repositories:write",
						"operations:write",
						"observations:write",
					].includes(scope),
			)
		)
			throw new Error("invalid control credential binding");
		hashes.add(credential.tokenSha256);
		for (const id of credential.installationIds) {
			const owner = installationOwners.get(id);
			if (owner && owner !== credential.accountId)
				throw new Error("GitHub installation must have one account owner");
			installationOwners.set(id, credential.accountId);
		}
		Object.freeze(credential.installationIds);
		Object.freeze(credential.scopes);
		Object.freeze(credential);
	}
	return (authorization) => {
		if (
			!authorization?.startsWith("Bearer ") ||
			authorization.length < 39 ||
			authorization.length > 1031
		)
			return undefined;
		const digest = createHash("sha256").update(authorization.slice(7)).digest();
		let principal: ControlPrincipal | undefined;
		for (const credential of credentials.tokens)
			if (timingSafeEqual(digest, Buffer.from(credential.tokenSha256, "hex")))
				principal = credential;
		return principal;
	};
}
