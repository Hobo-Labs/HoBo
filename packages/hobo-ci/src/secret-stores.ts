import {
	createOnePasswordSecretsPort,
	ONE_PASSWORD_VALUE_FIELD,
	type OnePasswordSdkClient,
	onePasswordBinding,
} from "@hobo/adapter-1password";
import {
	type BitwardenSdkClient,
	bitwardenBinding,
	bitwardenSecretRef,
	createBitwardenSecretsPort,
} from "@hobo/adapter-bitwarden";
import {
	createInfisicalClient,
	createInfisicalSecretsPort,
	githubActionsJwtSource,
	type InfisicalAgentVaultApi,
	infisicalBindingFromEnv,
	infisicalSecretRef,
	oidcAuth,
	ownerAuthFromEnv,
} from "@hobo/adapter-infisical";
import type { SecretHolder, SecretStoreOption } from "@hobo/connect-ui";
import type { SecretsPort } from "@hobo/identity";
import {
	bitwardenEndpoints,
	parseBitwardenApiKey,
	parseBitwardenDeviceId,
	parseBitwardenId,
	parseBitwardenServer,
} from "./bitwarden-provision.js";
import { createBitwardenVaultSecretsPort } from "./bitwarden-vault-port.js";
import {
	INFISICAL_OAUTH_DOCS,
	INFISICAL_OAUTH_REDIRECT_URI,
	InfisicalOAuthError,
	infisicalOAuthToken,
	OAUTH_SIGN_IN,
	readOnlySecretsPort,
} from "./infisical-oauth.js";
import { createOnePasswordConnectClient } from "./onepassword-connect.js";
import {
	type HttpsOrigin,
	type OnePasswordVaultId,
	parseHttpsOrigin,
	parseOnePasswordVaultId,
	SettingParseError,
} from "./parsed-values.js";

// The third-party secret stores a provider connection deposits into.
// Where a store is (its coordinates: ids, a region) is non-secret and comes
// from the ceremony's settings; how to sign in comes from the run's trusted
// vault (`@hobo/core` `createTrustedVault`), filled on the setup page, or from
// the provider's own desktop session. Never from an environment variable.
// Passwordless for the owner who runs `hobo ci up` / `hobo cd up`:
//
// - **Infisical** (default): an access token from the owner's own
//   `infisical login`, entered on the page, with the folder's coordinates
//   (`INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`,
//   `INFISICAL_SECRET_PATH`). Workloads read the values back with OIDC Auth.
// - **1Password**: the desktop app's integration (`OP_ACCOUNT`, unlocked with
//   the owner's biometrics — no token), or a service account token entered on
//   the page where no desktop app exists, into `OP_VAULT_ID`.
// - **Bitwarden Secrets Manager**: a machine account's access token
//   (asked for on the setup page and held in the vault for this run only),
//   into the project `BWS_PROJECT_ID` of organization `BWS_ORGANIZATION_ID`,
//   on the US or EU cloud (`BWS_SERVER`). Bitwarden has no workload OIDC sign-in, so a workload
//   reads the values back with its own machine account token, which the
//   platform keeps; prefer Infisical where that matters.
//
// HoBo never writes a sign-in to a file or an environment variable and never
// prints one: it lives in the run's vault and is wiped when the run ends.

export type SecretStoreId = SecretStoreOption["id"];

/** An opened store: the port, and how to name a stored entry without its value. */
export interface OpenedSecretStore {
	readonly id: SecretStoreId;
	readonly port: SecretsPort;
	readonly reference: (name: string) => string;
	readonly agentVault?: OwnerAgentVault;
}

export type OwnerAgentVault = Readonly<{
	api: InfisicalAgentVaultApi;
	siteUrl: string;
}>;

