export {
	declareTursoLibsqlStack,
	declareTursoTenantDatabaseFleet,
	Turso,
	type TursoLibsqlStackSpec,
	type TursoTenantFleetSpec,
} from "./libsql.js";
export {
	createMigrationsConfig,
	createNodeSqliteMigrationExecutor,
	DatabaseSync,
	Drizzle,
	type DrizzleSchemaResourceInput,
	declareDrizzleSchema,
	inspectDrizzleMigrationsDir,
	Migrations,
	runDrizzleMigrationsOnSqlite,
} from "./migrations.js";
export {
	declareNeonPostgresStack,
	declarePlanetscalePostgresStack,
	declarePrismaPostgresStack,
	Neon,
	type NeonPostgresStackSpec,
	Planetscale,
	type PlanetscalePostgresStackSpec,
	type PostgresCloudProvider,
	Prisma,
	type PrismaPostgresStackSpec,
	SQLPostgres,
	selectDatabaseBranchForStage,
} from "./postgres.js";

export interface SqlProviderDescriptor {
	readonly id: "neon" | "planetscale" | "prisma" | "turso" | "drizzle";
	readonly dialect: "postgres" | "libsql" | "multi";
	readonly supportsBranching: boolean;
	readonly supportsDrizzleMigrations: boolean;
	readonly alchemyPackage: string;
}

export function describeSqlProviderCatalog(): readonly SqlProviderDescriptor[] {
	return [
		{
			id: "drizzle",
			dialect: "multi",
			supportsBranching: false,
			supportsDrizzleMigrations: true,
			alchemyPackage: "@alchemy.run/drizzle",
		},
		{
			id: "neon",
			dialect: "postgres",
			supportsBranching: true,
			supportsDrizzleMigrations: true,
			alchemyPackage: "@alchemy.run/neon",
		},
		{
			id: "planetscale",
			dialect: "postgres",
			supportsBranching: true,
			supportsDrizzleMigrations: true,
			alchemyPackage: "@alchemy.run/planetscale",
		},
		{
			id: "prisma",
			dialect: "postgres",
			supportsBranching: true,
			supportsDrizzleMigrations: true,
			alchemyPackage: "@alchemy.run/prisma",
		},
		{
			id: "turso",
			dialect: "libsql",
			supportsBranching: false,
			supportsDrizzleMigrations: true,
			alchemyPackage: "@alchemy.run/turso",
		},
	];
}
