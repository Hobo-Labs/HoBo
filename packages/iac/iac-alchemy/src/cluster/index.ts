import * as ClusterDatabase from "@alchemy.run/effect-cluster/Database";
import * as ClusterProviders from "@alchemy.run/effect-cluster/Providers";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { validateAlchemyStage } from "../environments/index.js";

export type FleetClusterPoolTarget =
	| "cloudflare-durable-object"
	| "docker"
	| "aws"
	| "gcp"
	| "kubernetes"
	| "fly"
	| "hetzner";

export class HoboClusterConfigError extends Data.TaggedError(
	"HoboClusterConfigError",
)<{
	readonly code:
		| "INVALID_DATABASE_KEY"
		| "INVALID_SHARD_GROUP"
		| "INVALID_REPLICAS";
	readonly message: string;
}> {}

const CONFIG_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SHARD_GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export interface FleetClusterTopologyInput {
	readonly stage: string;
	readonly target: FleetClusterPoolTarget;
	readonly shardGroup?: string;
	readonly replicas?: number;
	readonly databaseUrlConfigKey?: string;
	readonly entities?: readonly string[];
	readonly singletons?: readonly string[];
	readonly crons?: readonly string[];
}

export interface FleetClusterTopology {
	readonly stage: string;
	readonly target: FleetClusterPoolTarget;
	readonly shardGroup: string;
	readonly replicas: number;
	readonly databaseUrlConfigKey: string;
	readonly entities: readonly string[];
	readonly singletons: readonly string[];
	readonly crons: readonly string[];
}

export function createHoboClusterDatabaseLayer(
	databaseUrlConfigKey = "CLUSTER_DATABASE_URL",
) {
	if (!CONFIG_KEY_PATTERN.test(databaseUrlConfigKey)) {
		throw new HoboClusterConfigError({
			code: "INVALID_DATABASE_KEY",
			message: `invalid cluster database config key: ${databaseUrlConfigKey}`,
		});
	}
	return ClusterDatabase.fromUrl({
		url: Config.Redacted(databaseUrlConfigKey),
	});
}

export function createHoboClusterProviders() {
	return ClusterProviders.providers();
}

export function describeFleetClusterTopology(
	input: FleetClusterTopologyInput,
): FleetClusterTopology {
	const stage = validateAlchemyStage(input.stage);
	const shardGroup = input.shardGroup ?? "fleet-default";
	if (!SHARD_GROUP_PATTERN.test(shardGroup)) {
		throw new HoboClusterConfigError({
			code: "INVALID_SHARD_GROUP",
			message: `invalid cluster shard group: ${shardGroup}`,
		});
	}
	const replicas = input.replicas ?? 2;
	if (!Number.isInteger(replicas) || replicas < 1 || replicas > 64) {
		throw new HoboClusterConfigError({
			code: "INVALID_REPLICAS",
			message: `cluster pool replicas must be an integer between 1 and 64, received ${replicas}`,
		});
	}
	const databaseUrlConfigKey =
		input.databaseUrlConfigKey ?? "CLUSTER_DATABASE_URL";
	if (!CONFIG_KEY_PATTERN.test(databaseUrlConfigKey)) {
		throw new HoboClusterConfigError({
			code: "INVALID_DATABASE_KEY",
			message: `invalid cluster database config key: ${databaseUrlConfigKey}`,
		});
	}
	return {
		stage,
		target: input.target,
		shardGroup,
		replicas,
		databaseUrlConfigKey,
		entities: input.entities ?? ["StationFleetCoordinator"],
		singletons: input.singletons ?? ["hobo-ci-fleet-lease-reaper"],
		crons: input.crons ?? ["hobo-ci-fleet-health-sweep"],
	};
}

export function resolveClusterDatabaseBinding(
	databaseUrlConfigKey = "CLUSTER_DATABASE_URL",
) {
	const dbLayer = createHoboClusterDatabaseLayer(databaseUrlConfigKey);
	return Effect.gen(function* () {
		const database = yield* ClusterDatabase.Database;
		return {
			hasShardGroups: database.shardGroups !== undefined,
			hasUrl: database.url !== undefined,
		};
	}).pipe(Effect.provide(dbLayer));
}

export { ClusterDatabase, ClusterProviders, Layer };
