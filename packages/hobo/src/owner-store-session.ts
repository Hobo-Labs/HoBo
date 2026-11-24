import path from "node:path";

import type { CredentialResolver } from "@hobo/cd";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
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

export type OwnerStoreLabel = "Infisical" | "1Password" | "Bitwarden";

export type OwnerSessionState =
	| Readonly<{ status: "established"; store: OwnerStoreLabel }>
	| Readonly<{ status: "unchosen" }>
	| Readonly<{
			status: "sign-in-needed";
			store: OwnerStoreLabel;
			code: string;
			reason?: string;
	  }>;

export type OwnerSessionStatus = Readonly<{
	established: boolean;
	store?: OwnerStoreLabel;
}>;

export interface OwnerStoreEntries {
	read(name: string): Promise<string | undefined>;
	write(name: string, value: string): Promise<void>;
}

const LINK = /\bhttps?:\/\/\S+/gu;
const IDENTIFIER =
	/\b(?:(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}|[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){2,})\b/gu;

export function publicReason(message: string): string {
	return message
		.replace(LINK, "<link>")
		.replace(IDENTIFIER, "<id>")
		.slice(0, 300);
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
			| "unsupported-ref",
	) {
		super(
			reason === "no-session"
				? `credential ${ref} needs the owner's store session: run HoBo MCP's choose_secret_store first`
				: reason === "not-in-store"
					? `credential ${ref} is not in the owner's store`
					: reason === "environment-ref"
						? `credential ${ref} names the process environment, which never holds credentials: store the entry in the owner's store, connect it with HoBo MCP's choose_secret_store, and use owner://<NAME>`
						: `credential ${ref} is not resolvable on this host (use owner://<NAME> after HoBo MCP's choose_secret_store)`,
		);
		this.name = "OwnerCredentialUnavailable";
	}
}

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
			open: (resolved) =>
				ownerStore("cd", vault, {
					...deps,
					env: { ...plainEnv, ...resolved },
				}),
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

export function createOwnerStoreSessions(options: {
	readonly signIn: OwnerSignIn;
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
					reason: publicReason(outcome.message),
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
					const name = entryOf(ref);
					const current = held.get(key);
					if (current === undefined)
						throw new OwnerCredentialUnavailable(ref, "no-session");
					const read = await current.store.port
						.access(name)
						.catch(() => undefined);
					if (
						read === undefined ||
						read.status !== "ok" ||
						read.material === undefined ||
						read.material === ""
					)
						throw new OwnerCredentialUnavailable(ref, "not-in-store");
					return { token: read.material };
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
					const port = opened(name);
					const read = await port.access(name).catch(() => undefined);
					return read?.status === "ok" &&
						read.material !== undefined &&
						read.material !== ""
						? read.material
						: undefined;
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
