import { randomUUID } from "node:crypto";

import {
	type CdHost,
	composeCdHost,
	openCdRuntime,
	withOwnerJournalFleet,
} from "@hobo/hobo/cd-platform";
import type { OpenedSecretStore } from "@hobo/hobo-ci";

import { CdStoreBindingError } from "./store.js";

type Env = Readonly<Record<string, string | undefined>>;

export type CdHostDeps = Readonly<{
	env: Env;
	cwd: string;
	open: () => Promise<OpenedSecretStore> | OpenedSecretStore;
	now?: () => number;
}>;

export function topologyFilesOf(env: Env): readonly string[] {
	return (env.HOBO_CD_TOPOLOGY ?? "")
		.split(",")
		.map((file) => file.trim())
		.filter((file) => file.length > 0);
}

export function journalFleetEnvProvisioned(env: Env): boolean {
	const fleet = env.HOBO_CD_POSTGRES_FLEET?.trim();
	return fleet !== undefined && fleet.length > 0;
}

export function holderIdOf(env: Env): string {
	return `hobo-cd-vercel:${env.VERCEL_DEPLOYMENT_ID ?? "local"}:${randomUUID()}`;
}

export async function composeVercelCdHost(deps: CdHostDeps): Promise<CdHost> {
	const vercelEnv = deps.env.VERCEL_ENV;
	if (vercelEnv !== undefined && vercelEnv !== "production")
		throw new CdStoreBindingError(
			"cd-non-production-deployment",
			"HoBo.CD runs only on production deployments; this deployment does not open the production journal.",
		);
	const store = await deps.open();
	const journal = await withOwnerJournalFleet(deps.env, deps.cwd, async () =>
		Promise.resolve(store),
	);
	if (!journalFleetEnvProvisioned(journal.env))
		throw new CdStoreBindingError(
			"cd-journal-not-provisioned",
			"The owner's store holds no CD journal fleet. Run hobo cd up, which provisions it.",
		);
	const opened = await openCdRuntime({
		env: journal.env,
		...(journal.readSecret !== undefined
			? { readSecret: journal.readSecret }
			: undefined),
		home: "/tmp",
		cwd: deps.cwd,
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
		holderId: holderIdOf(deps.env),
		readiness: "composed",
		fleetPassLease: true,
		passDeadlineMs: 240_000,
	});
}

export function memoizedCdHost(
	compose: () => Promise<CdHost>,
): () => Promise<CdHost> {
	let pending: Promise<CdHost> | undefined;
	return () => {
		const attempt = pending ?? compose();
		pending = attempt;
		attempt.then(undefined, () => {
			if (pending === attempt) pending = undefined;
		});
		return attempt;
	};
}
