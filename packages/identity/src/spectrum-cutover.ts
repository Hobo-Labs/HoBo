/**
 * Spectrum promotion / bulk cutover composed with Plan 50 tenant lifecycle:
 * Suspend → drain → dual identity migration → export → import → fence → Resume.
 * Does NOT reimplement fencing — callers supply fence/export/import ports.
 */

import {
	createDualAdapterPair,
	verifyDualAdapters,
} from "./identity-adapter-port.js";
import type { JsonObject } from "./json.js";
import type { MappingSpec } from "./mapping-spec.js";
import { IdentityMigrationService } from "./migration-aggregate.js";
import {
	decideIdentityMigration,
	type MatchingMigrationInput,
} from "./migration-matching.js";

// public-contract: spectrum cutover protocol schema.
export const SPECTRUM_CUTOVER_SCHEMA =
	"hobo.spectrum-identity-cutover/v1" as const;

export type TenantLifecyclePhase =
	| "idle"
	| "suspended"
	| "draining"
	| "quiescent"
	| "dual-migrating"
	| "exporting"
	| "importing"
	| "fencing"
	| "resumed"
	| "failed";

export type TenantLifecycleEvent = Readonly<{
	type:
		| "tenant.Suspended"
		| "tenant.Drained"
		| "tenant.Exported"
		| "tenant.Imported"
		| "tenant.Fenced"
		| "tenant.Resumed"
		| "tenant.CutoverFailed";
	tenant: string;
	time: string;
	data: JsonObject;
}>;

export type FencePort = Readonly<{
	/** Raise fence token so stray writers cannot append (ADR-0053). */
	raiseFence: (input: {
		readonly tenant: string;
		readonly streamIds: readonly string[];
	}) => { readonly fenceToken: string };
}>;

