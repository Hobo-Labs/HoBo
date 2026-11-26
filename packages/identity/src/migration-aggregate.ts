/**
 * IdentityMigration aggregate: continuous dual-path principal migration.
 * Hands-off by construction — Matching/policy start; no Bindle config required.
 */

import { randomUUID } from "node:crypto";
import { must } from "@hobo/core/total-access";
import {
	type AdapterClaims,
	type DualAudienceGrant,
	type DualVerifyResult,
	dualVerifyClaims,
	mintDualAudienceGrant,
} from "./dual-adapter.js";
import { isJsonNumber, isJsonString } from "./json.js";
import type { MappingSpec } from "./mapping-spec.js";
import {
	createDualConsistencyCheckedEvent,
	createDualLinkedEvent,
	createMigratedEvent,
	createMigrationAbortedEvent,
	createMigrationCompensatedEvent,
	createMigrationCutoverEvent,
	createMigrationProgressedEvent,
	createMigrationStartedEvent,
	createShadowVerifiedEvent,
	type IdentityMigrationEvent,
	validateIdentityMigrationEvent,
} from "./migration-events.js";

// public-contract: migration aggregate schema version.
export const IDENTITY_MIGRATION_SCHEMA = "hobo.identity-migration/v1" as const;

export interface LinkedPrincipalResult {
	verify: DualVerifyResult;
	grant?: DualAudienceGrant;
	record: IdentityMigrationRecord;
}

export type MigrationState =
	| "idle"
	| "dual-active"
	| "shadow"
	| "ramping"
	| "quiescent"
	| "cutover"
	| "compensated"
	| "failed"
	| "aborted";

export type MigrationReason =
	| "adapter-change"
	| "residency"
	| "spectrum"
	| "policy"
	| "schema"
	| "yard-move";

export type MigrationMode = "jit" | "shadow" | "background";

export type PrincipalLink = Readonly<{
	principalRef: string;
	sourceSubject: string;
	targetSubject: string;
	linkedAt: string;
	migrated: boolean;
}>;

export type IdentityMigrationRecord = Readonly<{
	schemaVersion: typeof IDENTITY_MIGRATION_SCHEMA;
	id: string;
	tenant: string;
	state: MigrationState;
	reason: MigrationReason;
	mode: MigrationMode;
	sourceAdapter: string;
	targetAdapter: string;
	mappingSpecHash: string;
	matchDecisionId?: string;
	cohortFlagId: string;
	rampPercent: number;
	linkedPrincipals: number;
	failedChecks: number;
	links: Readonly<Record<string, PrincipalLink>>;
	createdAt: string;
	updatedAt: string;
	seq: number;
	outcomeReason?: string;
}>;

export type StartMigrationInput = Readonly<{
	tenant: string;
	sourceAdapter: string;
	targetAdapter: string;
	mapping: MappingSpec;
	reason: MigrationReason;
	mode?: MigrationMode;
	matchDecisionId?: string;
}>;

export class IdentityMigrationService {
	readonly tenant: string;
	readonly events: IdentityMigrationEvent[] = [];
	private seq = 0;
	private readonly now: () => string;
	private readonly vaultRoot: string;
	private record: IdentityMigrationRecord | null = null;
	private dualGrants = new Map<string, DualAudienceGrant>();
	private mapping: MappingSpec | null = null;

