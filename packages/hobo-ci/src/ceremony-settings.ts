import type { CeremonySetting } from "@hobo/connect-ui";
import type { GithubAppOwner } from "./app-hosts.js";
import type { GithubAppExpectation } from "./github.js";
import {
	checkedBy,
	parseHttpsOrigin,
	parseOnePasswordVaultId,
} from "./parsed-values.js";

// The settings a lifecycle's provider connections need, as ceremony fields:
// asked for on the connect page when neither the environment nor an earlier
// ceremony has them. Secrets are marked `secret` and are never saved.

const httpsOrigin = (value: string) => {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.pathname === "/" && !url.search
			? undefined
			: "An https origin, like https://ci.example.com.";
	} catch {
		return "An https origin, like https://ci.example.com.";
	}
};

const githubLogin = (value: string) =>
	/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value)
		? undefined
		: "A GitHub user or organization login.";

const uuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
		? undefined
		: "A UUID, as the Secrets Manager web app shows it.";

/** What `hobo ci up` needs to know before it can create the App. */
export const CI_SETTINGS: readonly CeremonySetting[] = Object.freeze([
	{
		field: {
			name: "HOBO_CI_PUBLIC_URL",
			label: "Relay URL",
			description:
				"The hosted relay's https origin; GitHub sends webhooks there.",
			kind: "url",
			required: true,
		},
		validate: httpsOrigin,
	},
	{
		field: {
			name: "HOBO_CI_GITHUB_OWNER",
			label: "GitHub owner",
			description: "The user or organization login that will own the App.",
			kind: "text",
			required: true,
		},
		validate: githubLogin,
	},
]);

/** A store's name as the person sees it. */
export function storeLabel(store: string): string {
	return store === "1password"
		? "1Password"
		: store === "bitwarden"
			? "Bitwarden"
			: "Infisical";
}

/** The chosen store's coordinates and sign-in. */
export function storeSettings(
	store: string,
	defaultPath: string,
): readonly CeremonySetting[] {
	if (store === "bitwarden")
		return [
			{
				field: {
					name: "BWS_SERVER",
					label: "Bitwarden cloud",
					description:
						"Where your Bitwarden account lives; a key works only there.",
					kind: "choice",
					required: true,
					value: "us",
					options: [
						{ value: "us", label: "United States (bitwarden.com)" },
						{ value: "eu", label: "European Union (bitwarden.eu)" },
					],
				},
				fallback: "us",
			},
			{
				field: {
					name: "BITWARDEN_SERVER_URL",
					label: "Self-hosted server (optional)",
					description:
						"Only if your vault is on your own server, such as Vaultwarden: its https address.",
					kind: "text",
					required: false,
				},
				validate: checkedBy(parseHttpsOrigin, "BITWARDEN_SERVER_URL"),
			},
			{
				field: {
					name: "BW_CLIENTID",
					label: "Personal API key: client_id",
					description:
						"Account settings → Security → Keys → View API key. HoBo then asks you to approve one login request and sets up the rest itself.",
					kind: "text",
					required: true,
				},
			},
			{
				field: {
					name: "BW_CLIENTSECRET",
					label: "Personal API key: client_secret",
					description: "Used for this run only; never saved.",
					kind: "secret",
					required: true,
				},
			},
			{
				field: {
					name: "BWS_ORGANIZATION_ID",
					label: "Organization ID (only if you belong to several)",
					kind: "text",
					required: false,
				},
				validate: uuid,
			},
		];
	return store === "1password"
		? [
				{
					field: {
						name: "OP_VAULT_ID",
						label: "1Password vault ID",
						kind: "text",
						required: true,
					},
					validate: checkedBy(parseOnePasswordVaultId, "OP_VAULT_ID"),
				},
				{
					field: {
						name: "OP_ACCOUNT",
						label: "1Password account",
						description:
							"Your account name in the desktop app; it unlocks with your biometrics.",
						kind: "text",
						required: true,
					},
				},
				{
					field: {
						name: "OP_CONNECT_HOST",
						label: "1Password Connect server (optional)",
						description:
							"The https origin of your own 1Password Connect server. With it, a run on a remote box reaches your vault through Connect, and the agent's egress proxy adds your Connect token: no desktop app and no token in the run.",
						kind: "text",
						required: false,
					},
					validate: checkedBy(parseHttpsOrigin, "OP_CONNECT_HOST"),
				},
			]
		: [
				{
					field: {
						name: "INFISICAL_PROJECT_ID",
						label: "Infisical project ID",
						kind: "text",
						required: true,
					},
				},
				{
					field: {
						name: "INFISICAL_ENVIRONMENT",
						label: "Infisical environment",
						kind: "text",
						required: false,
					},
					fallback: "prod",
				},
				{
					field: {
						name: "INFISICAL_SECRET_PATH",
						label: "Infisical folder",
						kind: "text",
						required: false,
					},
					fallback: defaultPath,
				},
				{
					field: {
						name: "INFISICAL_IDENTITY_ID",
						label: "Infisical machine identity for workloads (optional)",
						description:
							"An identity with OIDC Auth that trusts your CI; with it, a CI run signs in with its own OIDC token and nobody types a token.",
						kind: "text",
						required: false,
					},
				},
				{
					field: {
						name: "INFISICAL_SIGN_IN",
						label: "How this machine signs in to Infisical",
						description:
							"typed: you type an access token on this page. egress-proxy: the run holds no token; the agent's egress proxy injects one you gave it out of band (for an agent's remote box you cannot reach). oauth: you approve in your browser; the store opens read-only.",
						kind: "choice",
						required: false,
						value: "typed",
						options: [
							{ value: "typed", label: "Type a token here" },
							{
								value: "egress-proxy",
								label: "Injected by the agent's egress proxy",
							},
							{
								value: "oauth",
								label: "Approve in the browser (OAuth application, read-only)",
							},
						],
					},
					fallback: "typed",
				},
				{
					field: {
						name: "INFISICAL_OAUTH_CLIENT_ID",
						label: "Infisical OAuth application client ID",
						description:
							"For the oauth sign-in: an application under Organization Settings → OAuth Applications, with redirect URI http://127.0.0.1:8793/infisical/callback and PKCE required.",
						kind: "text",
						required: false,
					},
				},
				{
					field: {
						name: "INFISICAL_OAUTH_CLIENT_SECRET",
						label: "Infisical OAuth application client secret",
						description:
							"For the oauth sign-in. Used for this run only; never saved.",
						kind: "secret",
						required: false,
					},
				},
				{
					field: {
						name: "INFISICAL_TOKEN",
						label: "Infisical access token",
						description:
							"From `infisical login --silent --plain`. Used for this run only; never saved.",
						kind: "secret",
						required: true,
					},
				},
			];
}