export type TenantExportImportPort = Readonly<{
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

export type SpectrumCutoverResult = Readonly<{
	schemaVersion: typeof SPECTRUM_CUTOVER_SCHEMA;
	ok: boolean;
	phase: TenantLifecyclePhase;
	tenant: string;
	migrationId?: string;
	linkedPrincipals: number;
	exportId?: string;
	sourceHeadSeq?: number;
	importedHeadSeq?: number;
	fenceToken?: string;
	lifecycleEvents: readonly TenantLifecycleEvent[];
	zeroLoss: boolean;
	reason?: string;
}>;

/**
 * Run the Plan 50 cutover protocol with continuous dual-path identity migration
 * in the dual-migrating phase. Zero-loss: source headSeq must equal imported head.
 */
export function runSpectrumIdentityCutover(input: {
	readonly tenant: string;
	readonly sourceAdapter: string;
	readonly targetAdapter: string;
	readonly streamIds: readonly string[];
	readonly principalSubjects?: readonly string[];
	readonly fence: FencePort;
	readonly transfer: TenantExportImportPort;
	readonly mapping?: MappingSpec;
	readonly now?: () => string;
	readonly vaultRoot?: string;
}): SpectrumCutoverResult {
	const now = input.now ?? (() => new Date().toISOString());
	const events: TenantLifecycleEvent[] = [];
	const push = (type: TenantLifecycleEvent["type"], data: JsonObject) => {
		events.push(
			Object.freeze({
				type,
				tenant: input.tenant,
				time: now(),
				data: Object.freeze(data),
			}),
		);
	};

	// (1) Suspend — freeze tenant aggregates.
	push("tenant.Suspended", { reason: "spectrum-promotion" });

	// (2) Drain — mark quiescent (caller ensures no in-flight commands).
	push("tenant.Drained", { quiescent: true });

	// Matching decision for spectrum.
	const matchInput: MatchingMigrationInput = {
		tenant: input.tenant,
		sourceAdapter: input.sourceAdapter,
		targetAdapter: input.targetAdapter,
		spectrumPromotion: true,
		...(input.mapping !== undefined ? { mapping: input.mapping } : undefined),
		now: now(),
	};
	const decision = decideIdentityMigration(matchInput);
	if (!decision.shouldStartMigration) {
		push("tenant.CutoverFailed", { reason: decision.explanation });
		return Object.freeze({
			schemaVersion: SPECTRUM_CUTOVER_SCHEMA,
			ok: false,
			phase: "failed",
			tenant: input.tenant,
			linkedPrincipals: 0,
			lifecycleEvents: Object.freeze(events),
			zeroLoss: false,
			reason: decision.explanation,
		});
	}

	// (3) Dual identity migration (JIT/background) while suspended — dual path
	// keeps PrincipalRef continuous for when tenant resumes.
	const pair = createDualAdapterPair({
		tenant: input.tenant,
		sourceAdapter: decision.sourceAdapter,
		targetAdapter: decision.targetAdapter,
	});
	const svc = new IdentityMigrationService({
		tenant: input.tenant,
		...(input.vaultRoot !== undefined
			? { vaultRoot: input.vaultRoot }
			: undefined),
		now,
	});
	const started = svc.start({
		tenant: input.tenant,
		sourceAdapter: decision.sourceAdapter,
		targetAdapter: decision.targetAdapter,
		mapping: decision.mapping,
		reason: "spectrum",
		mode: "background",
		matchDecisionId: decision.decisionId,
	});

	const subjects = input.principalSubjects ?? [pair.fixtures.sourceClaims.sub];
	for (const subject of subjects) {
		const verified = verifyDualAdapters({
			source: pair.source,
			target: pair.target,
			subjectHint: subject,
		});
		if (verified.ok === false) {
			svc.abort({ reason: verified.reason, code: verified.code });
			push("tenant.CutoverFailed", { reason: verified.reason });
			return Object.freeze({
				schemaVersion: SPECTRUM_CUTOVER_SCHEMA,
				ok: false,
				phase: "failed",
				tenant: input.tenant,
				migrationId: started.id,
				linkedPrincipals: 0,
				lifecycleEvents: Object.freeze(events),
				zeroLoss: false,
				reason: verified.reason,
			});
		}
		const linked = svc.linkPrincipal({
			sourceClaims: verified.sourceClaims,
			targetClaims: verified.targetClaims,
		});
		if (linked.verify.ok === false) {
			svc.abort({
				reason: linked.verify.reason,
				code: linked.verify.code,
			});
			push("tenant.CutoverFailed", { reason: linked.verify.reason });
			return Object.freeze({
				schemaVersion: SPECTRUM_CUTOVER_SCHEMA,
				ok: false,
				phase: "failed",
				tenant: input.tenant,
				migrationId: started.id,
				linkedPrincipals: svc.snapshot()?.linkedPrincipals ?? 0,
				lifecycleEvents: Object.freeze(events),
				zeroLoss: false,
				reason: linked.verify.reason,
			});
		}
		svc.markMigrated(linked.verify.principalRef);
	}
	svc.advanceRamp({ rampPercent: 100 });
	svc.cutover();

	// (4) Export → import
	const exported = input.transfer.exportTenant(input.tenant);
	push("tenant.Exported", {
		exportId: exported.exportId,
		streamCount: exported.streamCount,
		headSeq: exported.headSeq,
	});
	const imported = input.transfer.importTenant({
		tenant: input.tenant,
		exportId: exported.exportId,
	});
	push("tenant.Imported", {
		exportId: exported.exportId,
		importedHeadSeq: imported.importedHeadSeq,
		streamCount: imported.streamCount,
	});

	const zeroLoss =
		exported.headSeq === imported.importedHeadSeq &&
		exported.streamCount === imported.streamCount;

	if (!zeroLoss) {
		push("tenant.CutoverFailed", {
			reason: "zero-loss check failed",
			sourceHeadSeq: exported.headSeq,
			importedHeadSeq: imported.importedHeadSeq,
		});
		return Object.freeze({
			schemaVersion: SPECTRUM_CUTOVER_SCHEMA,
			ok: false,
			phase: "failed",
			tenant: input.tenant,
			migrationId: started.id,
			linkedPrincipals: svc.snapshot()?.linkedPrincipals ?? 0,
			exportId: exported.exportId,
			sourceHeadSeq: exported.headSeq,
			importedHeadSeq: imported.importedHeadSeq,
			lifecycleEvents: Object.freeze(events),
			zeroLoss: false,
			reason: "zero-loss: source headSeq != imported headSeq",
		});
	}

	// (5) Fence old streams (caller port — not reimplemented).
	const fenced = input.fence.raiseFence({
		tenant: input.tenant,
		streamIds: input.streamIds,
	});
	push("tenant.Fenced", { fenceToken: fenced.fenceToken });

	// (6) Resume
	push("tenant.Resumed", {
		migrationId: started.id,
		targetAdapter: decision.targetAdapter,
	});

	return Object.freeze({
		schemaVersion: SPECTRUM_CUTOVER_SCHEMA,
		ok: true,
		phase: "resumed",
		tenant: input.tenant,
		migrationId: started.id,
		linkedPrincipals: svc.snapshot()?.linkedPrincipals ?? 0,
		exportId: exported.exportId,
		sourceHeadSeq: exported.headSeq,
		importedHeadSeq: imported.importedHeadSeq,
		fenceToken: fenced.fenceToken,
		lifecycleEvents: Object.freeze(events),
		zeroLoss: true,
	});
}

/** In-memory transfer port for offline Golden tests. */
export function createMemoryTenantTransferPort(state?: {
	headSeq?: number;
	streamCount?: number;
}): TenantExportImportPort {
	const headSeq = state?.headSeq ?? 42;
	const streamCount = state?.streamCount ?? 3;
	let lastExport = "";
	return {
		exportTenant: (tenant) => {
			lastExport = `export:${tenant}:${headSeq}`;
			return { exportId: lastExport, streamCount, headSeq };
		},
		importTenant: ({ exportId }) => {
			if (exportId !== lastExport) {
				return { importedHeadSeq: -1, streamCount: 0 };
			}
			return { importedHeadSeq: headSeq, streamCount };
		},
	};
}

/** In-memory fence port for offline Golden tests. */
export function createMemoryFencePort(): FencePort {
	let n = 0;
	return {
		raiseFence: ({ tenant, streamIds }) => {
			n += 1;
			return {
				fenceToken: `fence:${tenant}:${streamIds.length}:${n}`,
			};
		},
	};
}
