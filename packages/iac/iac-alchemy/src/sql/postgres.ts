import * as Neon from "@alchemy.run/neon";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Prisma from "@alchemy.run/prisma";
import type * as Migrations from "@alchemy.run/sql/Migrations";
import * as SQLPostgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import { validateAlchemyStage } from "../environments/index.js";

export type PostgresCloudProvider = "neon" | "planetscale" | "prisma";

export function selectDatabaseBranchForStage(
	stage: string,
	productionBranch = "main",
): string {
	const valid = validateAlchemyStage(stage);
	if (valid === "prod" || valid === "production") {
		return productionBranch;
	}
	return `preview-${valid}`;
}

export interface NeonPostgresStackSpec {
	readonly projectId: string;
	readonly projectName?: string;
	readonly branchId: string;
	readonly stage: string;
	readonly region?: Neon.NeonRegion;
	readonly pgVersion?: Neon.NeonPgVersion;
	readonly migrations?: Migrations.MigrationsInput;
	readonly roleId?: string;
	readonly roleName?: string;
}

export function declareNeonPostgresStack(spec: NeonPostgresStackSpec) {
	const branchName = selectDatabaseBranchForStage(spec.stage);
	const isProduction = spec.stage === "prod" || spec.stage === "production";
	return Effect.gen(function* () {
		const project = yield* Neon.Project(spec.projectId, {
			...(spec.projectName !== undefined
				? { name: spec.projectName }
				: undefined),
			region: spec.region ?? "aws-us-east-1",
			pgVersion: spec.pgVersion ?? 17,
		});
		const branch = yield* Neon.Branch(spec.branchId, {
			project,
			name: branchName,
			protected: isProduction,
			...(spec.migrations !== undefined
				? { migrations: spec.migrations }
				: undefined),
		});
		const role =
			spec.roleId !== undefined
				? yield* Neon.Role(spec.roleId, {
						branch,
						name: spec.roleName ?? "hobo_app",
					})
				: undefined;
		return {
			provider: "neon" as const,
			branchName,
			project,
			branch,
			role,
		};
	});
}

export interface PlanetscalePostgresStackSpec {
	readonly databaseId: string;
	readonly databaseName?: string;
	readonly branchId: string;
	readonly stage: string;
	readonly clusterSize?: Planetscale.PostgresClusterSize;
	readonly arch?: "x86" | "arm";
	readonly replicas?: number;
	readonly migrationsDir?: string;
}

export function declarePlanetscalePostgresStack(
	spec: PlanetscalePostgresStackSpec,
) {
	const branchName = selectDatabaseBranchForStage(spec.stage);
	return Effect.gen(function* () {
		const database = yield* Planetscale.PostgresDatabase(spec.databaseId, {
			...(spec.databaseName !== undefined
				? { name: spec.databaseName }
				: undefined),
			clusterSize: spec.clusterSize ?? "PS_10",
			arch: spec.arch ?? "arm",
		});
		const branch = yield* Planetscale.PostgresBranch(spec.branchId, {
			database,
			name: branchName,
			parentBranch: "main",
			...(spec.replicas !== undefined
				? { replicas: spec.replicas }
				: undefined),
			...(spec.migrationsDir !== undefined
				? { migrationsDir: spec.migrationsDir }
				: undefined),
		});
		return {
			provider: "planetscale" as const,
			branchName,
			database,
			branch,
		};
	});
}

export interface PrismaPostgresStackSpec {
	readonly projectId: string;
	readonly projectName?: string;
	readonly databaseId: string;
	readonly databaseName?: string;
	readonly stage: string;
	readonly region?: Prisma.Types.PrismaRegionId;
	readonly databaseRegion?: Prisma.Types.PrismaDatabaseRegionId;
}

export function declarePrismaPostgresStack(spec: PrismaPostgresStackSpec) {
	const branchName = selectDatabaseBranchForStage(spec.stage);
	return Effect.gen(function* () {
		const project = yield* Prisma.Project(spec.projectId, {
			...(spec.projectName !== undefined
				? { name: spec.projectName }
				: undefined),
			createDatabase: false,
			...(spec.region !== undefined ? { region: spec.region } : undefined),
		});
		const database = yield* Prisma.Database(spec.databaseId, {
			project,
			name: spec.databaseName ?? `${spec.databaseId}-${branchName}`,
			...(spec.databaseRegion !== undefined
				? { region: spec.databaseRegion }
				: undefined),
		});
		return {
			provider: "prisma" as const,
			branchName,
			project,
			database,
		};
	});
}

export { Neon, Planetscale, Prisma, SQLPostgres };
