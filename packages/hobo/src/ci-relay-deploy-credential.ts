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
// `hobo ci deploy` calls it in-process and keeps the token in its trusted
// vault for the deploy it makes: the token never becomes an environment
// variable and never goes through a file (no `$GITHUB_ENV`, which is a file
// on the runner's disk every later step can read). Nothing here logs or
// throws the value.
//
// HONEST SCOPE: exercised against fakes of GitHub's token endpoint and of
// Infisical only. No request has been made from this repository to either.

import {
	createInfisicalClient,
	githubActionsJwtSource,
	InfisicalError,
	infisicalSecretRef,
	oidcAuth,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import {
	type ParsedSecretStoreBinding,
	secretStoreDeployCredentialProjectId,
	secretStoreDeployCredentialSecretPath,
} from "@hobo/secret-store-claim";

// public-contract: the entry in the deploy credential's project that holds the deploy token (CONFIG-SERVICE.md).
export const RELAY_DEPLOY_TOKEN_ENTRY = "VERCEL_TOKEN";
// public-contract: the GitHub Actions audience of the deploy credential writer.
export const RELAY_GITHUB_OIDC_AUDIENCE = "https://github.com/Hobo-Labs";
// public-contract: the deploy token reader authenticates here, never at the writer's audience.
export const RELAY_DEPLOY_READER_OIDC_AUDIENCE = `${RELAY_GITHUB_OIDC_AUDIENCE}/hobo-ci-deploy-reader`;

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
}): Promise<
	Readonly<{
		token: string;
		secretRef: string;
		identityId: string;
		audience: string;
	}>
> {
	const { env, binding: store } = input;
	const identityId = store.deployCredentialIdentityId;
	if (!identityId || identityId === store.deployIdentityId)
		throw new RelayDeployCredentialError(
			"The binding has no deploy credential identity distinct from the writer. Record deployCredentialIdentityId for a read-only deploy identity; the writer identity is never used for deploy token reads.",
		);
	const audience = input.audience ?? RELAY_DEPLOY_READER_OIDC_AUDIENCE;
	try {
		const binding = parseInfisicalBinding({
			siteUrl: store.endpoint,
			projectId: secretStoreDeployCredentialProjectId(store),
			environment: store.environment,
			secretPath: secretStoreDeployCredentialSecretPath(store),
		});
		const client = createInfisicalClient({
			binding,
			auth: oidcAuth({
				identityId,
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
				`${RELAY_DEPLOY_TOKEN_ENTRY} in the deploy credential's path is not a single-line token.`,
			);
		return {
			token: secret.value,
			secretRef: infisicalSecretRef(binding, RELAY_DEPLOY_TOKEN_ENTRY),
			identityId,
			audience,
		};
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
