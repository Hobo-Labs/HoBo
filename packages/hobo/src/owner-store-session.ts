import path from "node:path";

import type { CredentialResolver } from "@hobo/cd";
import { createGithubAppTransport } from "@hobo/ci-gh-actions";
import {
	createTrustedVault,
	GITHUB_APP_CREDENTIAL_SCHEME,
	type GithubAppRepository,
	parseGithubAppInstallationRef,
	type TrustedVault,
} from "@hobo/core";
import {
	KEPT_STORE_SIGN_INS,
	type OpenedSecretStore,
	type OwnerChannel,
	type OwnerSignInOutcome,
	type OwnerStoreDeps,
	ownerStore,
	signInOwnerStore,
	storeLabel,
	withoutSecretEnv,
} from "@hobo/hobo-ci";
import { z } from "zod";

export type OwnerStoreLabel = "Infisical" | "1Password" | "Bitwarden";

export type OwnerSessionState =
	| Readonly<{ status: "established"; store: OwnerStoreLabel }>
	| Readonly<{ status: "unchosen" }>
	| Readonly<{
			status: "sign-in-needed";
			store: OwnerStoreLabel;
			code: string;
	  }>;

export type OwnerSessionStatus = Readonly<{
	established: boolean;
	store?: OwnerStoreLabel;
}>;

export interface OwnerStoreEntries {
	read(name: string): Promise<string | undefined>;
	write(name: string, value: string): Promise<void>;
}

export interface OwnerStoreSessions {
	establish(cwd: string): Promise<OwnerSessionState>;
	status(cwd: string): OwnerSessionStatus;
	credentials(cwd: string): CredentialResolver;
	entries(cwd: string): OwnerStoreEntries;
	close(): void;
}

export class OwnerCredentialUnavailable extends Error {
	constructor(
		readonly ref: string,
		readonly reason:
			| "no-session"
			| "not-in-store"
			| "environment-ref"
			| "unsupported-ref"
			| "github-app-missing"
			| "github-app-not-installed"
			| "github-app-refused",
	) {
		super(OwnerCredentialUnavailable.explain(ref, reason));
		this.name = "OwnerCredentialUnavailable";
	}

	private static explain(
		ref: string,
		reason: OwnerCredentialUnavailable["reason"],
	): string {
		switch (reason) {
			case "no-session":
				return `credential ${ref} needs the owner's store session: run HoBo MCP's choose_secret_store first`;
			case "not-in-store":
				return `credential ${ref} is not in the owner's store`;
			case "environment-ref":
				return `credential ${ref} names the process environment, which never holds credentials: store the entry in the owner's store, connect it with HoBo MCP's choose_secret_store, and use owner://<NAME>`;
			case "github-app-missing":
				return `credential ${ref} needs HoBo's GitHub App credentials (${GITHUB_APP_ID_ENTRY}, ${GITHUB_APP_PRIVATE_KEY_ENTRY}) in the owner's store relay folder: run hobo ci app create`;
			case "github-app-not-installed":
				return `credential ${ref} needs HoBo's GitHub App installed on that repository: install the App hobo ci app create made`;
			case "github-app-refused":
				return `credential ${ref} could not be minted: GitHub refused HoBo's GitHub App (check the App made by hobo ci app create)`;
			case "unsupported-ref":
				return `credential ${ref} is not resolvable on this host (use owner://<NAME> or ${GITHUB_APP_CREDENTIAL_SCHEME}<owner>/<repo> after HoBo MCP's choose_secret_store)`;
		}
	}
}

// public-contract: the owner-store entry hobo ci app create writes with HoBo's GitHub App id.
export const GITHUB_APP_ID_ENTRY = "HOBO_CI_GITHUB_APP_ID";
// public-contract: the owner-store entry hobo ci app create writes with HoBo's GitHub App private key.
export const GITHUB_APP_PRIVATE_KEY_ENTRY = "HOBO_CI_GITHUB_APP_PRIVATE_KEY";