export type SecretStoreOpening =
	| { readonly ok: true; readonly store: OpenedSecretStore }
	| {
			readonly ok: false;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

/** An environment-shaped record: names to values, some absent. */
export interface Env {
	readonly [name: string]: string | undefined;
}

export interface SecretStoreDeps {
	/** Tests inject a client; otherwise `@1password/sdk` is loaded on demand. */
	readonly onePasswordClient?: (
		coordinates: Env,
		signIn: SecretHolder,
	) => Promise<OnePasswordSdkClient>;
	/** Tests inject a client; otherwise `@bitwarden/sdk-napi` is loaded on demand. */
	readonly bitwardenClient?: (
		coordinates: Env,
		signIn: SecretHolder,
	) => Promise<BitwardenSdkClient>;
	readonly fetch?: typeof fetch;
	/**
	 * A CI runner's own OIDC request variables (GitHub Actions'
	 * `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`): with a preconfigured
	 * `INFISICAL_IDENTITY_ID`, the run signs in as that workload and nobody
	 * types a token.
	 */
	readonly workloadOidc?: Env;
	/**
	 * Where an Infisical OAuth sign-in (`INFISICAL_SIGN_IN=oauth`) shows the
	 * owner its approval page. Without it, or with `noBrowser` (a handed-off
	 * run), that sign-in is not attempted.
	 */
	readonly oauthBrowser?: {
		readonly open: (url: string) => void;
		readonly emit: (line: string) => void;
	};
	readonly noBrowser?: boolean;
	/** Tests replace the OAuth grant; the real one is `infisicalOAuthToken`. */
	readonly infisicalOAuth?: typeof infisicalOAuthToken;
}

type Sdk = typeof import("@1password/sdk");
type SdkClient = {
	readonly items: Pick<
		Awaited<ReturnType<Sdk["createClient"]>>["items"],
		"list" | "get" | "create" | "put"
	>;
};
type SdkItem = Awaited<ReturnType<SdkClient["items"]["get"]>>;

/**
 * The real SDK client behind the adapter's port. The port carries the SDK's
 * string enums as strings; they are parsed back by membership (an unknown
 * category or field type is refused, never cast). Before an update, fetch the
 * whole SDK item again and verify its version and field identities so SDK-only
 * metadata is retained and concurrent changes are not overwritten.
 */
export function sdkPort(sdk: Sdk, client: SdkClient): OnePasswordSdkClient {
	const categories: readonly string[] = Object.values(sdk.ItemCategory);
	const fieldTypes: readonly string[] = Object.values(sdk.ItemFieldType);
	const category = (value: string) => {
		const found = Object.values(sdk.ItemCategory).find((c) => c === value);
		if (found === undefined || !categories.includes(value))
			throw new Error("unknown 1Password item category");
		return found;
	};
	const fieldType = (value: string) => {
		const found = Object.values(sdk.ItemFieldType).find((t) => t === value);
		if (found === undefined || !fieldTypes.includes(value))
			throw new Error("unknown 1Password field type");
		return found;
	};
	const toPort = (item: SdkItem) => {
		const ported = {
			id: item.id,
			title: item.title,
			category: item.category,
			vaultId: item.vaultId,
			fields: item.fields.map((field) => ({
				id: field.id,
				title: field.title,
				fieldType: field.fieldType,
				value: field.value,
				...(field.sectionId !== undefined
					? { sectionId: field.sectionId }
					: undefined),
			})),
			version: item.version,
		};
		return ported;
	};
	return {
		items: {
			list: (vaultId) => client.items.list(vaultId),
			get: async (vaultId, itemId) =>
				toPort(await client.items.get(vaultId, itemId)),
			create: async (params) =>
				toPort(
					await client.items.create({
						...params,
						category: category(params.category),
						fields: params.fields.map((field) => ({
							...field,
							fieldType: fieldType(field.fieldType),
						})),
					}),
				),
			put: async (item) => {
				const original = await client.items.get(item.vaultId, item.id);
				if (
					original.id !== item.id ||
					original.vaultId !== item.vaultId ||
					original.version !== item.version ||
					original.title !== item.title ||
					original.category !== item.category ||
					original.fields.length !== item.fields.length ||
					original.fields.filter(
						(field) => field.id === ONE_PASSWORD_VALUE_FIELD,
					).length !== 1
				)
					throw new Error(
						"1Password item changed or has an invalid password field",
					);
				const pending = new Map(
					item.fields.map((field) => [
						JSON.stringify([field.id, field.sectionId ?? null]),
						field,
					]),
				);
				if (pending.size !== item.fields.length)
					throw new Error("1Password item has ambiguous fields");
				const fields = original.fields.map((field) => {
					const key = JSON.stringify([field.id, field.sectionId ?? null]);
					const updated = pending.get(key);
					if (
						!updated ||
						updated.title !== field.title ||
						updated.fieldType !== field.fieldType
					)
						throw new Error("1Password item fields changed");
					pending.delete(key);
					return { ...field, value: updated.value };
				});
				if (pending.size) throw new Error("1Password item fields changed");
				return toPort(
					await client.items.put({
						...original,
						fields,
					}),
				);
			},
		},
	};
}

async function onePasswordSdkClient(
	coordinates: Env,
	signIn: SecretHolder,
): Promise<OnePasswordSdkClient> {
	const sdk = await import("@1password/sdk");
	const auth = coordinates.OP_ACCOUNT
		? new sdk.DesktopAuth(coordinates.OP_ACCOUNT)
		: signIn.reveal("OP_SERVICE_ACCOUNT_TOKEN");
	if (auth === undefined || auth === "")
		throw new Error("no 1Password sign-in in the environment");
	const client = await sdk.createClient({
		auth,
		integrationName: "HoBo",
		integrationVersion: "0.0.1",
	});
	return sdkPort(sdk, client);
}

/** Bitwarden's clouds; a token is valid on the one its account lives in. */
export const BITWARDEN_SERVERS = Object.freeze({
	us: {
		apiUrl: "https://api.bitwarden.com",
		identityUrl: "https://identity.bitwarden.com",
	},
	eu: {
		apiUrl: "https://api.bitwarden.eu",
		identityUrl: "https://identity.bitwarden.eu",
	},
});

/** The server: BITWARDEN_SERVER_URL (self-hosted), else the cloud. */
function bitwardenServer(coordinates: Env) {
	// Parsed where it enters: a malformed origin is refused, not followed.
	const endpoints = bitwardenEndpoints(
		parseBitwardenServer(coordinates.BWS_SERVER),
		coordinates.BITWARDEN_SERVER_URL
			? parseHttpsOrigin(
					"BITWARDEN_SERVER_URL",
					coordinates.BITWARDEN_SERVER_URL,
				)
			: undefined,
	);
	return { apiUrl: endpoints.api, identityUrl: endpoints.identity };
}

async function bitwardenSdkClient(
	coordinates: Env,
	signIn: SecretHolder,
): Promise<BitwardenSdkClient> {
	const token = signIn.reveal("BWS_ACCESS_TOKEN");
	if (token === undefined || token === "")
		throw new Error("no Bitwarden access token in this run's vault");
	const sdk = await import("@bitwarden/sdk-napi");
	const client = new sdk.BitwardenClient({
		...bitwardenServer(coordinates),
		userAgent: "HoBo",
	});
	await client.auth().loginAccessToken(token);
	return client;
}

/** Open the chosen store with the owner's own sign-in, or say how to sign in. */
export async function openSecretStore(
	id: SecretStoreId,
	coordinates: Env,
	signIn: SecretHolder,
	deps: SecretStoreDeps = {},
): Promise<SecretStoreOpening> {
	// The adapters read their inputs from an env-shaped record: build it in
	// memory from the coordinates and the vault, never from process.env.
	const oauthSelected = coordinates.INFISICAL_SIGN_IN === OAUTH_SIGN_IN;
	const env: Env = {
		...coordinates,
		INFISICAL_TOKEN: oauthSelected
			? undefined
			: signIn.reveal("INFISICAL_TOKEN"),
	};
	switch (id) {
		case "infisical": {
			let auth: ReturnType<typeof ownerAuthFromEnv>;
			if (!oauthSelected) {
				try {
					auth = ownerAuthFromEnv(env);
				} catch {
					auth = undefined;
				}
			}
			if (
				auth === undefined &&
				!oauthSelected &&
				coordinates.INFISICAL_IDENTITY_ID &&
				deps.workloadOidc?.ACTIONS_ID_TOKEN_REQUEST_URL
			) {
				try {
					auth = oidcAuth({
						identityId: coordinates.INFISICAL_IDENTITY_ID,
						jwt: githubActionsJwtSource({
							env: deps.workloadOidc,
							...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
						}),
					});
				} catch {
					auth = undefined;
				}
			}
			// The OAuth application sign-in: a browser approval, read-only.
			let readOnly = false;
			if (auth === undefined && oauthSelected) {
				const clientId = coordinates.INFISICAL_OAUTH_CLIENT_ID;
				const clientSecret = signIn.reveal("INFISICAL_OAUTH_CLIENT_SECRET");
				if (deps.noBrowser === true || deps.oauthBrowser === undefined)
					return {
						ok: false,
						message:
							"An Infisical OAuth sign-in needs your browser on this machine; this run cannot show it.",
						remediation: [
							"Run it yourself in a terminal, or use a Token Auth token or CI's OIDC identity.",
						],
					};
				if (!clientId || !clientSecret)
					return {
						ok: false,
						message:
							"The Infisical OAuth application's client id and secret are not set.",
						remediation: [
							`Create the application (${INFISICAL_OAUTH_DOCS}) with redirect URI ${INFISICAL_OAUTH_REDIRECT_URI} and PKCE required; enter its client id and secret on the setup page.`,
						],
					};
				try {
					const token = await (deps.infisicalOAuth ?? infisicalOAuthToken)({
						siteUrl: env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
						clientId,
						clientSecret,
						openBrowser: deps.oauthBrowser.open,
						emit: deps.oauthBrowser.emit,
						...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
					});
					auth = ownerAuthFromEnv({ INFISICAL_TOKEN: token });
					readOnly = true;
				} catch (error) {
					return {
						ok: false,
						message:
							error instanceof InfisicalOAuthError
								? error.message
								: "The Infisical OAuth sign-in failed.",
						remediation: [
							`Check the application's client id, secret and redirect URI (${INFISICAL_OAUTH_REDIRECT_URI}), then run again.`,
						],
					};
				}
			}
			if (auth === undefined)
				return {
					ok: false,
					message: "Not signed in to Infisical.",
					remediation: [
						"Enter an Infisical access token on the setup page (from `infisical login --silent --plain`); it is held in memory for this run only.",
					],
				};
			try {
				const client = createInfisicalClient({
					binding: infisicalBindingFromEnv(env),
					auth,
					...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
				});
				const binding = infisicalBindingFromEnv(env);
				return {
					ok: true,
					store: {
						id,
						port: readOnly
							? readOnlySecretsPort(createInfisicalSecretsPort({ client }))
							: createInfisicalSecretsPort({ client }),
						reference: (name) => infisicalSecretRef(binding, name),
						agentVault: {
							api: client.agentVault(),
							siteUrl: binding.siteUrl,
						},
					},
				};
			} catch {
				return {
					ok: false,
					message: "Infisical's folder for these credentials is not set.",
					remediation: [
						"Choose the Infisical project, environment and folder on the setup page.",
					],
				};
			}
		}
		case "1password": {
			// Parsed here, where the coordinates enter: a malformed id or host
			// is refused by name, never passed on.
			let vaultId: OnePasswordVaultId | undefined;
			let connectHost: HttpsOrigin | undefined;
			try {
				vaultId = coordinates.OP_VAULT_ID
					? parseOnePasswordVaultId("OP_VAULT_ID", coordinates.OP_VAULT_ID)
					: undefined;
				connectHost = coordinates.OP_CONNECT_HOST
					? parseHttpsOrigin("OP_CONNECT_HOST", coordinates.OP_CONNECT_HOST)
					: undefined;
			} catch (error) {
				if (!(error instanceof SettingParseError)) throw error;
				return { ok: false, message: error.message, remediation: [] };
			}
			if (!vaultId)
				return {
					ok: false,
					message: "No 1Password vault chosen.",
					remediation: [
						"Choose the vault the credentials go to on the setup page.",
					],
				};
			const connectToken = signIn.reveal("OP_CONNECT_TOKEN");
			if (connectHost && !connectToken)
				return {
					ok: false,
					message: "This run holds no 1Password Connect access token yet.",
					remediation: [
						"Hand over a Connect access token for the vault when the run asks, in the HoBo MCP App's secret form; the run holds it in memory only.",
					],
				};
			try {
				const client =
					connectHost && connectToken
						? createOnePasswordConnectClient({
								host: connectHost,
								token: connectToken,
								...(deps.fetch !== undefined
									? { fetch: deps.fetch }
									: undefined),
							})
						: await (deps.onePasswordClient ?? onePasswordSdkClient)(
								coordinates,
								signIn,
							);
				const binding = onePasswordBinding({
					vaultId,
					authMode:
						env.OP_ACCOUNT && !connectHost ? "desktop-app" : "service-account",
					...(env.OP_ACCOUNT && !connectHost
						? { accountName: env.OP_ACCOUNT }
						: undefined),
				});
				return {
					ok: true,
					store: {
						id,
						port: createOnePasswordSecretsPort({ client, binding }),
						reference: (name) =>
							`op://${vaultId}/${name}/${ONE_PASSWORD_VALUE_FIELD}`,
					},
				};
			} catch {
				return {
					ok: false,
					message: "Could not sign in to 1Password.",
					remediation: [
						"Turn on the 1Password desktop app's SDK integration and give your account name on the setup page, or enter a service account token there where no desktop app runs.",
					],
				};
			}
		}
		case "bitwarden": {
			// No Secrets Manager (Vaultwarden): the organization's vault holds
			// the secrets, opened with the organization key this run holds.
			if (coordinates.BITWARDEN_STORAGE === "vault")
				return openBitwardenVault(coordinates, signIn, deps);
			let binding: ReturnType<typeof bitwardenBinding>;
			try {
				binding = bitwardenBinding({
					organizationId: coordinates.BWS_ORGANIZATION_ID ?? "",
					projectId: coordinates.BWS_PROJECT_ID ?? "",
					apiUrl: bitwardenServer(coordinates).apiUrl,
				});
			} catch {
				return {
					ok: false,
					message: "Bitwarden's project for these credentials is not set.",
					remediation: [
						"Give the organization and project IDs (both UUIDs, from the Secrets Manager web app) on the setup page.",
					],
				};
			}
			try {
				const client = await (deps.bitwardenClient ?? bitwardenSdkClient)(
					coordinates,
					signIn,
				);
				return {
					ok: true,
					store: {
						id,
						port: createBitwardenSecretsPort({ client, binding }),
						reference: (name) => bitwardenSecretRef(binding, name),
					},
				};
			} catch {
				return {
					ok: false,
					message: "Could not sign in to Bitwarden Secrets Manager.",
					remediation: [
						"Check the server (US or EU cloud) and enter an access token for a machine account with write access to the project; it is held in memory for this run only.",
					],
				};
			}
		}
	}
}

/** The Bitwarden-compatible vault store, when this run holds its sign-in. */
function openBitwardenVault(
	coordinates: Env,
	signIn: SecretHolder,
	deps: SecretStoreDeps,
): SecretStoreOpening {
	const clientId = signIn.reveal("BW_CLIENTID");
	const clientSecret = signIn.reveal("BW_CLIENTSECRET");
	const organizationKey = signIn.reveal("BITWARDEN_ORG_KEY");
	if (!organizationKey || !clientId || !clientSecret)
		return {
			ok: false,
			message: "This run holds no sign-in for the Bitwarden vault yet.",
			remediation: [
				"Run again: the run asks for your personal API key and one approved login request.",
			],
		};
	try {
		const endpoints = bitwardenEndpoints(
			parseBitwardenServer(coordinates.BWS_SERVER),
			coordinates.BITWARDEN_SERVER_URL
				? parseHttpsOrigin(
						"BITWARDEN_SERVER_URL",
						coordinates.BITWARDEN_SERVER_URL,
					)
				: undefined,
		);
		const organizationId = parseBitwardenId(
			"BWS_ORGANIZATION_ID",
			coordinates.BWS_ORGANIZATION_ID ?? "",
		);
		const collectionId = parseBitwardenId(
			"BITWARDEN_COLLECTION_ID",
			coordinates.BITWARDEN_COLLECTION_ID ?? "",
		);
		const port = createBitwardenVaultSecretsPort({
			endpoints,
			apiKey: parseBitwardenApiKey(clientId, clientSecret),
			deviceId: parseBitwardenDeviceId(coordinates.BITWARDEN_DEVICE_ID ?? ""),
			organizationId,
			collectionId,
			organizationKey: Buffer.from(organizationKey, "base64"),
			fetch: deps.fetch ?? fetch,
		});
		return {
			ok: true,
			store: {
				id: "bitwarden",
				port,
				reference: (name) =>
					`bitwarden-vault://${organizationId}/${collectionId}/${encodeURIComponent(name)}`,
			},
		};
	} catch (error) {
		if (!(error instanceof SettingParseError)) throw error;
		return {
			ok: false,
			message: error.message,
			remediation: [`Fix ${error.setting}: ${error.rule}.`],
		};
	}
}
