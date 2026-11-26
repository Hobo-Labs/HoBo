// The GitHub OIDC subject the relay's deploy identity trusts, resolved from
// GitHub for `hobo ci secret-store provision|connect` (never formatted from
// the repository's name: GitHub issues the immutable
// `repo:<owner>@<ownerId>/<repo>@<repoId>` subject to repositories that use
// it, and a trust bound to the legacy one is refused with HTTP 403).

import type { CredentialResolver } from "@hobo/cd";
import { githubAppInstallationRef } from "@hobo/core";
import {
	type GithubOidcSubject,
	resolveGithubOidcSubject,
} from "@hobo/secret-store-claim";

import { loadRelayYard } from "./ci-relay-yard.js";
import {
	type CiSecretStoreInput,
	SecretStoreBindingRefusal,
} from "./ci-secret-store.js";
import { isJsonString } from "./json.js";

/** `--repo`, else the relay Yard's repository, else undefined. */
export async function relayRepository(
	cwd: string,
	values: CiSecretStoreInput["values"],
): Promise<string | undefined> {
	const flag = values.repo;
	if (isJsonString(flag) && flag !== "") return flag;
	const yardRepo = (await loadRelayYard(cwd))?.properties.repository;
	return isJsonString(yardRepo) && yardRepo !== "" ? yardRepo : undefined;
}

// public-contract: the refusal when the owner store session cannot mint HoBo's GitHub App token for the repository.
export const SECRET_STORE_GITHUB_APP_REQUIRED =
	"HOBO_CI_SECRET_STORE_GITHUB_APP_REQUIRED";

async function githubAppToken(
	repository: string,
	credentials: CredentialResolver | undefined,
): Promise<string> {
	const refusal = new SecretStoreBindingRefusal(
		SECRET_STORE_GITHUB_APP_REQUIRED,
		`hobo ci secret-store reads ${repository} on GitHub only through HoBo's GitHub App: connect the owner's store with HoBo MCP's choose_secret_store, create and install the App with hobo ci app create, then re-run.`,
	);
	if (credentials === undefined) throw refusal;
	let ref: string;
	try {
		ref = githubAppInstallationRef(repository);
	} catch {
		throw refusal;
	}
	const material = await credentials
		.resolve(ref, "ci-secret-store")
		.catch(() => undefined);
	const token = material?.token;
	if (!token) throw refusal;
	return token;
}

export async function resolveDeploySubject(input: {
	readonly repository: string;
	readonly credentials: CredentialResolver | undefined;
	readonly fetch?: typeof fetch;
}): Promise<GithubOidcSubject> {
	return resolveGithubOidcSubject({
		repository: input.repository,
		token: await githubAppToken(input.repository, input.credentials),
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
}
