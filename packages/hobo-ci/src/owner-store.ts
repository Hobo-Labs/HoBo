import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
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

import {
	bitwardenApiKeyPage,
	bitwardenEndpoints,
} from "./bitwarden-provision.js";
import { storeLabel, storeSettings } from "./ceremony-settings.js";
import type { provisionInfisicalAccess } from "./infisical-access.js";
import { OAUTH_SIGN_IN } from "./infisical-oauth.js";
import type { provisionOnePasswordAccess } from "./onepassword-access.js";
import type { OwnerChannel, OwnerSettingsStore } from "./owner-channel.js";
import { type HttpsOrigin, parseHttpsOrigin } from "./parsed-values.js";
import {
	type Env,
	type OpenedSecretStore,
	openSecretStore,
	type SecretStoreDeps,
	type SecretStoreId,
	type SecretStoreOpening,
} from "./secret-stores.js";
import type { RunCommand } from "./store-cli.js";

// The owner's secret store, as the first stage of every lifecycle ceremony.
//
// What survives a destroyed machine, and where:
//
// - **Where the store is** (which provider; its project, vault or
//   organization ids; for workloads, the OIDC identity that signs in): the
//   locator, a JSON file of ids in the owner's own HoBo settings
//   (`~/.config/hobo/projects/<project>/secret-store.json`, mode 0600),
//   never in the repository. No secret is ever written to it.
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

// public-contract: where an older HoBo kept the locator in the working tree; moved out on first read.
export const SECRET_STORE_LOCATOR_FILE = ".hobo/secret-store.json";

/**
 * The locator's path in the owner's user settings, one per project (its
 * absolute path): `$XDG_CONFIG_HOME/hobo/projects/<name>-<hash>/secret-store.json`,
 * or under `~/.config` without XDG_CONFIG_HOME. Never inside the repository.
 */
export function secretStoreLocatorPath(
	cwd: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const root = path.resolve(cwd);
	const base =
		env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
	const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
	return path.join(
		base,
		"hobo",
		"projects",
		`${path.basename(root)}-${key}`,
		"secret-store.json",
	);
}

