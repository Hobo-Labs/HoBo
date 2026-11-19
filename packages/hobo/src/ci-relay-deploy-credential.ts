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
