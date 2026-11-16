import path from "node:path";

import {
	type CeremonySetting,
	type ConfigField,
	type ConnectFlow,
	cellSettingsStore,
	configureThen,
	fileSettingsStore,
	resolveSettings,
	type SecretHolder,
	type SettingsStore,
} from "@hobo/connect-ui";
import type { TrustedVault } from "@hobo/core";
import { z } from "zod";

import { storeLabel, storeSettings } from "./ceremony-settings.js";
import {
	type Env,
	type OpenedSecretStore,
	openSecretStore,
	type SecretStoreDeps,
	type SecretStoreId,
	type SecretStoreOpening,
} from "./secret-stores.js";

// The owner's secret store, as the first stage of every lifecycle ceremony.
//
// What survives a destroyed machine, and where:
//
// - **Where the store is** (which provider; its project, vault or
//   organization ids; for workloads, the OIDC identity that signs in): the
//   locator, a non-secret JSON file committed with the repository
//   (`.hobo/secret-store.json`). A fresh clone has it.
// - **Everything a lifecycle was told** (the relay URL, the GitHub App's owner,
//   the Vercel Integration's ids): one JSON entry per family in the store
//   itself (`HOBO_CI_SETTINGS`, `HOBO_CD_SETTINGS`), beside the credentials
//   the lifecycle put there (the App's id, key and webhook secret; the
//   Integration's client secret and the access Vercel granted).
// - **The sign-in**: nowhere. It is typed on the setup page (or unlocked by the
//   1Password desktop app, or a workload's own OIDC token) and held in the
//   run's trusted vault, in memory, until the run ends.
//
// So a destroyed devbox is set up again by signing in once: nothing is asked
// twice, and no secret is on its disk.

// public-contract: the committed, non-secret locator of the owner's secret store.
export const SECRET_STORE_LOCATOR_FILE = ".hobo/secret-store.json";

// public-contract: the locator's INFISICAL_SIGN_IN value for a sign-in the agent's egress proxy injects.
export const EGRESS_PROXY_SIGN_IN = "egress-proxy";

/** Which store, as the ceremony asks it. */
export const STORE_CHOICE: CeremonySetting = {
	field: {
		name: "HOBO_SECRET_STORE",
		label: "Secret store",
		kind: "choice",
		required: true,
		value: "infisical",
		options: [
			{
				value: "infisical",
				label: "Infisical Cloud (recommended)",
				description: "Workloads sign in with OIDC: no secret to keep.",
			},
			{
				value: "1password",
				label: "1Password",
				description:
					"Unlocked with your desktop app; workloads use a service account.",
			},
			{
				value: "bitwarden",
				label: "Bitwarden Secrets Manager",
				description:
					"A machine account's access token; workloads use their own machine account.",
			},
		],
	},
};

export class InvalidSecretStoreError extends Error {
	constructor() {
		super("The configured secret store is not supported.");
		this.name = "InvalidSecretStoreError";
	}
}

export function storeIdOf(value: string | undefined): SecretStoreId {
	if (value === undefined || value === "" || value === "infisical")
		return "infisical";
	if (value === "1password" || value === "bitwarden") return value;
	throw new InvalidSecretStoreError();
}

/** The lifecycle's own settings, kept in the store as one entry. */
export function familySettings(
	store: OpenedSecretStore,
	family: "ci" | "cd",
): SettingsStore {
	const entry = `HOBO_${family.toUpperCase()}_SETTINGS`;
	return cellSettingsStore({
		async read() {
			const read = await store.port.access(entry);
			if (read.status === "ok") {
				try {
					z.record(z.string(), z.string()).parse(
						JSON.parse(read.material ?? ""),
					);
					return read.material;
				} catch {
					throw new Error("The saved ceremony settings are invalid.");
				}
			}
			if (read.code === "secret-not-found") return undefined;
			throw new Error("Cannot read the saved ceremony settings.");
		},
		async write(text) {
			await store.port.put(entry, text);
		},
	});
}

export interface OwnerStoreDeps extends SecretStoreDeps {
	/** Non-secret environment: only non-secret settings are read from it. */
	readonly env?: Env;
	/** Where the locator is committed; the working directory by default. */
	readonly cwd?: string;
	readonly locator?: SettingsStore;
	readonly openStore?: (
		id: SecretStoreId,
		coordinates: Env,
		signIn: SecretHolder,
	) => Promise<SecretStoreOpening>;
}

