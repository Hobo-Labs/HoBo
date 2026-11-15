import { existsSync } from "node:fs";
import path from "node:path";

import { createTrustedVault, type TrustedVault } from "@hobo/core";
import {
	type OpenedSecretStore,
	ownerStore,
	SECRET_STORE_LOCATOR_FILE,
	withoutSecretEnv,
} from "@hobo/hobo-ci";

// Keys the composed `hobo` keeps for the owner across runs, held in the owner's
// secret store (the committed locator `.hobo/secret-store.json`) and read into
// this process's trusted vault before a verb runs. Nothing here is read from
// the environment or written to disk, so a devbox that is destroyed loses
// nothing: the next one signs in to the same store and finds the same keys.
//
//   HOBO_PULUMI_STATE_PASSPHRASE  the live Pulumi lane's retained workspace
//                                 (HOBO_PULUMI_WORKDIR): its file:// state is
//                                 encrypted under this, so it must be the same
//                                 on every run.
//   HOBO_CLAIM_ACTION_KEY         seals pending claim actions under HOBO_HOME.
//
// A missing key must be provisioned once by the owner. SecretsPort has no
// atomic create, so generating and putting a key here could race another
// machine and make its state or pending claim actions unreadable.

// public-contract: the store entry an owner keeps the retained Pulumi passphrase in.
export const PULUMI_STATE_KEY = "HOBO_PULUMI_STATE_PASSPHRASE";
// public-contract: the store entry the claim actions' sealing key lives in.
export const CLAIM_ACTION_KEY = "HOBO_CLAIM_ACTION_KEY";

/** The vault the composed process reads owner keys from. */
export const ownerKeys: TrustedVault = createTrustedVault();

export type OwnerKeysOutcome =
	| { readonly kind: "loaded"; readonly keys: readonly string[] }
	| { readonly kind: "no-store" }
	| {
			readonly kind: "refused";
			readonly code:
				| "HOBO_PULUMI_STATE_KEY_MISSING"
				| "HOBO_OWNER_KEY_MISSING"
				| "HOBO_OWNER_STORE_UNAVAILABLE";
			readonly message: string;
	  };

export interface LoadOwnerKeysInput {
	readonly env: NodeJS.ProcessEnv;
	/** The verb and its first argument: only the keys it uses are read. */
	readonly verb: string | null;
	readonly subcommand: string;
	/** Where the store locator is committed (the verb's working directory). */
	readonly cwd: string;
	readonly vault?: TrustedVault;
	/** Test seam: the opened store, or undefined when none can be opened. */
	readonly open?: () => Promise<OpenedSecretStore | undefined>;
}

async function openOwnerStore(
	input: LoadOwnerKeysInput,
): Promise<OpenedSecretStore | undefined> {
	if (input.open !== undefined) return input.open();
	// The store sign-in lives in its own vault and ends with this call.
	const signIn = createTrustedVault();
	try {
		const owner = await ownerStore("cd", signIn, {
			env: withoutSecretEnv(input.env),
			cwd: input.cwd,
		});
		return owner.opened;
	} finally {
		signIn.clear();
	}
}

/** Which keys this invocation uses (nothing opens the store for a verb that uses none). */
export function ownerKeysFor(
	input: Pick<LoadOwnerKeysInput, "env" | "verb" | "subcommand">,
): readonly string[] {
	const keys: string[] = [];
	if (
		input.verb === "claim" ||
		(input.verb === "ci" && input.subcommand === "secret-store")
	)
		keys.push(CLAIM_ACTION_KEY);
	if (input.env.HOBO_PULUMI_LIVE === "1" && input.env.HOBO_PULUMI_WORKDIR)
		keys.push(PULUMI_STATE_KEY);
	return keys;
}

/** Read the owner's pre-provisioned keys into the vault. */
export async function loadOwnerKeys(
	input: LoadOwnerKeysInput,
): Promise<OwnerKeysOutcome> {
	const vault = input.vault ?? ownerKeys;
	const keys = ownerKeysFor(input);
	if (keys.length === 0) return { kind: "loaded", keys: [] };
	const unavailable = (): OwnerKeysOutcome => {
		vault.clear();
		return {
			kind: "refused",
			code: "HOBO_OWNER_STORE_UNAVAILABLE",
			message:
				"Cannot open or read the owner's secret store; reconnect it before using retained state or claim actions.",
		};
	};
	let store: OpenedSecretStore | undefined;
	try {
		store = await openOwnerStore(input);
	} catch {
		return unavailable();
	}
	if (store === undefined) {
		if (
			existsSync(path.join(input.cwd, SECRET_STORE_LOCATOR_FILE)) ||
			input.env.HOBO_SECRET_STORE
		)
			return unavailable();
		return { kind: "no-store" };
	}
	const loaded: string[] = [];
	for (const name of keys) {
		const read = await store.port.access(name).catch(() => undefined);
		if (read === undefined) return unavailable();
		if (read.status === "ok" && read.material) {
			vault.put(name, read.material);
			loaded.push(name);
			continue;
		}
		if (read.status === "ok" || read.code !== "secret-not-found")
			return unavailable();
		if (
			name === PULUMI_STATE_KEY &&
			existsSync(path.join(String(input.env.HOBO_PULUMI_WORKDIR), "state"))
		) {
			vault.clear();
			return {
				kind: "refused",
				code: "HOBO_PULUMI_STATE_KEY_MISSING",
				message: `The retained Pulumi workspace has state, and ${store.id} holds no ${PULUMI_STATE_KEY}. Put the passphrase that workspace was made with in ${store.reference(PULUMI_STATE_KEY)}, then run again.`,
			};
		}
		vault.clear();
		return {
			kind: "refused",
			code: "HOBO_OWNER_KEY_MISSING",
			message: `Provision ${store.reference(name)} once in the owner's secret store before retrying. If this key already protects state or pending claims, use the original key.`,
		};
	}
	return { kind: "loaded", keys: loaded };
}
