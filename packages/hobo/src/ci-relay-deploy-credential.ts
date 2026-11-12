// The relay deploy workflow's Vercel token, read from the config service with
// the job's own GitHub Actions OIDC token (ADR-0179 phase 6).
//
// The workflow on `main` holds no Vercel secret. It signs in to Infisical as
// the `hobo-ci-deploy` machine identity through OIDC Auth (no secret zero:
// `githubActionsJwtSource` asks GitHub for the job's token, which needs
// `permissions: id-token: write`), reads `VERCEL_TOKEN` from the
// `hobo-ci-deploy` project, and hands it to the deploy step as a masked
// environment variable: `::add-mask::` is written to the job log first, then
// the value goes into the `$GITHUB_ENV` file, which GitHub reads for the
// following steps and never prints. Nothing here logs, returns or throws the
// value.
//
// The coordinates are repository variables (`vars.*`), not secrets: an
// identity id and a project id say where to sign in, not with what.
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

// The repository variables the workflow maps into the step's environment.
export const RELAY_DEPLOY_CREDENTIAL_ENV = Object.freeze({
	identityId: "HOBO_CI_DEPLOY_INFISICAL_IDENTITY_ID",
	projectId: "HOBO_CI_DEPLOY_INFISICAL_PROJECT_ID",
	environment: "HOBO_CI_DEPLOY_INFISICAL_ENVIRONMENT",
	secretPath: "HOBO_CI_DEPLOY_INFISICAL_SECRET_PATH",
	siteUrl: "HOBO_CI_INFISICAL_SITE_URL",
	audience: "HOBO_CI_DEPLOY_INFISICAL_AUDIENCE",
} as const);

// public-contract: the entry in the `hobo-ci-deploy` project that holds the deploy token (CONFIG-SERVICE.md step 5).
export const RELAY_DEPLOY_TOKEN_ENTRY = "VERCEL_TOKEN";

// A token Vercel issues: printable, one line, no spaces.
const TOKEN = /^[!-~]{8,4096}$/u;

export class RelayDeployCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelayDeployCredentialError";
	}
}

// Read the deploy token. `fetch` reaches both GitHub's token endpoint and
// Infisical; injected in tests.
export async function readRelayDeployToken(input: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
}): Promise<string> {
	const { env } = input;
	const names = RELAY_DEPLOY_CREDENTIAL_ENV;
	try {
		const binding = parseInfisicalBinding({
			siteUrl: env[names.siteUrl] || undefined,
			projectId: env[names.projectId],
			environment: env[names.environment] || "prod",
			secretPath: env[names.secretPath] || "/",
		});
		const audience = env[names.audience] || undefined;
		const client = createInfisicalClient({
			binding,
			auth: oidcAuth({
				identityId: env[names.identityId],
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