export interface OwnerStore {
	readonly id: SecretStoreId;
	/** Locator fields the page must ask for, and the sign-in when none is in hand. */
	readonly missing: readonly ConfigField[];
	/** The store, opened without the page when the locator and a sign-in allow it. */
	readonly opened: OpenedSecretStore | undefined;
	/**
	 * A ceremony stage: ask what is missing of the locator and the sign-in,
	 * open the store, then continue with `proceed`.
	 */
	stage(options: {
		readonly provider: string;
		readonly reason: string;
		readonly proceed: (store: OpenedSecretStore) => Promise<ConnectFlow>;
	}): Promise<ConnectFlow>;
}

/** Where a store is: its non-secret coordinates. */
interface StoreCoordinates {
	[name: string]: string;
}

function nonSecret(
	settings: readonly CeremonySetting[],
	values: Readonly<Record<string, string>>,
): StoreCoordinates {
	const out: StoreCoordinates = {};
	for (const setting of settings)
		if (setting.field.kind !== "secret") {
			const value = values[setting.field.name];
			if (value) out[setting.field.name] = value;
		}
	return out;
}

/** Find the owner's store: committed locator, the run's vault, or a workload's OIDC. */
export async function ownerStore(
	family: "ci" | "cd",
	vault: TrustedVault,
	deps: OwnerStoreDeps = {},
): Promise<OwnerStore> {
	const env = deps.env ?? {};
	const locator =
		deps.locator ??
		fileSettingsStore(
			path.join(deps.cwd ?? process.cwd(), SECRET_STORE_LOCATOR_FILE),
		);
	const open =
		deps.openStore ??
		((id: SecretStoreId, coordinates: Env, signIn: SecretHolder) =>
			openSecretStore(id, coordinates, signIn, deps));
	const saved = await locator.read();
	const choice = resolveSettings([STORE_CHOICE], env, saved);
	const id = storeIdOf(choice.values.HOBO_SECRET_STORE);
	const folder = `/hobo-${family}`;
	const side = storeSettings(id, folder);
	const resolved = resolveSettings(side, env, saved, vault);
	// A workload with a preconfigured OIDC identity needs no typed token.
	const workloadSignIn =
		id === "infisical" &&
		Boolean(resolved.values.INFISICAL_IDENTITY_ID) &&
		Boolean(deps.workloadOidc?.ACTIONS_ID_TOKEN_REQUEST_URL);
	// The agent's egress proxy injects the owner's token into requests to
	// Infisical: this run holds only a placeholder and asks for nothing.
	const proxySignIn =
		id === "infisical" &&
		resolved.values.INFISICAL_SIGN_IN === EGRESS_PROXY_SIGN_IN;
	const missingSide = resolved.missing.filter(
		(field) =>
			!((workloadSignIn || proxySignIn) && field.name === "INFISICAL_TOKEN"),
	);

	let opened: OpenedSecretStore | undefined;
	if (choice.missing.length === 0 && missingSide.length === 0) {
		const attempt = await open(id, resolved.values, vault);
		if (attempt.ok) opened = attempt.store;
	}

	return {
		id,
		missing: [...choice.missing, ...missingSide],
		opened,
		async stage({ provider, reason, proceed }) {
			if (opened !== undefined) return proceed(opened);
			const signInStage = async (chosen: SecretStoreId) => {
				const settings = storeSettings(chosen, folder);
				const known = resolveSettings(
					settings,
					env,
					await locator.read(),
					vault,
				);
				return configureThen({
					provider,
					title: `Sign in to ${storeLabel(chosen)}`,
					reason: `${reason} Where the store is, is saved in ${SECRET_STORE_LOCATOR_FILE} (commit it); the sign-in is held in memory for this run only.`,
					settings,
					missing: known.missing,
					known: known.values,
					store: locator,
					async proceed(values) {
						for (const setting of settings)
							if (setting.field.kind === "secret") {
								const value = values[setting.field.name];
								if (value) vault.put(setting.field.name, value);
							}
						const attempt = await open(
							chosen,
							nonSecret(settings, values),
							vault,
						);
						if (!attempt.ok) {
							const field =
								settings.find((s) => s.field.kind === "secret")?.field.name ??
								settings[0]?.field.name ??
								STORE_CHOICE.field.name;
							return {
								ok: false,
								errors: {
									[field]: `${attempt.message} ${attempt.remediation.join(" ")}`,
								},
							};
						}
						opened = attempt.store;
						return { ok: true, flow: await proceed(attempt.store) };
					},
				});
			};
			if (choice.missing.length === 0) return signInStage(id);
			return configureThen({
				provider,
				title: "Choose your secret store",
				reason,
				settings: [STORE_CHOICE],
				missing: choice.missing,
				known: choice.values,
				store: locator,
				async proceed(values) {
					return {
						ok: true,
						flow: await signInStage(storeIdOf(values.HOBO_SECRET_STORE)),
					};
				},
			});
		},
	};
}
