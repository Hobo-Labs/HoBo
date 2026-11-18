import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	PostgresStrictFleetStore,
	SqliteStrictFleetStore,
	type StrictFleetStore,
} from "@hobo/ci/fleet-v2";
import { Pool } from "pg";
import { z } from "zod";
import type { StartFencePolicy } from "./start-fence-handler.js";

const identifier = z.string().min(1).max(200);
const githubId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repositoryName = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/([A-Za-z0-9_.-]{1,100})$/u);
const policySchema = z
	.strictObject({
		accountId: identifier,
		engineId: identifier,
		installationId: githubId,
		profileId: identifier,
		runnerGroupId: githubId,
		requiredLabels: z.array(identifier).min(1).max(32),
		repositories: z
			.array(z.strictObject({ id: githubId, name: repositoryName }))
			.min(1)
			.max(256),
	})
	.superRefine((policy, context) => {
		if (new Set(policy.requiredLabels).size !== policy.requiredLabels.length)
			context.addIssue({
				code: "custom",
				message: "required labels must be unique",
				path: ["requiredLabels"],
			});
		const repositoryIds = policy.repositories.map((entry) => entry.id);
		const repositoryNames = policy.repositories.map((entry) =>
			entry.name.toLowerCase(),
		);
		if (
			new Set(repositoryIds).size !== repositoryIds.length ||
			new Set(repositoryNames).size !== repositoryNames.length
		)
			context.addIssue({
				code: "custom",
				message: "repositories must be unique",
				path: ["repositories"],
			});
	});
const policiesSchema = z.array(policySchema).min(1).max(1000);

export type StrictFleetRuntime = Readonly<{
	store: StrictFleetStore;
	policies: readonly StartFencePolicy[];
	close(): Promise<void>;
}>;

function loadPolicies(path: string): readonly StartFencePolicy[] {
	const policies = policiesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	const identities = policies.map(
		(policy) =>
			`${policy.accountId}\0${policy.engineId}\0${policy.installationId}\0${policy.profileId}`,
	);
	if (new Set(identities).size !== identities.length)
		throw new Error("strict fleet policies must have unique identities");
	return policies;
}

export async function createStrictFleetRuntime(
	env: NodeJS.ProcessEnv,
	options: { readonly requirePostgres: boolean },
): Promise<StrictFleetRuntime | undefined> {
	const database = env.HOBO_CI_STRICT_FLEET_DATABASE;
	const policyFile = env.HOBO_CI_STRICT_FLEET_POLICIES_FILE;
	if (!database && !policyFile) return undefined;
	if (!database || !policyFile)
		throw new Error(
			"strict fleet database and policies must be configured together",
		);
	const policies = loadPolicies(policyFile);
	if (/^postgres(?:ql)?:\/\//u.test(database)) {
		const pool = new Pool({ connectionString: database, max: 4 });
		const store = new PostgresStrictFleetStore(
			pool,
			env.HOBO_CI_STRICT_FLEET_PARTITION ?? "default",
		);
		try {
			await store.initialize();
		} catch (error) {
			await pool.end();
			throw error;
		}
		return {
			store,
			policies,
			close: () => pool.end(),
		};
	}
	if (options.requirePostgres)
		throw new Error("hosted strict fleet mode requires PostgreSQL");
	if (database !== ":memory:" && !isAbsolute(database))
		throw new Error("strict fleet SQLite path must be absolute");
	const store = new SqliteStrictFleetStore(database);
	await store.initialize();
	return {
		store,
		policies,
		close: async () => store.close(),
	};
}
