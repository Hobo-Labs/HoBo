// The relay deploy workflow's Vercel token, read from the relay's secret
// store with the job's own GitHub Actions OIDC token (ADR-0179 phase 6, as
// amended: "Secret store chosen at deploy, provisioned by claim").
//
// The workflow on `main` holds no Vercel secret and reads no repository
// variable. Where to sign in comes from the store's committed binding
// (`packages/ci-vercel/deploy/secret-store.binding.json`, coordinates only,
// written by `hobo ci secret-store provision`): the store's origin, the deploy
// credential's own project, and the deploy identity, which trusts GitHub
// Actions on `main` through OIDC Auth (no secret zero: `githubActionsJwtSource`
// asks GitHub for the job's token, which needs `permissions: id-token: write`).
// It reads `VERCEL_TOKEN` and hands it to the deploy step as a masked
// environment variable: `::add-mask::` is written to the job log first, then
// the value goes into the `$GITHUB_ENV` file, which GitHub reads for the
// following steps and never prints. Nothing here logs, returns or throws the
// value.
//
// HONEST SCOPE: exercised against fakes of GitHub's token endpoint and of
// Infisical only. No request has been made from this repository to either.

import { randomBytes } from "node:crypto";

import {
	createInfisicalClient,
	githubActionsJwtSource,
	InfisicalError,
	oidcAuth,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import type { ParsedSecretStoreBinding } from "@hobo/secret-store-claim";

// public-contract: the entry in the deploy credential's project that holds the deploy token (CONFIG-SERVICE.md).
export const RELAY_DEPLOY_TOKEN_ENTRY = "VERCEL_TOKEN";

// The deploy credential sits at the root of its own project.
const DEPLOY_SECRET_PATH = "/";

// A token Vercel issues: printable, one line, no spaces.
const TOKEN = /^[!-~]{8,4096}$/u;

export class RelayDeployCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelayDeployCredentialError";
	}
}

// Read the deploy token. `fetch` reaches both GitHub's token endpoint and
// the store; injected in tests. `env` carries only the runner's own OIDC
// request variables.
export async function readRelayDeployToken(input: {
	readonly binding: ParsedSecretStoreBinding;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The audience the deploy identity expects; GitHub's default otherwise. */
	readonly audience?: string;
	readonly fetch?: typeof fetch;
}): Promise<string> {
	const { env, binding: store } = input;
	try {
		const binding = parseInfisicalBinding({
			siteUrl: store.endpoint,
			projectId: store.deployProjectId,
			environment: store.environment,
			secretPath: DEPLOY_SECRET_PATH,
		});
		const audience = input.audience;
		const client = createInfisicalClient({
			binding,
			auth: oidcAuth({
				identityId: store.deployIdentityId,
				jwt: githubActionsJwtSource({
					env,
					...(audience !== undefined ? { audience } : undefined),
					...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
				}),
			}),
			...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
		});
		const secret = await client.getSecret(RELAY_DEPLOY_TOKEN_ENTRY);
		if (!TOKEN.test(secret.value))
			throw new RelayDeployCredentialError(
				`${RELAY_DEPLOY_TOKEN_ENTRY} in the deploy project is not a single-line token.`,
			);
		return secret.value;
	} catch (error) {
		if (error instanceof RelayDeployCredentialError) throw error;
		// The adapter's messages name the operation, a code, a status and a
		// request id; never a token, a JWT or a value.
		throw new RelayDeployCredentialError(
			error instanceof InfisicalError
				? `Could not read the deploy token: ${error.message}.`
				: "Could not read the deploy token.",
		);
	}
}

// Mask `value` in the job log, then hand it to the following steps as `name`
// through the `$GITHUB_ENV` file. The mask is written before the value is
// anywhere a log could show it.
export function exportMaskedToGithubEnv(input: {
	readonly name: string;
	readonly value: string;
	readonly writeLog: (line: string) => void;
	readonly appendEnvFile: (text: string) => void;
}): void {
	if (!/^[A-Z][A-Z0-9_]*$/u.test(input.name))
		throw new RelayDeployCredentialError("Not an environment variable name.");
	if (!TOKEN.test(input.value))
		throw new RelayDeployCredentialError(
			"Only a single-line token is exported.",
		);
	input.writeLog(`::add-mask::${input.value}\n`);
	// The multi-line form with a random delimiter: no value can end it early.
	const delimiter = `HOBO_${randomBytes(16).toString("hex")}`;
	input.appendEnvFile(
		`${input.name}<<${delimiter}\n${input.value}\n${delimiter}\n`,
	);
}
