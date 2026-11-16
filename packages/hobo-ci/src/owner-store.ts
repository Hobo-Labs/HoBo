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
import { INFISICAL_OAUTH_DOCS, OAUTH_SIGN_IN } from "./infisical-oauth.js";
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

// public-contract: the Infisical folder of the relay's own credentials, which hobo ci up reads and keeps.
export const CI_RELAY_FOLDER = "/hobo-ci-relay";

// public-contract: the locator's INFISICAL_SIGN_IN value for a sign-in the agent's egress proxy injects.
export const EGRESS_PROXY_SIGN_IN = "egress-proxy";

// public-contract: Infisical's guide to the Token Auth identity a remote agent's run signs in with.
export const INFISICAL_TOKEN_AUTH_DOCS =
	"https://infisical.com/docs/documentation/platform/identities/token-auth";

// public-contract: the progress line a handed-off run prints when the owner has not chosen a store.
export const OWNER_STORE_CHOICE_LINE_PREFIX = "HOBO_OWNER_STORE_CHOICE";

/**
 * The stores the owner can choose for a handed-off run, each with what it
 * needs. Names, settings and places only.
 */
export function storeChoiceGuidance(verb: "ci" | "cd"): readonly string[] {
	return [
		`${OWNER_STORE_CHOICE_LINE_PREFIX} infisical|1password|bitwarden — run again with HOBO_SECRET_STORE set to the owner's choice (a non-secret setting), and the store's ids:`,
		`infisical: INFISICAL_PROJECT_ID (and INFISICAL_ENVIRONMENT, default prod). From a remote box the owner gives a Token Auth token in the session's credential form for app.infisical.com (guide: ${INFISICAL_TOKEN_AUTH_DOCS}).`,
		`1password: OP_VAULT_ID and, from a remote box, OP_CONNECT_HOST, the https origin of the owner's 1Password Connect server; the owner gives its access token in the session's credential form for that host. At their own terminal, OP_ACCOUNT unlocks with the 1Password desktop app instead.`,
		`bitwarden: BWS_ORGANIZATION_ID and BWS_PROJECT_ID (BWS_SERVER us or eu). Bitwarden Secrets Manager decrypts in the client, so its access token must be in the run: the owner runs hobo ${verb} up in their own terminal and types it on the setup page.`,
	];
}

/**
 * How the owner lets a run that shows no page into the store: every path the
 * store supports, each with where to do it. Names and places only.
 */
