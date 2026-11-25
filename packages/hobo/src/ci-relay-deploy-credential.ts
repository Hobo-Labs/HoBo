import type { CredentialResolver } from "@hobo/cd";
import type { TrustedVault } from "@hobo/core";
import { VERCEL_DEPLOY_ENTRIES } from "@hobo/hobo-ci";

import {
	OWNER_CREDENTIAL_SCHEME,
	OwnerCredentialUnavailable,
} from "./owner-store-session.js";

// public-contract: the entry in the deploy credential's project that holds the deploy token (CONFIG-SERVICE.md).
export const RELAY_DEPLOY_TOKEN_ENTRY = "VERCEL_TOKEN";
// public-contract: the GitHub Actions audience of the deploy credential writer.
export const RELAY_GITHUB_OIDC_AUDIENCE = "https://github.com/Hobo-Labs";
// public-contract: the deploy token reader authenticates here, never at the writer's audience.
export const RELAY_DEPLOY_READER_OIDC_AUDIENCE = `${RELAY_GITHUB_OIDC_AUDIENCE}/hobo-ci-deploy-reader`;

// public-contract: the owner-store locator hobo ci deploy reads the Vercel deploy token from (the entry hobo cd up keeps).
export const RELAY_DEPLOY_TOKEN_REF = `${OWNER_CREDENTIAL_SCHEME}${VERCEL_DEPLOY_ENTRIES.token}`;

const RUN_VAULT_TOKEN = "VERCEL_TOKEN";

const RELAY_DEPLOY_TOKEN_SCOPE = "vercel.deploy:hobo-ci-relay";

const TOKEN = /^[!-~]{8,4096}$/u;

export type RelayDeployToken =
	| Readonly<{ ok: true; token: string; source: "owner-store" | "run-vault" }>
	| Readonly<{ ok: false; code: string; message: string }>;

const sessionAbsent = (): RelayDeployToken => ({
	ok: false,
	code: "HOBO_CI_SECRET_STORE_SESSION_REQUIRED",
	message: `hobo ci deploy reads the Vercel deploy token only through the owner's store session (${RELAY_DEPLOY_TOKEN_REF}), never from the environment or a CI job's identity. Connect the store with HoBo MCP's choose_secret_store (cwd: this project), then run again; --dry-run shows what would be sent without it.`,
});

const entryMissing = (): RelayDeployToken => ({
	ok: false,
	code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
	message: `The owner's store session holds no Vercel deploy token at ${RELAY_DEPLOY_TOKEN_REF}. Run hobo cd up once: it connects HoBo's Vercel account and keeps the token there, where hobo ci deploy reads it.`,
});

const notAToken = (): RelayDeployToken => ({
	ok: false,
	code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
	message: `${RELAY_DEPLOY_TOKEN_REF} in the owner's store is not a single-line Vercel token. Run hobo cd up again to reconnect HoBo's Vercel account.`,
});

function accepted(
	token: string,
	source: "owner-store" | "run-vault",
): RelayDeployToken {
	return TOKEN.test(token) ? { ok: true, token, source } : notAToken();
}

export async function readRelayDeployToken(input: {
	readonly ownerCredentials?: CredentialResolver;
	readonly runVault?: TrustedVault;
}): Promise<RelayDeployToken> {
	const kept = input.runVault?.reveal(RUN_VAULT_TOKEN);
	if (input.ownerCredentials === undefined)
		return kept === undefined || kept === ""
			? sessionAbsent()
			: accepted(kept, "run-vault");
	try {
		const resolved = await input.ownerCredentials.resolve(
			RELAY_DEPLOY_TOKEN_REF,
			RELAY_DEPLOY_TOKEN_SCOPE,
		);
		return accepted(resolved.token ?? "", "owner-store");
	} catch (error) {
		if (kept !== undefined && kept !== "") return accepted(kept, "run-vault");
		if (
			error instanceof OwnerCredentialUnavailable &&
			error.reason === "no-session"
		)
			return sessionAbsent();
		return entryMissing();
	}
}