const RepositoryInstallation = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

// public-contract: the credential locator scheme that reads an entry from the owner's store session.
export const OWNER_CREDENTIAL_SCHEME = "owner://";

const ENTRY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;

function labelOf(id: string): OwnerStoreLabel {
	const label = storeLabel(id);
	return label === "1Password" || label === "Bitwarden" ? label : "Infisical";
}

const ENVIRONMENT_SCHEME = "env://";

function entryOf(ref: string): string {
	if (ref.startsWith(ENVIRONMENT_SCHEME))
		throw new OwnerCredentialUnavailable(ref, "environment-ref");
	const name = ref.startsWith(OWNER_CREDENTIAL_SCHEME)
		? ref.slice(OWNER_CREDENTIAL_SCHEME.length)
		: "";
	if (!ENTRY_NAME.test(name))
		throw new OwnerCredentialUnavailable(ref, "unsupported-ref");
	return name;
}

type Held = Readonly<{
	store: OpenedSecretStore;
	vault: TrustedVault;
	label: OwnerStoreLabel;
}>;

export type OwnerSignIn = (input: {
	readonly cwd: string;
	readonly vault: TrustedVault;
}) => Promise<OwnerSignInOutcome>;

export function ownerChannelSignIn(options: {
	readonly owner: OwnerChannel;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly deps?: Omit<OwnerStoreDeps, "env" | "cwd" | "ownerChannel">;
}): OwnerSignIn {
	return async ({ cwd, vault }) => {
		const plainEnv = withoutSecretEnv(options.env ?? process.env);
		const deps: OwnerStoreDeps = {
			...options.deps,
			env: plainEnv,
			cwd,
			ownerChannel: options.owner,
			noBrowser: true,
		};
		return signInOwnerStore({
			family: "cd",
			vault,
			open: () => ownerStore("cd", vault, deps),
			deps,
			plainEnv,
			workloadOidc: undefined,
			whatIf: false,
			handOff: true,
			silent: true,
			emit: () => undefined,
		});
	};
}

export type OwnerRelayFolder = (input: {
	readonly cwd: string;
	readonly vault: TrustedVault;
}) => Promise<OpenedSecretStore | undefined>;

export function ownerChannelRelayFolder(options: {
	readonly owner: OwnerChannel;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly deps?: Omit<OwnerStoreDeps, "env" | "cwd" | "ownerChannel">;
}): OwnerRelayFolder {
	return async ({ cwd, vault }) => {
		const relay = await ownerStore("ci", vault, {
			...options.deps,
			env: withoutSecretEnv(options.env ?? process.env),
			cwd,
			ownerChannel: options.owner,
			noBrowser: true,
		});
		return relay.opened;
	};
}

async function readMaterial(
	port: OpenedSecretStore["port"],
	name: string,
): Promise<string | undefined> {
	const read = await port.access(name).catch(() => undefined);
	return read?.status === "ok" &&
		read.material !== undefined &&
		read.material !== ""
		? read.material
		: undefined;
}