/** Whether the owner has a locator for this project (or a legacy one in the tree). */
export function hasSecretStoreLocator(
	cwd: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return (
		existsSync(secretStoreLocatorPath(cwd, env)) ||
		existsSync(path.join(cwd, SECRET_STORE_LOCATOR_FILE))
	);
}

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
export function storeChoiceGuidance(
	/** Stores whose sign-in this environment already provides: noted, never chosen. */
	configured: ReadonlySet<SecretStoreId> = new Set(),
): readonly string[] {
	const note = (store: SecretStoreId) =>
		configured.has(store) ? " (configured here: its sign-in is provided)" : "";
	return [
		`${OWNER_STORE_CHOICE_LINE_PREFIX} infisical|1password|bitwarden — choose your store in HoBo's secure owner form.`,
		`infisical${note("infisical")}: use your existing store and sign-in.`,
		`1password${note("1password")}: use your existing store and sign-in.`,
		`bitwarden${note("bitwarden")}: use your existing store and sign-in.`,
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
			`Sign in to 1Password once when the run asks; HoBo creates its own service account for the vault through the 1Password CLI. From a remote box, the run asks for your sign-in in the HoBo MCP App's secret form, which only this run reads.`,
		];
	if (store === "bitwarden")
		return [
			`Your personal API key (${bitwardenApiKeyPage(bitwardenEndpoints("us"))}, or on bitwarden.eu or your own server the same page: Account settings → Security → Keys → View API key). The run asks for it in a form, never in chat: from a remote box, the agent session's credential form for Bitwarden's identity host (client_id as the username, client_secret as the password) or the HoBo MCP App's secret form. Then approve the one login request the run shows, in a Bitwarden app you are signed in to.`,
		];
	return [
		`Sign in to Infisical once from any device when the run gives you its link; HoBo creates its own machine identity, access and project membership through Infisical's API. From a remote box, hand over what Infisical's "Copy to clipboard" copies in the HoBo MCP App's secret form (hobo ${verb} up through the HoBo MCP server).`,
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
				label: "Bitwarden",
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
	readonly locator?: OwnerSettingsStore;
	readonly openStore?: (
		id: SecretStoreId,
		coordinates: Env,
		signIn: SecretHolder,
	) => Promise<SecretStoreOpening>;
	/** Provision Infisical access (tests inject a fake; the API and CLI otherwise). */
	readonly infisicalAccess?: typeof provisionInfisicalAccess;
	/** Provision 1Password access (tests inject a fake; the CLI otherwise). */
	readonly onePasswordAccess?: typeof provisionOnePasswordAccess;
	/** How to reach an owner who is not at this machine (a remote dev box). */
	readonly ownerChannel?: OwnerChannel;
	/** How the ceremony runs a store's CLI (tests inject a fake machine). */
	readonly runCommand?: RunCommand;
	/** Where an executable is on PATH. */
	readonly which?: (bin: string) => Promise<string | undefined>;
	/**
	 * Runs on the setup page after its secrets are in the vault and before the
	 * store opens: Bitwarden provisions its access there, from the API key the
	 * page collected and one approved login request.
	 */
	readonly beforeOpen?: (
		id: SecretStoreId,
		values: Readonly<Record<string, string>>,
	) => Promise<
		| { readonly ok: true }
		| {
				readonly ok: false;
				readonly message: string;
				readonly remediation: readonly string[];
		  }
	>;
}

/** Ids a Bitwarden run provisions and keeps in the locator; not page fields. */
export const BITWARDEN_INTERNAL_SETTINGS = [
	"BWS_ORGANIZATION_ID",
	"BWS_PROJECT_ID",
	"BITWARDEN_STORAGE",
	"BITWARDEN_COLLECTION_ID",
	"BITWARDEN_DEVICE_ID",
] as const;

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
	readonly egressCredentialHost: HttpsOrigin | undefined;
	/** The store, opened without the page when the locator and a sign-in allow it. */
	readonly opened: OpenedSecretStore | undefined;
	/** Infisical only: the folder the store opens on (environment and path). */
	readonly infisicalFolder:
		| { readonly environment: string; readonly path: string }
		| undefined;
	/** Why it is not open: the settings it lacks, or the store's own answer. */
	readonly unopened:
		| { readonly message: string; readonly remediation: readonly string[] }
		| undefined;
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

/**
 * The locator a run reads its store's ids from: the owner's user settings. A
 * locator an older HoBo left in the working tree is moved there on first read
 * and removed from the tree.
 */
export function ownerLocator(deps: {
	readonly locator?: OwnerSettingsStore;
	readonly ownerChannel?: Pick<OwnerChannel, "storeSettings">;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
}): OwnerSettingsStore {
	if (deps.locator !== undefined) return deps.locator;
	if (deps.ownerChannel?.storeSettings !== undefined)
		return deps.ownerChannel.storeSettings;
	const cwd = deps.cwd ?? process.cwd();
	const user = fileSettingsStore(secretStoreLocatorPath(cwd, deps.env));
	const legacyPath = path.join(cwd, SECRET_STORE_LOCATOR_FILE);
	const legacy = fileSettingsStore(legacyPath);
	return {
		async read() {
			const saved = await user.read();
			if (Object.keys(saved).length > 0 || !existsSync(legacyPath))
				return saved;
			const moved = await legacy.read();
			await user.write(moved);
			await rm(legacyPath, { force: true });
			return moved;
		},
		write: (values) => user.write(values),
	};
}

export function isOwnerStoreSetting(name: string): boolean {
	return /^(?:HOBO_SECRET_STORE|INFISICAL_.*|OP_.*|BWS_.*|BITWARDEN_.*|BW_.*)$/u.test(
		name,
	);
}

export async function ownerStoreSessionEnvironment(
	deps: Pick<OwnerStoreDeps, "locator" | "ownerChannel" | "cwd">,
	env: Env,
): Promise<Env> {
	const locator = ownerLocator(deps);
	locator.assertCurrent?.();
	if (
		!locator.hasSessionChoice?.() ||
		!(await locator.read()).HOBO_SECRET_STORE
	)
		return env;
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !isOwnerStoreSetting(name)),
	);
}

