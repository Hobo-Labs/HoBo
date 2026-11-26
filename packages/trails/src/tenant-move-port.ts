/**
 * Pooled → siloed tenant move over real stores (ADR-0080 §2).
 *
 * Engine-neutral: it drives any `LiveDataDualPort` — `@hobo/data-sqlite`'s is
 * the one with a live lane today — and Trails itself imports no engine
 * (ADR-0177 decision 3).
 *
 * Adapts the live dual-run port to the identity spectrum-cutover protocol's
 * `FencePort` / `TenantExportImportPort` shapes, replacing the memory stubs:
 * suspend/fence refuses tenant writes at the store's single write entry
 * point, drain replicates the CDC tail to lag 0 (the quiescent seq), export
 * reads the tenant's rows at that seq, import lands them in the silo, and the
 * zero-loss conformance is `source quiescent seq == silo head`. Reap deletes
 * the pooled copy only after fence + zero lag + checksum equality.
 */
import type { LiveDataDualPort } from "./data-dual-port.js";
import type { JsonObject } from "./json.js";
import { MIGRATION_EVENTS, type MigrationFact } from "./migration-executor.js";

// public-contract: tenant move protocol schema id.
export const TENANT_MOVE_SCHEMA = "hobo.tenant-move/v1";

/**
 * Structural mirrors of the identity spectrum-cutover ports (`FencePort` /
 * `TenantExportImportPort`), declared locally so the sealed Trails public
 * surface never re-exports foreign package types. Structural compatibility is
 * asserted where the ports are consumed (`runSpectrumIdentityCutover`).
 */
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
	/** Replicate until lag()===0; returns the quiescent CDC head seq. */
	drain(): number;
	/** Destructive pooled-copy cleanup; refuses unless the move is proven. */
	reap(): { readonly reaped: number };
	readonly facts: readonly MigrationFact[];
}

export interface CreateTenantMovePortsOptions {
	/** Tenant-scoped dual port (`tenant` option set) — pooled source, silo target. */
	readonly dual: LiveDataDualPort;
	readonly tenant: string;
	readonly clock?: () => string;
	readonly onFact?: (fact: MigrationFact) => void;
}

/**
 * Real (non-stub) fence + export/import ports for
 * `runSpectrumIdentityCutover`, backed by a live dual-run port.
 */
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

	// Counts come from digest evidence when the port offers it, so the move is
	// verified without a row leaving either store.
	const counts = () => {
		const evidence = dual.evidence?.();
		if (evidence !== undefined) {
			return { source: evidence.source.count, target: evidence.target.count };
		}
		const view = dual.snapshot();
		return { source: view.sourceRows.length, target: view.targetRows.length };
	};

	// exportId → the quiescent head seq it was cut at.
	const exports = new Map<string, { headSeq: number; streamCount: number }>();
	let exportCounter = 0;

	function drain(): number {
		// Replication is idempotent (watermark); loop until the tail is dry.
		// Bounded: the tenant is fenced or suspended by the protocol before
		// drain, so the CDC head cannot advance under us.
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
				// Export is only meaningful at quiescence: drain first so the
				// exported head IS the quiescent seq.
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
				// The CDC tail already landed the rows during drain; import
				// verifies the silo actually holds the exported set. The imported
				// head is measured FROM THE SILO (its replication watermark), so
				// zero-loss (`importedHeadSeq == export headSeq`) is an
				// independent conformance check, not an echo.
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
