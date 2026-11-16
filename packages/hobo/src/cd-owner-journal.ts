
import { createTrustedVault } from "@hobo/core";
import { journalFleetRuntime } from "@hobo/hobo-cd";
import {
	hasSecretStoreLocator,
	type OpenedSecretStore,
	ownerStore,
	withoutSecretEnv,
	workloadOidcOf,
} from "@hobo/hobo-ci";

import type { CdSecretReader } from "./cd-store.js";

// The CD journal fleet `hobo cd up` provisioned, for the CD runtime a verb
// opens (`hobo serve cd`, `hobo deploy`): its shape from the owner's stored
// settings and its connection strings read from the store when the journal
// opens. Only where the project commits a store locator, and only when the
// environment selects no journal of its own.

export type OwnerJournal = Readonly<{
	env: Readonly<Record<string, string | undefined>>;
	readSecret?: CdSecretReader;
}>;

export async function withOwnerJournalFleet(
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
	open?: () => Promise<OpenedSecretStore | undefined>,
): Promise<OwnerJournal> {
	if (
		env.HOBO_CD_POSTGRES_FLEET !== undefined ||
		env.HOBO_CD_POSTGRES_URL !== undefined ||
		(open === undefined && !hasSecretStoreLocator(cwd, env))
	)
		return { env };
	const signIn = createTrustedVault();
	let store: OpenedSecretStore | undefined;
	try {
		const workloadOidc = workloadOidcOf(env);
		store =
			open !== undefined
				? await open()
				: (
						await ownerStore("cd", signIn, {
							env: withoutSecretEnv(env),
							cwd,
							...(workloadOidc !== undefined ? { workloadOidc } : undefined),
						})
					).opened;
	} catch {
		throw new Error("Cannot open the owner's secret store for the CD journal.");
	} finally {
		signIn.clear();
	}
	if (store === undefined)
		throw new Error("Cannot open the owner's secret store for the CD journal.");
	const fleet = await journalFleetRuntime(store);
	if (Object.keys(fleet.env).length === 0) return { env };
	return { env: { ...env, ...fleet.env }, readSecret: fleet.readSecret };
}