/** Find the owner's store: committed locator, the run's vault, or a workload's OIDC. */
export async function ownerStore(
	family: "ci" | "cd",
	vault: TrustedVault,
	deps: OwnerStoreDeps = {},
): Promise<OwnerStore> {
	const suppliedEnv = await ownerStoreSessionEnvironment(deps, deps.env ?? {});
	const locator = ownerLocator({
		...deps,
		env: {
			XDG_CONFIG_HOME:
				suppliedEnv.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME,
			HOME: suppliedEnv.HOME ?? process.env.HOME,
		},
	});
	const open =
		deps.openStore ??
		((id: SecretStoreId, coordinates: Env, signIn: SecretHolder) =>
			openSecretStore(id, coordinates, signIn, deps));
	const saved = await locator.read();
	locator.assertCurrent?.();
	const guarded = (store: OpenedSecretStore): OpenedSecretStore => {
		if (!locator.assertCurrent) return store;
		const port = store.port;
		const check = locator.assertCurrent;
		const write = <T>(operation: () => Promise<T>): Promise<T> =>
			locator.runStoreWrite ? locator.runStoreWrite(operation) : operation();
		const mutate = <T>(operation: () => Promise<T>): Promise<T> =>
			write(async () => {
				check();
				try {
					return await operation();
				} catch (error) {
					locator.markUncertainWrite?.();
					throw error;
				}
			});
		return {
			...store,
			withWriteLock: write,
			port: {
				id: port.id,
				kind: port.kind,
				put: async (name, value) => {
					check();
					const result = await mutate(() => port.put(name, value));
					check();
					return result;
				},
				access: async (name) => {
					check();
					const result = await port.access(name);
					check();
					return result;
				},
				accessVersion: async (name, version) => {
					check();
					const result = await port.accessVersion(name, version);
					check();
					return result;
				},
				listVersions: async (name) => {
					check();
					const result = await port.listVersions(name);
					check();
					return result;
				},
				...(port.createOnly
					? {
							createOnly: async (name: string, value: string) => {
								check();
								const result = await mutate(
									() =>
										port.createOnly?.(name, value) ??
										Promise.resolve(undefined),
								);
								check();
								if (!result) throw new Error("Store operation unavailable.");
								return result;
							},
						}
					: undefined),
			},
		};
	};
	const env =
		!suppliedEnv.INFISICAL_SIGN_IN &&
		!saved.INFISICAL_SIGN_IN &&
		deps.defaultInfisicalSignIn !== undefined
			? { ...suppliedEnv, INFISICAL_SIGN_IN: deps.defaultInfisicalSignIn }
			: suppliedEnv;
	const ownerChose = Boolean(env.HOBO_SECRET_STORE || saved.HOBO_SECRET_STORE);
	// Only the owner chooses: a token in the environment says a provider is
	// configured and reachable, never that the owner chose it.
	const choice = resolveSettings([STORE_CHOICE], env, saved);
	const id = storeIdOf(choice.values.HOBO_SECRET_STORE);
	// CI's credentials are the relay's own (the GitHub App it runs): they
	// live in the relay's folder, which its deploy workflow writes, so an
	// App made once is found by every later hobo ci up.
	const folder = family === "ci" ? CI_RELAY_FOLDER : `/hobo-${family}`;
	const side = storeSettings(id, folder);
	const resolved = resolveSettings(side, env, saved, vault);
	// Bitwarden's provisioned ids (project, storage, collection, device) are
	// kept in the locator by the run, never asked for on the page.
	const internal = (from: Readonly<Record<string, string | undefined>>) =>
		Object.fromEntries(
			BITWARDEN_INTERNAL_SETTINGS.flatMap((name) => {
				const value = env[name] || from[name];
				return value ? [[name, value]] : [];
			}),
		);
	const coordinates =
		id === "bitwarden"
			? { ...internal(saved), ...resolved.values }
			: resolved.values;
	const bitwardenSignedIn =
		vault.has("BWS_ACCESS_TOKEN") ||
		vault.has("BITWARDEN_ORG_KEY") ||
		(vault.has("BW_CLIENTID") && vault.has("BW_CLIENTSECRET"));
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
	// Parsed where it enters: a malformed host was already refused as missing.
	const connectHost =
		id === "1password" && resolved.values.OP_CONNECT_HOST
			? parseHttpsOrigin("OP_CONNECT_HOST", resolved.values.OP_CONNECT_HOST)
			: undefined;
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
					(connectHost !== undefined && field.name === "OP_ACCOUNT") ||
					// Bitwarden: the API key is asked for only while the run holds
					// no sign-in (a token, the organization key, or the key itself).
					(id === "bitwarden" &&
						bitwardenSignedIn &&
						(field.name === "BW_CLIENTID" || field.name === "BW_CLIENTSECRET"))
				),
		),
		...oauthMissing,
	];

	let opened: OpenedSecretStore | undefined;
	let unopened: OwnerStore["unopened"];
	const lacking = [...choice.missing, ...missingSide];
	if (lacking.length === 0) {
		const attempt = await open(id, coordinates, vault);
		locator.assertCurrent?.();
		if (attempt.ok) opened = guarded(attempt.store);
		else
			unopened = {
				message: attempt.message,
				remediation: attempt.remediation,
			};
	} else
		unopened = {
			message: `${storeLabel(id)} needs ${lacking.map((field) => field.label).join(", ")} before it can open.`,
			remediation: [
				`Give ${lacking.map((field) => field.label).join(", ")} when the agent asks (the store choice form).`,
			],
		};

	return {
		id,
		chosen: ownerChose,
		missing: [...choice.missing, ...missingSide],
		canAwaitEgressCredential:
			(proxySignIn || connectHost !== undefined) &&
			choice.missing.length === 0 &&
			missingSide.length === 0,
		egressCredentialHost: proxySignIn
			? parseHttpsOrigin(
					"INFISICAL_SITE_URL",
					resolved.values.INFISICAL_SITE_URL ?? "https://app.infisical.com",
				)
			: connectHost,
		opened,
		infisicalFolder:
			id === "infisical"
				? {
						environment: resolved.values.INFISICAL_ENVIRONMENT ?? "prod",
						path: resolved.values.INFISICAL_SECRET_PATH ?? folder,
					}
				: undefined,
		unopened,
		async stage({ provider, reason, proceed }) {
			locator.assertCurrent?.();
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
					reason: `${reason} Which store and its ids are kept in your own HoBo settings, not the repository; the sign-in is held in memory for this run only.`,
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
						const prepared = await deps.beforeOpen?.(chosen, values);
						if (prepared !== undefined && !prepared.ok)
							return {
								ok: false,
								errors: {
									[settings.find((s) => s.field.kind === "secret")?.field
										.name ?? STORE_CHOICE.field.name]:
										`${prepared.message} ${prepared.remediation.join(" ")}`,
								},
							};
						const attempt = await open(
							chosen,
							chosen === "bitwarden"
								? {
										...internal(await locator.read()),
										...nonSecret(settings, values),
									}
								: nonSecret(settings, values),
							vault,
						);
						locator.assertCurrent?.();
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
						opened = guarded(attempt.store);
						return { ok: true, flow: await proceed(opened) };
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
