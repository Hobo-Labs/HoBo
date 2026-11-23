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
	  }>;

export type OwnerSessionStatus = Readonly<{
	established: boolean;
	store?: OwnerStoreLabel;
}>;

export interface OwnerStoreSessions {
	establish(cwd: string): Promise<OwnerSessionState>;
	status(cwd: string): OwnerSessionStatus;
	credentials(cwd: string): CredentialResolver;
	close(): void;
}

export class OwnerCredentialUnavailable extends Error {
	constructor(
		readonly ref: string,
		readonly reason: "no-session" | "not-in-store" | "unsupported-ref",
	) {
		super(
			reason === "no-session"
				? `credential ${ref} needs the owner's store session: run HoBo MCP's choose_secret_store first`
				: reason === "not-in-store"
					? `credential ${ref} is not in the owner's store`
					: `credential ${ref} is not resolvable on this host (use env://<NAME> or owner://<NAME>)`,
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

function entryOf(
	ref: string,
): Readonly<{ name: string; env: boolean }> | undefined {
	const scheme = ref.startsWith("env://")
		? "env://"
		: ref.startsWith(OWNER_CREDENTIAL_SCHEME)
			? OWNER_CREDENTIAL_SCHEME
			: undefined;
	if (scheme === undefined) return undefined;
	const name = ref.slice(scheme.length);
	return ENTRY_NAME.test(name) ? { name, env: scheme === "env://" } : undefined;
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

export function createOwnerStoreSessions(options: {
	readonly signIn: OwnerSignIn;
	readonly kept?: TrustedVault;
	readonly env?: Readonly<Record<string, string | undefined>>;
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
			const env = options.env ?? process.env;
			return {
				async resolve(ref) {
					const entry = entryOf(ref);
					if (entry === undefined)
						throw new OwnerCredentialUnavailable(ref, "unsupported-ref");
					const ambient = entry.env ? env[entry.name] : undefined;
					if (ambient !== undefined && ambient !== "")
						return { token: ambient };
					const current = held.get(key);
					if (current === undefined)
						throw new OwnerCredentialUnavailable(ref, "no-session");
					const read = await current.store.port
						.access(entry.name)
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
		close() {
			for (const key of held.keys()) drop(key);
		},
	};
}
