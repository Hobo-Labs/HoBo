import {
	type CdHost,
	composeCdHost,
	openCdRuntime,
	withOwnerJournalFleet,
} from "@hobo/hobo/cd-platform";
import type { OpenedSecretStore } from "@hobo/hobo-ci";

import { CdStoreBindingError } from "./store.js";

// HoBo.CD as a Vercel function composes once per instance: the owner's store
// (signed in with the deployment's OIDC token), the journal fleet whose
// roster and connection strings `hobo cd up` keeps there, the CD runtime on
// that fleet, and the CD mount. A function has no disk worth a journal, so a
// store with no fleet is refused rather than falling back to SQLite.

type Env = Readonly<Record<string, string | undefined>>;

export type CdHostDeps = Readonly<{
	env: Env;
	/** Where the function runs; topology files are read relative to it. */
	cwd: string;
	/** Open the owner's store (a fresh sign-in each time). */
	open: () => Promise<OpenedSecretStore> | OpenedSecretStore;
	now?: () => number;
}>;

/** The topology files a deployment declares (`HOBO_CD_TOPOLOGY`, comma-separated). */
export function topologyFilesOf(env: Env): readonly string[] {
	return (env.HOBO_CD_TOPOLOGY ?? "")
		.split(",")
		.map((file) => file.trim())
		.filter((file) => file.length > 0);
}

/** Compose the CD host on the owner's journal fleet. */
export async function composeVercelCdHost(deps: CdHostDeps): Promise<CdHost> {
	const store = await deps.open();
	const journal = await withOwnerJournalFleet(deps.env, deps.cwd, async () =>
		Promise.resolve(store),
	);
	if (journal.env.HOBO_CD_POSTGRES_FLEET === undefined)
		throw new CdStoreBindingError(
			"cd-journal-not-provisioned",
			"The owner's store holds no CD journal fleet. Run hobo cd up, which provisions it.",
		);
	const opened = await openCdRuntime({
		env: journal.env,
		...(journal.readSecret !== undefined
			? { readSecret: journal.readSecret }
			: undefined),
		// Unused with a fleet journal; the parser takes a home for SQLite.
		home: "/tmp",
		cwd: deps.cwd,
		// A deployed CD converges for real; simulation is a CLI flag.
		simulate: false,
		topologyFiles: topologyFilesOf(deps.env),
		...(deps.now !== undefined ? { now: deps.now } : undefined),
	});
	if (!opened.ok) {
		const [reason] = opened.reasons;
		throw new CdStoreBindingError(
			reason?.code || "cd-runtime-refused",
			reason?.message || "The CD runtime could not open.",
		);
	}
	return composeCdHost({
		runtime: opened.value,
		holderId: `hobo-cd-vercel:${deps.env.VERCEL_DEPLOYMENT_ID ?? "local"}`,
		readiness: "composed",
	});
}

/**
 * One host per instance, composed on first use. A failed composition is
 * forgotten, so the next request tries again (the store or a member may only
 * have been briefly unreachable).
 */
export function memoizedCdHost(
	compose: () => Promise<CdHost>,
): () => Promise<CdHost> {
	let pending: Promise<CdHost> | undefined;
	return () => {
		pending ??= compose().catch((error: unknown) => {
			pending = undefined;
			throw error;
		});
		return pending;
	};
}
