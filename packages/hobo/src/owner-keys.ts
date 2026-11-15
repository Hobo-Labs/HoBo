import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { createTrustedVault, type TrustedVault } from "@hobo/core";
import {
	type OpenedSecretStore,
	ownerStore,
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
// A key the store does not hold yet is made here (32 random bytes) and put in
// the store before it is used, so it is never only in memory. The one refusal:
// a retained Pulumi workspace that already has state but no key in the store,
// whose original passphrase only the owner knows.

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
			readonly code: "HOBO_PULUMI_STATE_KEY_MISSING";
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
	} catch {
		return undefined;
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

/** Read (or make and keep) the owner's keys into the vault. */
export async function loadOwnerKeys(
	input: LoadOwnerKeysInput,
): Promise<OwnerKeysOutcome> {
	const vault = input.vault ?? ownerKeys;
	const keys = ownerKeysFor(input);
	if (keys.length === 0) return { kind: "loaded", keys: [] };
	const store = await openOwnerStore(input);
	if (store === undefined) return { kind: "no-store" };
	const loaded: string[] = [];
	for (const name of keys) {
		const read = await store.port.access(name).catch(() => undefined);
		if (read === undefined) return { kind: "no-store" };
		if (read.status === "ok" && read.material) {
			vault.put(name, read.material);
			loaded.push(name);
			continue;
		}
		if (read.status === "ok" || read.code !== "secret-not-found")
			return { kind: "no-store" };
		if (
			name === PULUMI_STATE_KEY &&
			existsSync(path.join(String(input.env.HOBO_PULUMI_WORKDIR), "state"))
		)
			return {
				kind: "refused",
				code: "HOBO_PULUMI_STATE_KEY_MISSING",
				message: `The retained Pulumi workspace has state, and ${store.id} holds no ${PULUMI_STATE_KEY}. Put the passphrase that workspace was made with in ${store.reference(PULUMI_STATE_KEY)}, then run again.`,
			};
		const made =
			name === CLAIM_ACTION_KEY
				? randomBytes(32).toString("base64")
				: randomBytes(32).toString("base64url");
		await store.port.put(name, made);
		vault.put(name, made);
		loaded.push(name);
	}
	return { kind: "loaded", keys: loaded };
}
