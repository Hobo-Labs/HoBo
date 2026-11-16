import {
	createOnePasswordSecretsPort,
	ONE_PASSWORD_VALUE_FIELD,
	type OnePasswordSdkClient,
	onePasswordBinding,
} from "@hobo/adapter-1password";
import {
	createInfisicalClient,
	createInfisicalSecretsPort,
	infisicalBindingFromEnv,
	infisicalSecretRef,
	ownerAuthFromEnv,
} from "@hobo/adapter-infisical";
import type { SecretStoreOption } from "@hobo/connect-ui";
import type { SecretsPort } from "@hobo/identity";

// The third-party secret stores a provider connection deposits into.
// Passwordless for the owner who runs `hobo ci up` / `hobo cd up`:
//
// - **Infisical** (default): the owner's own session, `INFISICAL_TOKEN` from
//   `infisical login` (browser sign-in, nothing stored by HoBo), with the
//   folder's coordinates (`INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`,
//   `INFISICAL_SECRET_PATH`). Workloads read the values back with OIDC Auth.
// - **1Password**: the desktop app's integration (`OP_ACCOUNT`, unlocked with
//   the owner's biometrics — no token), or a service account token where no
//   desktop app exists (`OP_SERVICE_ACCOUNT_TOKEN`), into `OP_VAULT_ID`.
//
// HoBo never writes these to a file, never prints them, and never asks for
// them in a page: they are the owner's own sign-in, read from the
// environment of the command they ran.

export type SecretStoreId = SecretStoreOption["id"];

/** An opened store: the port, and how to name a stored entry without its value. */
export interface OpenedSecretStore {
	readonly id: SecretStoreId;
	readonly port: SecretsPort;
	readonly reference: (name: string) => string;
}

export type SecretStoreOpening =
	| { readonly ok: true; readonly store: OpenedSecretStore }
	| {
			readonly ok: false;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

export type Env = Readonly<Record<string, string | undefined>>;

export interface SecretStoreDeps {
	/** Tests inject a client; otherwise `@1password/sdk` is loaded on demand. */
	readonly onePasswordClient?: (env: Env) => Promise<OnePasswordSdkClient>;
	readonly fetch?: typeof fetch;
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

async function onePasswordSdkClient(env: Env): Promise<OnePasswordSdkClient> {
	const sdk = await import("@1password/sdk");
	const auth = env.OP_ACCOUNT
		? new sdk.DesktopAuth(env.OP_ACCOUNT)
		: env.OP_SERVICE_ACCOUNT_TOKEN;
	if (auth === undefined || auth === "")
		throw new Error("no 1Password sign-in in the environment");
	const client = await sdk.createClient({
		auth,
		integrationName: "HoBo",
		integrationVersion: "0.0.1",
	});
	return sdkPort(sdk, client);
}

/** Open the chosen store with the owner's own sign-in, or say how to sign in. */
export async function openSecretStore(
	id: SecretStoreId,
	env: Env,
	deps: SecretStoreDeps = {},
): Promise<SecretStoreOpening> {
	switch (id) {
		case "infisical": {
			let auth: ReturnType<typeof ownerAuthFromEnv>;
			try {
				auth = ownerAuthFromEnv(env);
			} catch {
				auth = undefined;
			}
			if (auth === undefined)
				return {
					ok: false,
					message: "Not signed in to Infisical.",
					remediation: [
						"Run `infisical login`, then export INFISICAL_TOKEN=$(infisical login --silent --plain) in the same shell and run the command again.",
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
						port: createInfisicalSecretsPort({ client }),
						reference: (name) => infisicalSecretRef(binding, name),
					},
				};
			} catch {
				return {
					ok: false,
					message: "Infisical's folder for these credentials is not set.",
					remediation: [
						"Export INFISICAL_PROJECT_ID, INFISICAL_ENVIRONMENT and INFISICAL_SECRET_PATH (and INFISICAL_SITE_URL off Infisical Cloud).",
					],
				};
			}
		}
		case "1password": {
			const vaultId = env.OP_VAULT_ID;
			if (!vaultId)
				return {
					ok: false,
					message: "No 1Password vault chosen.",
					remediation: ["Export OP_VAULT_ID, the vault the credentials go to."],
				};
			try {
				const client = await (deps.onePasswordClient ?? onePasswordSdkClient)(
					env,
				);
				const binding = onePasswordBinding({
					vaultId,
					authMode: env.OP_ACCOUNT ? "desktop-app" : "service-account",
					...(env.OP_ACCOUNT ? { accountName: env.OP_ACCOUNT } : undefined),
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
						"Turn on the 1Password desktop app's SDK integration and export OP_ACCOUNT (your account name), or export OP_SERVICE_ACCOUNT_TOKEN where no desktop app runs.",
					],
				};
			}
		}
		case "bitwarden":
			return {
				ok: false,
				message: "Bitwarden is not offered for connections yet.",
				remediation: ["Choose Infisical or 1Password."],
			};
	}
}