	constructor(options: {
		readonly tenant: string;
		readonly vaultRoot?: string;
		readonly now?: () => string;
	}) {
		this.tenant = options.tenant;
		this.vaultRoot =
			options.vaultRoot ?? `hobo-migration-vault-${options.tenant}`;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	static fromEvents(
		events: readonly IdentityMigrationEvent[],
		options: {
			readonly tenant: string;
			readonly vaultRoot?: string;
			readonly now?: () => string;
			readonly mapping?: MappingSpec;
		},
	): IdentityMigrationService {
		const svc = new IdentityMigrationService(options);
		if (options.mapping) svc.mapping = options.mapping;
		for (const e of events) {
			validateIdentityMigrationEvent(e);
			svc.apply(e);
			svc.events.push(e);
			svc.seq = Math.max(svc.seq, e.seq);
		}
		return svc;
	}

	snapshot(): IdentityMigrationRecord | null {
		return this.record;
	}

	getDualGrant(principalRef: string): DualAudienceGrant | undefined {
		return this.dualGrants.get(principalRef);
	}

	/** Matching/policy starts continuous migration — no Bindle fields required. */
	start(input: StartMigrationInput): IdentityMigrationRecord {
		if (
			this.record &&
			!["cutover", "compensated", "aborted", "failed", "idle"].includes(
				this.record.state,
			)
		) {
			throw Object.assign(
				new Error(`migration already active: ${this.record.id}`),
				{ code: "migration-already-active" },
			);
		}
		if (input.mapping.sourceAdapter !== input.sourceAdapter) {
			throw new TypeError("mapping sourceAdapter mismatch");
		}
		if (input.mapping.targetAdapter !== input.targetAdapter) {
			throw new TypeError("mapping targetAdapter mismatch");
		}
		this.mapping = input.mapping;
		const id = `mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const t = this.now();
		const mode = input.mode ?? "jit";
		const evt = createMigrationStartedEvent({
			migrationId: id,
			tenant: input.tenant,
			sourceAdapter: input.sourceAdapter,
			targetAdapter: input.targetAdapter,
			reason: input.reason,
			mappingSpecHash: input.mapping.contentHash,
			mode,
			...(input.matchDecisionId !== undefined
				? { matchDecisionId: input.matchDecisionId }
				: undefined),
			seq: this.nextSeq(),
			time: t,
		});
		this.append(evt);
		return must(this.record);
	}

	/**
	 * JIT / shadow dual-link a principal. Keeps both adapters valid (dual-audience).
	 */
	linkPrincipal(input: {
		readonly sourceClaims: AdapterClaims;
		readonly targetClaims: AdapterClaims;
		readonly scope?: Readonly<{
			port: string;
			resource: string;
			action: string;
		}>;
	}): LinkedPrincipalResult {
		const rec = this.requireActive();
		const mapping = this.requireMapping();
		const verify = dualVerifyClaims({
			mapping,
			sourceClaims: input.sourceClaims,
			targetClaims: input.targetClaims,
			tenant: this.tenant,
		});
		const t = this.now();

		if (verify.ok === false) {
			const failEvt = createShadowVerifiedEvent({
				migrationId: rec.id,
				tenant: this.tenant,
				principalRef: "unknown",
				ok: false,
				divergedClaims: verify.divergedClaims,
				seq: this.nextSeq(),
				time: t,
			});
			this.append(failEvt);
			// Fail-closed: dual inconsistency increments failed checks; may abort ramp.
			const check = createDualConsistencyCheckedEvent({
				migrationId: rec.id,
				tenant: this.tenant,
				ok: false,
				checked: rec.linkedPrincipals + 1,
				failed: rec.failedChecks + 1,
				seq: this.nextSeq(),
				time: t,
			});
			this.append(check);
			if (
				this.record &&
				this.record.failedChecks >= 3 &&
				this.record.state === "ramping"
			) {
				this.abort({
					reason: "dual-consistency oracle failed closed",
					code: "dual-consistency-failed",
				});
			}
			return { verify, record: must(this.record) };
		}

		const shadow = createShadowVerifiedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			principalRef: verify.principalRef,
			ok: true,
			seq: this.nextSeq(),
			time: t,
		});
		this.append(shadow);

		const linked = createDualLinkedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			principalRef: verify.principalRef,
			sourceSubject: verify.sourceSubject,
			targetSubject: verify.targetSubject,
			seq: this.nextSeq(),
			time: t,
		});
		this.append(linked);

		const grant = mintDualAudienceGrant({
			principalRef: verify.principalRef,
			sourceAdapter: mapping.sourceAdapter,
			targetAdapter: mapping.targetAdapter,
			scope: input.scope ?? {
				port: "identity",
				resource: verify.principalRef,
				action: "auth",
			},
			vaultRoot: this.vaultRoot,
			now: this.now,
		});
		this.dualGrants.set(verify.principalRef, grant);

		const check = createDualConsistencyCheckedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			ok: true,
			checked: this.record?.linkedPrincipals ?? 0,
			failed: this.record?.failedChecks ?? 0,
			seq: this.nextSeq(),
			time: t,
		});
		this.append(check);

		return { verify, grant, record: must(this.record) };
	}

	/** Advance Harness ramp percent (0–100). Auto-called by progressive gate. */
	advanceRamp(input: {
		readonly rampPercent: number;
		readonly cohortFlagId?: string;
	}): IdentityMigrationRecord {
		const rec = this.requireActive();
		if (input.rampPercent < 0 || input.rampPercent > 100) {
			throw new TypeError("rampPercent must be 0..100");
		}
		if (rec.failedChecks > 0 && input.rampPercent > rec.rampPercent) {
			throw Object.assign(
				new Error("cannot advance ramp while dual-consistency failures exist"),
				{ code: "dual-consistency-failed" },
			);
		}
		const evt = createMigrationProgressedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			rampPercent: input.rampPercent,
			linkedPrincipals: rec.linkedPrincipals,
			...(input.cohortFlagId !== undefined
				? { cohortFlagId: input.cohortFlagId }
				: undefined),
			seq: this.nextSeq(),
			time: this.now(),
		});
		this.append(evt);
		return must(this.record);
	}

	/** Mark principal fully migrated under target (still dual until cutover). */
	markMigrated(principalRef: string): IdentityMigrationRecord {
		const rec = this.requireActive();
		if (!rec.links[principalRef]) {
			throw Object.assign(
				new Error(`principal not dual-linked: ${principalRef}`),
				{
					code: "principal-not-linked",
				},
			);
		}
		const evt = createMigratedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			principalRef,
			targetAdapter: rec.targetAdapter,
			seq: this.nextSeq(),
			time: this.now(),
		});
		this.append(evt);
		return must(this.record);
	}

	/**
	 * Cutover when ramp is 100% and dual-consistency is clean.
	 * Source path retires; dual grants expire naturally (ADR-0100).
	 */
	cutover(): IdentityMigrationRecord {
		const rec = this.requireActive();
		if (rec.rampPercent < 100) {
			throw Object.assign(new Error("cutover requires rampPercent=100"), {
				code: "ramp-incomplete",
			});
		}
		if (rec.failedChecks > 0) {
			throw Object.assign(
				new Error("cutover denied: dual-consistency failures present"),
				{ code: "dual-consistency-failed" },
			);
		}
		const evt = createMigrationCutoverEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			linkedPrincipals: rec.linkedPrincipals,
			seq: this.nextSeq(),
			time: this.now(),
		});
		this.append(evt);
		this.dualGrants.clear();
		return must(this.record);
	}

	abort(input: { reason: string; code: string }): IdentityMigrationRecord {
		const rec = this.requireActive();
		const evt = createMigrationAbortedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			reason: input.reason,
			code: input.code,
			seq: this.nextSeq(),
			time: this.now(),
		});
		this.append(evt);
		return must(this.record);
	}

	/** Compensate to source adapter after abort/failure. */
	compensate(input: { reason: string }): IdentityMigrationRecord {
		const rec = this.record;
		if (!rec) {
			throw Object.assign(new Error("no migration to compensate"), {
				code: "migration-missing",
			});
		}
		const evt = createMigrationCompensatedEvent({
			migrationId: rec.id,
			tenant: this.tenant,
			reason: input.reason,
			restoredAdapter: rec.sourceAdapter,
			seq: this.nextSeq(),
			time: this.now(),
		});
		this.append(evt);
		this.dualGrants.clear();
		return must(this.record);
	}

	private requireActive(): IdentityMigrationRecord {
		if (
			!this.record ||
			["cutover", "compensated", "aborted", "failed", "idle"].includes(
				this.record.state,
			)
		) {
			throw Object.assign(new Error("no active migration"), {
				code: "migration-not-active",
			});
		}
		return this.record;
	}

	private requireMapping(): MappingSpec {
		if (!this.mapping) {
			throw Object.assign(new Error("MappingSpec missing"), {
				code: "mapping-spec-missing",
			});
		}
		return this.mapping;
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	private append(event: IdentityMigrationEvent): void {
		validateIdentityMigrationEvent(event);
		this.apply(event);
		this.events.push(event);
	}

	private apply(event: IdentityMigrationEvent): void {
		const d = event.data;
		const migrationId = String(d.migrationId);
		switch (event.type) {
			case "identity.MigrationStarted": {
				this.record = Object.freeze({
					schemaVersion: IDENTITY_MIGRATION_SCHEMA,
					id: migrationId,
					tenant: event.tenant,
					state:
						d.mode === "shadow"
							? ("shadow" as const)
							: ("dual-active" as const),
					// SAFETY: assertion to `on as MigrationReason, ` is required at this boundary.
					reason: d.reason as MigrationReason,
					// SAFETY: assertion to ` as MigrationMode, ` is required at this boundary.
					mode: d.mode as MigrationMode,
					sourceAdapter: String(d.sourceAdapter),
					targetAdapter: String(d.targetAdapter),
					mappingSpecHash: String(d.mappingSpecHash),
					...(isJsonString(d.matchDecisionId)
						? { matchDecisionId: d.matchDecisionId }
						: undefined),
					cohortFlagId: `flag:identity-migration:${migrationId}`,
					rampPercent: 0,
					linkedPrincipals: 0,
					failedChecks: 0,
					links: Object.freeze({}),
					createdAt: event.time,
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.DualLinked": {
				if (!this.record) break;
				const principalRef = String(d.principalRef);
				const link: PrincipalLink = Object.freeze({
					principalRef,
					sourceSubject: String(d.sourceSubjectRef),
					targetSubject: String(d.targetSubjectRef),
					linkedAt: event.time,
					migrated: false,
				});
				const links = Object.freeze({
					...this.record.links,
					[principalRef]: link,
				});
				this.record = Object.freeze({
					...this.record,
					links,
					linkedPrincipals: Object.keys(links).length,
					state:
						this.record.state === "shadow"
							? ("shadow" as const)
							: ("dual-active" as const),
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.ShadowVerified": {
				if (!this.record) break;
				this.record = Object.freeze({
					...this.record,
					updatedAt: event.time,
					seq: event.seq,
					...(d.ok === false
						? { failedChecks: this.record.failedChecks + 1 }
						: undefined),
				});
				break;
			}
			case "identity.DualConsistencyChecked": {
				if (!this.record) break;
				this.record = Object.freeze({
					...this.record,
					failedChecks: isJsonNumber(d.failed)
						? d.failed
						: this.record.failedChecks,
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.MigrationProgressed": {
				if (!this.record) break;
				const ramp = isJsonNumber(d.rampPercent)
					? d.rampPercent
					: this.record.rampPercent;
				this.record = Object.freeze({
					...this.record,
					rampPercent: ramp,
					state:
						ramp >= 100
							? ("quiescent" as const)
							: ramp > 0
								? ("ramping" as const)
								: this.record.state,
					cohortFlagId: isJsonString(d.cohortFlagId)
						? d.cohortFlagId
						: this.record.cohortFlagId,
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.Migrated": {
				if (!this.record) break;
				const principalRef = String(d.principalRef);
				const prev = this.record.links[principalRef];
				if (!prev) break;
				const links = Object.freeze({
					...this.record.links,
					[principalRef]: Object.freeze({ ...prev, migrated: true }),
				});
				this.record = Object.freeze({
					...this.record,
					links,
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.MigrationCutover": {
				if (!this.record) break;
				this.record = Object.freeze({
					...this.record,
					state: "cutover" as const,
					rampPercent: 100,
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.MigrationAborted": {
				if (!this.record) break;
				this.record = Object.freeze({
					...this.record,
					state: "aborted" as const,
					outcomeReason: String(d.reason ?? d.code),
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			case "identity.MigrationCompensated": {
				if (!this.record) break;
				this.record = Object.freeze({
					...this.record,
					state: "compensated" as const,
					outcomeReason: String(d.reason),
					updatedAt: event.time,
					seq: event.seq,
				});
				break;
			}
			default:
				break;
		}
	}
}

export function foldIdentityMigrationEvents(
	events: readonly IdentityMigrationEvent[],
	options: { tenant: string; mapping?: MappingSpec },
): IdentityMigrationRecord | null {
	const svc = IdentityMigrationService.fromEvents(events, options);
	return svc.snapshot();
}