export function storeSignInGuidance(
	store: SecretStoreId,
	verb: "ci" | "cd",
): readonly string[] {
	if (store === "1password")
		return [
			`Remote agent (no page): set OP_CONNECT_HOST to your 1Password Connect server's https origin (guide: https://www.1password.dev/connect/), issue it a token with access to the vault, and give the token only in the agent session's credential form for that host; the run holds a placeholder the proxy replaces.`,
			`Your own machine: run hobo ${verb} up in a terminal; the 1Password desktop app unlocks the vault (OP_ACCOUNT).`,
		];
	if (store !== "infisical")
		return [
			`Run hobo ${verb} up yourself in a terminal: the setup page asks for the ${store} sign-in and keeps it in this run's memory only.`,
		];
	return [
		`Remote agent (no page): at https://app.infisical.com go to Organization → Access Control → Identities (guide: ${INFISICAL_TOKEN_AUTH_DOCS}), Create Identity "hobo-${verb}-owner" (organization role No Access), add Token Auth and create a token (TTL 3600), and add the identity to the store's project with a write role. Select INFISICAL_SIGN_IN=${EGRESS_PROXY_SIGN_IN} in the environment or store locator, and type the token only into the agent session's credential form for app.infisical.com; the run holds a placeholder.`,
		`Your own machine: run hobo ${verb} up in a terminal; the setup page asks for the token, or sign in with an Infisical OAuth application (INFISICAL_SIGN_IN=oauth, guide: ${INFISICAL_OAUTH_DOCS}) to read the store with a browser approval; its tokens are read-only, so a run that must write still needs a token.`,
		`CI: give the locator an INFISICAL_IDENTITY_ID with OIDC Auth that trusts the workflow; the run signs in with its own OIDC token.`,
	];
}

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
	/** A fallback only when neither the environment nor locator chose a sign-in. */
	readonly defaultInfisicalSignIn?: typeof EGRESS_PROXY_SIGN_IN;
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
	/**
	 * Whether the owner chose the store (the locator or the run's settings
	 * name it), rather than the default applying. A handed-off run asks first.
	 */
	readonly chosen: boolean;
	/** Locator fields the page must ask for, and the sign-in when none is in hand. */
	readonly missing: readonly ConfigField[];
	/** Whether supplying an egress-proxy credential can open the configured store. */
	readonly canAwaitEgressCredential: boolean;
	/** The host whose credential the egress proxy injects, when it can. */
	readonly egressCredentialHost: string | undefined;
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
	const suppliedEnv = deps.env ?? {};
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
	const env =
		!suppliedEnv.INFISICAL_SIGN_IN &&
		!saved.INFISICAL_SIGN_IN &&
		deps.defaultInfisicalSignIn !== undefined
			? { ...suppliedEnv, INFISICAL_SIGN_IN: deps.defaultInfisicalSignIn }
			: suppliedEnv;
	const choice = resolveSettings([STORE_CHOICE], env, saved);
	const id = storeIdOf(choice.values.HOBO_SECRET_STORE);
	// CI's credentials are the relay's own (the GitHub App it runs): they
	// live in the relay's folder, which its deploy workflow writes, so an
	// App made once is found by every later hobo ci up.
	const folder = family === "ci" ? CI_RELAY_FOLDER : `/hobo-${family}`;
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
	// The OAuth application sign-in approves in the browser: no token, but
	// the application's client id and secret.
	const oauthSignIn =
		id === "infisical" && resolved.values.INFISICAL_SIGN_IN === OAUTH_SIGN_IN;
	// 1Password through the owner's Connect server: a bearer token the egress
	// proxy injects on the way to it, so no desktop app and no token here.
	const connectHost = (() => {
		if (id !== "1password" || !resolved.values.OP_CONNECT_HOST)
			return undefined;
		try {
			const url = new URL(resolved.values.OP_CONNECT_HOST);
			return url.protocol === "https:" ? url.host : undefined;
		} catch {
			return undefined;
		}
	})();
	const oauthMissing = oauthSignIn
		? side
				.map((setting) => setting.field)
				.filter(
					(field) =>
						(field.name === "INFISICAL_OAUTH_CLIENT_ID" &&
							!resolved.values.INFISICAL_OAUTH_CLIENT_ID) ||
						(field.name === "INFISICAL_OAUTH_CLIENT_SECRET" &&
							!vault.reveal("INFISICAL_OAUTH_CLIENT_SECRET")),
				)
		: [];
	const missingSide = [
		...resolved.missing.filter(
			(field) =>
				!(
					((workloadSignIn || proxySignIn || oauthSignIn) &&
						field.name === "INFISICAL_TOKEN") ||
					(connectHost !== undefined && field.name === "OP_ACCOUNT")
				),
		),
		...oauthMissing,
	];

	let opened: OpenedSecretStore | undefined;
	if (choice.missing.length === 0 && missingSide.length === 0) {
		const attempt = await open(id, resolved.values, vault);
		if (attempt.ok) opened = attempt.store;
	}

	return {
		id,
		chosen: Boolean(env.HOBO_SECRET_STORE || saved.HOBO_SECRET_STORE),
		missing: [...choice.missing, ...missingSide],
		canAwaitEgressCredential:
			(proxySignIn || connectHost !== undefined) &&
			choice.missing.length === 0 &&
			missingSide.length === 0,
		egressCredentialHost: proxySignIn
			? new URL(
					resolved.values.INFISICAL_SITE_URL ?? "https://app.infisical.com",
				).host
			: connectHost,
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
