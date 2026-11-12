/**
 * The Worker's handler over the in-memory Durable Object stand-in and the
 * local issuers, with a deploy-time binding built the way provisioning
 * builds it.
 */
import {
	type ConfigServiceEnv,
	createInMemoryConfigService,
	type InMemoryConfigService,
	formatOwnerAccess,
	formatWorkerBinding,
	newBootstrapCredential,
	newStoreId,
} from "../../src/index.js";
import {
	ACCESS_AUD,
	ACCESS_ISSUER,
	createIssuers,
	type Issuers,
	VERCEL_TEAM,
} from "./issuers.js";

export const ORIGIN = "https://hobo-config.hobo-test.workers.dev";

export type Harness = Readonly<{
	storeId: string;
	credential: string;
	issuers: Issuers;
	env: ConfigServiceEnv;
	storage: InMemoryConfigService["storage"];
	/** A request to the Worker; `fetch`-shaped so the client can use it. */
	fetch: typeof fetch;
}>;

export async function harness(
	options: Readonly<{
		owner?: boolean;
		bootstrapExpiresAt?: Date;
		repositoryId?: string;
	}> = {},
): Promise<Harness> {
	const storeId = newStoreId();
	const bootstrap = await newBootstrapCredential();
	const issuers = createIssuers();
	const service = createInMemoryConfigService(
		{
			HOBO_CONFIG_BINDING: formatWorkerBinding({
				storeId,
				vercelTeamSlug: VERCEL_TEAM,
				vercelTeamId: "team_fixture",
				vercelProjectName: "hobo-ci",
				vercelProjectId: "prj_fixture",
				repository: "Hobo-Labs/HoBo",
				...(options.repositoryId !== undefined
					? { repositoryId: options.repositoryId }
					: undefined),
				bootstrapSha256: bootstrap.sha256,
				bootstrapExpiresAt:
					options.bootstrapExpiresAt ?? new Date(Date.now() + 60 * 60_000),
			}),
			...(options.owner === true
				? {
						HOBO_CONFIG_OWNER_ACCESS: formatOwnerAccess(
							ACCESS_ISSUER,
							ACCESS_AUD,
						),
					}
				: undefined),
		},
		issuers.fetch,
	);
	return {
		storeId,
		credential: bootstrap.credential,
		issuers,
		env: service.env,
		storage: service.storage,
		fetch: service.fetch,
	};
}