/**
 * The owner's id and kind, from GitHub's public users API, so the person
 * types only a login. `HOBO_CI_GITHUB_OWNER_ID`/`_TYPE` override it.
 */
export async function lookupGithubOwner(
	login: string,
	fetchImpl: typeof fetch = fetch,
): Promise<GithubAppOwner | undefined> {
	try {
		const response = await fetchImpl(
			`https://api.github.com/users/${encodeURIComponent(login)}`,
			{
				headers: { accept: "application/vnd.github+json" },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) return undefined;
		const body: { id?: number; type?: string; login?: string } =
			await response.json();
		if (
			!Number.isSafeInteger(body.id) ||
			(body.type !== "User" && body.type !== "Organization")
		)
			return undefined;
		return { kind: body.type, login: body.login ?? login, id: body.id ?? 0 };
	} catch {
		return undefined;
	}
}

/** Resolve the owner and relay that an existing stored App must still match. */
export async function resolveGithubAppExpectation(
	values: Readonly<Record<string, string>>,
	env: Readonly<Record<string, string | undefined>>,
	fetchImpl?: typeof fetch,
): Promise<GithubAppExpectation | undefined> {
	const relayUrl = values.HOBO_CI_PUBLIC_URL;
	const login = values.HOBO_CI_GITHUB_OWNER;
	if (!relayUrl || !login || httpsOrigin(relayUrl) || githubLogin(login))
		return undefined;
	const id = Number(env.HOBO_CI_GITHUB_OWNER_ID);
	const kind = env.HOBO_CI_GITHUB_OWNER_TYPE;
	const owner: Pick<GithubAppOwner, "id" | "kind"> | undefined =
		Number.isSafeInteger(id) &&
		id > 0 &&
		(kind === "User" || kind === "Organization")
			? { id, kind }
			: await lookupGithubOwner(login, fetchImpl);
	if (!owner) return undefined;
	return {
		relayUrl,
		ownerId: owner.id,
		ownerType: owner.kind,
		...(fetchImpl ? { fetch: fetchImpl } : undefined),
	};
}