async function mintInstallationToken(input: {
	readonly ref: string;
	readonly repository: GithubAppRepository;
	readonly relay: OpenedSecretStore | undefined;
	readonly fetch: typeof fetch | undefined;
}): Promise<string> {
	const appId =
		input.relay && (await readMaterial(input.relay.port, GITHUB_APP_ID_ENTRY));
	const privateKey =
		input.relay &&
		(await readMaterial(input.relay.port, GITHUB_APP_PRIVATE_KEY_ENTRY));
	if (!appId || !privateKey)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-missing");
	const app = createGithubAppTransport({
		appId: appId.trim(),
		privateKey,
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
	const installation = await app
		.appRequest(
			`/repos/${input.repository.owner}/${input.repository.repo}/installation`,
		)
		.catch(() => undefined);
	if (installation === undefined || installation.status >= 500)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-refused");
	if (installation.status === 404)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-not-installed");
	const parsed = installation.ok
		? RepositoryInstallation.safeParse(
				await installation.json().catch(() => undefined),
			)
		: undefined;
	if (parsed === undefined || !parsed.success)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-refused");
	return app.installationToken(parsed.data.id).catch(() => {
		throw new OwnerCredentialUnavailable(input.ref, "github-app-refused");
	});
}

export function createOwnerStoreSessions(options: {
	readonly signIn: OwnerSignIn;
	readonly relayFolder?: OwnerRelayFolder;
	readonly fetch?: typeof fetch;
	readonly kept?: TrustedVault;
}): OwnerStoreSessions {
	const held = new Map<string, Held>();
	const keyOf = (cwd: string) => path.resolve(cwd);
	const drop = (key: string) => {
		held.get(key)?.vault.clear();
		held.delete(key);
	};
	return {
		async establish(cwd) {
			const key = keyOf(cwd);
			const vault = createTrustedVault();
			let outcome: OwnerSignInOutcome;
			try {
				outcome = await options.signIn({ cwd: key, vault });
			} catch {
				vault.clear();
				return {
					status: "sign-in-needed",
					store: "Infisical",
					code: "HOBO_OWNER_STORE_UNAVAILABLE",
				};
			}
			if (outcome.kind === "refused") {
				vault.clear();
				const current = held.get(key);
				return {
					status: "sign-in-needed",
					store: current?.label ?? "Infisical",
					code: outcome.code,
				};
			}
			const owner = outcome.owner;
			if (!owner.chosen) {
				vault.clear();
				return { status: "unchosen" };
			}
			const label = labelOf(owner.id);
			if (owner.opened === undefined) {
				vault.clear();
				return {
					status: "sign-in-needed",
					store: label,
					code: "HOBO_OWNER_SIGN_IN",
				};
			}
			for (const name of KEPT_STORE_SIGN_INS) {
				const value = vault.reveal(name);
				if (value !== undefined) options.kept?.put(name, value);
			}
			drop(key);
			held.set(key, { store: owner.opened, vault, label });
			return { status: "established", store: label };
		},
		status(cwd) {
			const current = held.get(keyOf(cwd));
			return current === undefined
				? { established: false }
				: { established: true, store: current.label };
		},
		credentials(cwd) {
			const key = keyOf(cwd);
			return {
				async resolve(ref) {
					const repository = parseGithubAppInstallationRef(ref);
					const name = repository === undefined ? entryOf(ref) : undefined;
					const current = held.get(key);
					if (current === undefined)
						throw new OwnerCredentialUnavailable(ref, "no-session");
					if (repository !== undefined) {
						const relay = await options
							.relayFolder?.({ cwd: key, vault: current.vault })
							.catch(() => undefined);
						return {
							token: await mintInstallationToken({
								ref,
								repository,
								relay,
								fetch: options.fetch,
							}),
						};
					}
					const material =
						name === undefined
							? undefined
							: await readMaterial(current.store.port, name);
					if (material === undefined)
						throw new OwnerCredentialUnavailable(ref, "not-in-store");
					return { token: material };
				},
			};
		},
		entries(cwd) {
			const key = keyOf(cwd);
			const opened = (name: string) => {
				const ref = `${OWNER_CREDENTIAL_SCHEME}${entryOf(`${OWNER_CREDENTIAL_SCHEME}${name}`)}`;
				const current = held.get(key);
				if (current === undefined)
					throw new OwnerCredentialUnavailable(ref, "no-session");
				return current.store.port;
			};
			return {
				async read(name) {
					return readMaterial(opened(name), name);
				},
				async write(name, value) {
					await opened(name).put(name, value);
				},
			};
		},
		close() {
			for (const key of held.keys()) drop(key);
		},
	};
}
