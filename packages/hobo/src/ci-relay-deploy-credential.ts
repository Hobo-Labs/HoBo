import {
	createInfisicalClient,
	githubActionsJwtSource,
	InfisicalError,
	infisicalSecretRef,
	oidcAuth,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import type { RepairSecretStoreBinding } from "@hobo/secret-store-claim";

// public-contract: the entry in the deploy credential's project that holds the deploy token (CONFIG-SERVICE.md).
export const RELAY_DEPLOY_TOKEN_ENTRY = "VERCEL_TOKEN";
// public-contract: the GitHub Actions audience of the deploy credential writer.
export const RELAY_GITHUB_OIDC_AUDIENCE = "https://github.com/Hobo-Labs";
// public-contract: the deploy token reader authenticates here, never at the writer's audience.
export const RELAY_DEPLOY_READER_OIDC_AUDIENCE = `${RELAY_GITHUB_OIDC_AUDIENCE}/hobo-ci-deploy-reader`;

// public-contract: the deploy credential sits at the root of its own project, apart from the relay's (CONFIG-SERVICE.md).
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
	readonly binding: RepairSecretStoreBinding;
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
	if (
		!identityId ||
		identityId === store.deployIdentityId ||
		identityId === store.relayIdentityId
	)
		throw new RelayDeployCredentialError(
			"The binding has no deploy credential identity of its own: the reader must be distinct from both the writer and the relay identity. Record deployCredentialIdentityId for a read-only deploy identity; neither the writer nor the relay identity is ever used for deploy token reads.",
		);
	const audience = input.audience ?? RELAY_DEPLOY_READER_OIDC_AUDIENCE;
	try {
		const binding = parseInfisicalBinding({
			siteUrl: store.endpoint,
			projectId: store.deployProjectId,
			environment: store.environment,
			secretPath: DEPLOY_SECRET_PATH,
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
