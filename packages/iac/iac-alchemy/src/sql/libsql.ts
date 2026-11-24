import type * as Migrations from "@alchemy.run/sql/Migrations";
import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";
import { validateAlchemyStage } from "../environments/index.js";

export interface TursoLibsqlStackSpec {
	readonly groupId: string;
	readonly groupName?: string;
	readonly location?: Turso.Location;
	readonly databaseId: string;
	readonly databaseName?: string;
	readonly stage: string;
	readonly migrations?: Migrations.MigrationsInput;
	readonly deleteProtection?: boolean;
}

export function declareTursoLibsqlStack(spec: TursoLibsqlStackSpec) {
	const stage = validateAlchemyStage(spec.stage);
	const isProduction = stage === "prod" || stage === "production";
	return Effect.gen(function* () {
		const group = yield* Turso.Group(spec.groupId, {
			...(spec.groupName !== undefined ? { name: spec.groupName } : undefined),
			location: spec.location ?? "aws-us-east-1",
			deleteProtection: spec.deleteProtection ?? isProduction,
		});
		const database = yield* Turso.Database(spec.databaseId, {
			...(spec.databaseName !== undefined
				? { name: spec.databaseName }
				: undefined),
			group: group.name,
			deleteProtection: spec.deleteProtection ?? isProduction,
			...(spec.migrations !== undefined
				? { migrations: spec.migrations }
				: undefined),
		});
		return {
			provider: "turso" as const,
			stage,
			group,
			database,
		};
	});
}

export interface TursoTenantFleetSpec {
	readonly groupId: string;
	readonly groupName?: string;
	readonly location?: Turso.Location;
	readonly tenantIds: readonly string[];
	readonly migrations?: Migrations.MigrationsInput;
}

export function declareTursoTenantDatabaseFleet(spec: TursoTenantFleetSpec) {
	return Effect.gen(function* () {
		const group = yield* Turso.Group(spec.groupId, {
			...(spec.groupName !== undefined ? { name: spec.groupName } : undefined),
			location: spec.location ?? "aws-us-east-1",
		});
		const databases = [];
		for (const tenantId of spec.tenantIds) {
			const db = yield* Turso.Database(`tenant-${tenantId}`, {
				group: group.name,
				...(spec.migrations !== undefined
					? { migrations: spec.migrations }
					: undefined),
			});
			databases.push({ tenantId, database: db });
		}
		return {
			provider: "turso" as const,
			group,
			databases,
		};
	});
}

export { Turso };
