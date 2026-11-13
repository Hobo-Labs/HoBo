// The GitHub OIDC subject the relay's deploy identity trusts, resolved from
// GitHub for `hobo ci secret-store provision|connect` (never formatted from
// the repository's name: GitHub issues the immutable
// `repo:<owner>@<ownerId>/<repo>@<repoId>` subject to repositories that use
// it, and a trust bound to the legacy one is refused with HTTP 403).
//
// GitHub is read with the token in GH_TOKEN (or GITHUB_TOKEN), sent to
// api.github.com only and never printed. Without an answer the command fails
// closed with the remediation (`@hobo/secret-store-claim`'s
// SECRET_STORE_OIDC_SUBJECT_UNRESOLVED).

import {
	type GithubOidcSubject,
	resolveGithubOidcSubject,
} from "@hobo/secret-store-claim";

import { loadRelayYard } from "./ci-relay-yard.js";
import { isJsonString } from "./json.js";

/** `--repo`, else the relay Yard's repository, else undefined. */
export async function relayRepository(
	cwd: string,
	values: Readonly<Record<string, unknown>>,
): Promise<string | undefined> {
	const flag = values.repo;
	if (isJsonString(flag) && flag !== "") return flag;
	const yardRepo = (await loadRelayYard(cwd))?.properties.repository;
	return isJsonString(yardRepo) && yardRepo !== "" ? yardRepo : undefined;
}

export function resolveDeploySubject(input: {
	readonly repository: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
}): Promise<GithubOidcSubject> {
	const token = input.env.GH_TOKEN || input.env.GITHUB_TOKEN || undefined;
	return resolveGithubOidcSubject({
		repository: input.repository,
		...(token !== undefined ? { token } : undefined),
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
}
