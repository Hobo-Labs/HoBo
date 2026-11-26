import type { LiveDataDualPort } from "./data-dual-port.js";
import type { JsonObject } from "./json.js";
import { MIGRATION_EVENTS, type MigrationFact } from "./migration-executor.js";

export const TENANT_MOVE_SCHEMA = "hobo.tenant-move/v1";

export type TenantFencePort = Readonly<{
	raiseFence: (input: {
		readonly tenant: string;
		readonly streamIds: readonly string[];
	}) => { readonly fenceToken: string };
}>;

export type TenantTransferPort = Readonly<{
	exportTenant: (tenant: string) => {
		readonly exportId: string;
		readonly streamCount: number;
		readonly headSeq: number;
	};
	importTenant: (input: {
		readonly tenant: string;
		readonly exportId: string;
	}) => { readonly importedHeadSeq: number; readonly streamCount: number };
}>;

export interface TenantMovePorts {
	readonly fence: TenantFencePort;
	readonly transfer: TenantTransferPort;
	drain(): number;
	reap(): { readonly reaped: number };
	readonly facts: readonly MigrationFact[];
}

export interface CreateTenantMovePortsOptions {
	readonly dual: LiveDataDualPort;
	readonly tenant: string;
	readonly clock?: () => string;
	readonly onFact?: (fact: MigrationFact) => void;
}

export function createTenantMovePorts(
	options: CreateTenantMovePortsOptions,
): TenantMovePorts {
	const { dual, tenant } = options;
	const clock = options.clock ?? (() => new Date().toISOString());
	const facts: MigrationFact[] = [];
	const emit = (type: string, data: JsonObject) => {
		const fact = Object.freeze({ type, data: Object.freeze({ ...data }) });
		facts.push(fact);
		options.onFact?.(fact);
	};

	const counts = () => {
		const evidence = dual.evidence?.();
		if (evidence !== undefined) {
			return { source: evidence.source.count, target: evidence.target.count };
		}
		const view = dual.snapshot();
		return { source: view.sourceRows.length, target: view.targetRows.length };
	};

	const exports = new Map<string, { headSeq: number; streamCount: number }>();
	let exportCounter = 0;

	function drain(): number {
		while (dual.lag() > 0) {
			dual.replicate();
		}
		return dual.headSeq();
	}

	return {
		facts,
		drain,
		fence: Object.freeze({
			raiseFence(input: {
				readonly tenant: string;
				readonly streamIds: readonly string[];
			}) {
				if (input.tenant !== tenant) {
					throw new Error(
						`fence port is scoped to ${tenant}; got ${input.tenant}`,
					);
				}
				return dual.raiseFence(input.tenant);
			},
		}),
		transfer: Object.freeze({
			exportTenant(forTenant: string) {
				if (forTenant !== tenant) {
					throw new Error(
						`transfer port is scoped to ${tenant}; got ${forTenant}`,
					);
				}
				const headSeq = drain();
				const streamCount = counts().source;
				exportCounter += 1;
				const exportId = `export:${tenant}:${exportCounter}`;
				exports.set(exportId, { headSeq, streamCount });
				emit(MIGRATION_EVENTS.Exported, {
					tenant,
					exportId,
					headSeq,
					streamCount,
					exportedAt: clock(),
				});
				return { exportId, streamCount, headSeq };
			},
			importTenant(input: {
				readonly tenant: string;
				readonly exportId: string;
			}) {
				if (input.tenant !== tenant) {
					throw new Error(
						`transfer port is scoped to ${tenant}; got ${input.tenant}`,
					);
				}
				const record = exports.get(input.exportId);
				if (!record) {
					throw new Error(`unknown exportId ${input.exportId}`);
				}
				const remaining = dual.lag();
				if (remaining > 0) {
					throw new Error(
						`import refused: ${remaining} un-replicated change(s) behind export ${input.exportId}`,
					);
				}
				const landed = counts().target;
				if (landed !== record.streamCount) {
					throw new Error(
						`import verification failed: silo holds ${landed} row(s), export had ${record.streamCount}`,
					);
				}
				const importedHeadSeq = dual.appliedWatermark();
				emit(MIGRATION_EVENTS.Imported, {
					tenant,
					exportId: input.exportId,
					importedHeadSeq,
					streamCount: landed,
					importedAt: clock(),
				});
				return { importedHeadSeq, streamCount: landed };
			},
		}),
		reap() {
			return dual.reapSource(tenant);
		},
	};
}
