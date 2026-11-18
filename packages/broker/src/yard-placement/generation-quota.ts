import { DatabaseSync } from "node:sqlite";
import { isJsonNumber, isJsonString } from "../json.js";
import { type ContentHash, contentHashOf } from "./types.js";

/** A Yard known to exist before this authority was initialized. The host is
 * responsible for supplying a complete baseline and routing later creation
 * through the same authority. */
export interface YardQuotaBaselineEntry {
	readonly yardId: string;
	readonly ownerTenantId: string;
}

export interface YardGenerationQuotaRequest {
	readonly idempotencyKey: ContentHash;
	readonly attemptId: string;
	readonly ownerTenantId: string;
	readonly yardId: string;
	readonly planHash: ContentHash;
	readonly maxConcurrentGenerations: number;
	readonly maxYardsPerTenant: number;
}

export interface YardGenerationQuotaClaim extends YardGenerationQuotaRequest {
	readonly status: "pending" | "ready";
	/** A durable execution fence has been claimed for this attempt. */
	readonly executionClaimed: boolean;
	readonly readyEvidenceRef?: string;
}

export interface YardGenerationQuotaAuthority {
	readonly persistence: "durable-sqlite";
	/** A typed denial means this call did not create a reservation. An untyped
	 * error may follow a committed write whose acknowledgement was lost. */
	reserve(request: YardGenerationQuotaRequest): {
		readonly kind: "reserved" | "existing";
		readonly claim: YardGenerationQuotaClaim;
	};
	lookup(idempotencyKey: ContentHash): YardGenerationQuotaClaim | undefined;
	claimExecution(request: YardGenerationQuotaRequest): {
		readonly kind: "claimed" | "existing";
		readonly claim: YardGenerationQuotaClaim;
	};
	cancelUnclaimed(request: YardGenerationQuotaRequest): {
		readonly kind: "cancelled" | "existing";
		readonly requestDigest: ContentHash;
	};
	lookupCancellation(idempotencyKey: ContentHash): ContentHash | undefined;
	markReady(input: {
		readonly idempotencyKey: ContentHash;
		readonly attemptId: string;
		readonly ownerTenantId: string;
		readonly planHash: ContentHash;
		readonly yardId: string;
		readonly evidenceRef: string;
	}): YardGenerationQuotaClaim;
}

export class YardGenerationQuotaDeniedError extends Error {
	readonly code:
		| "invalid"
		| "conflict"
		| "concurrent-limit"
		| "tenant-limit"
		| "unverified-ready";
	constructor(
		code:
			| "invalid"
			| "conflict"
			| "concurrent-limit"
			| "tenant-limit"
			| "unverified-ready",
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "YardGenerationQuotaDeniedError";
	}
}

function nonblank(value: string): boolean {
	return isJsonString(value) && value.trim().length > 0;
}

function validHash(value: string): boolean {
	return isJsonString(value) && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function validateRequest(request: YardGenerationQuotaRequest): void {
	if (
		!validHash(request.idempotencyKey) ||
		!validHash(request.planHash) ||
		!nonblank(request.attemptId) ||
		!nonblank(request.ownerTenantId) ||
		!nonblank(request.yardId) ||
		!Number.isSafeInteger(request.maxConcurrentGenerations) ||
		request.maxConcurrentGenerations <= 0 ||
		!Number.isSafeInteger(request.maxYardsPerTenant) ||
		request.maxYardsPerTenant <= 0
	)
		throw new YardGenerationQuotaDeniedError(
			"invalid",
			"complete generation quota identity and positive integer limits required",
		);
}

function matchesRequest(
	claim: YardGenerationQuotaClaim,
	request: YardGenerationQuotaRequest,
): boolean {
	return (
		claim.idempotencyKey === request.idempotencyKey &&
		claim.attemptId === request.attemptId &&
		claim.ownerTenantId === request.ownerTenantId &&
		claim.yardId === request.yardId &&
		claim.planHash === request.planHash &&
		claim.maxConcurrentGenerations === request.maxConcurrentGenerations &&
		claim.maxYardsPerTenant === request.maxYardsPerTenant
	);
}

function requestDigest(request: YardGenerationQuotaRequest): ContentHash {
	return contentHashOf({
		idempotencyKey: request.idempotencyKey,
		attemptId: request.attemptId,
		ownerTenantId: request.ownerTenantId,
		yardId: request.yardId,
		planHash: request.planHash,
		maxConcurrentGenerations: request.maxConcurrentGenerations,
		maxYardsPerTenant: request.maxYardsPerTenant,
	});
}

/**
 * One persistent SQLite authority for a single quota scope. BEGIN IMMEDIATE
 * serializes reservation checks and writes across connections to this file.
 * Pending claims remain counted on uncertainty. A trusted readiness verifier
 * must approve completion before a concurrent slot is released; the Yard
 * continues to count against its tenant limit afterward.
 */
export function createSqliteYardGenerationQuotaAuthority(options: {
	readonly path: string;
	readonly scopeId: string;
	readonly initialYards: readonly YardQuotaBaselineEntry[];
	readonly maxConcurrentGenerations: number;
	readonly maxYardsPerTenant: number;
	readonly verifyReady?: (input: {
		readonly claim: YardGenerationQuotaClaim;
		readonly evidenceRef: string;
	}) => boolean;
}): YardGenerationQuotaAuthority & { close(): void } {
	if (
		options.path === ":memory:" ||
		!nonblank(options.path) ||
		!nonblank(options.scopeId)
	)
		throw new YardGenerationQuotaDeniedError(
			"invalid",
			"persistent quota path and scope are required",
		);
	if (
		!Number.isSafeInteger(options.maxConcurrentGenerations) ||
		options.maxConcurrentGenerations <= 0 ||
		!Number.isSafeInteger(options.maxYardsPerTenant) ||
		options.maxYardsPerTenant <= 0
	)
		throw new YardGenerationQuotaDeniedError(
			"invalid",
			"positive integer quota limits are required",
		);
	const maxConcurrentGenerations = options.maxConcurrentGenerations;
	const maxYardsPerTenant = options.maxYardsPerTenant;
	const baseline = options.initialYards.map((yard) => ({
		yardId: yard.yardId,
		ownerTenantId: yard.ownerTenantId,
	}));
	if (
		baseline.some(
			(yard) => !nonblank(yard.yardId) || !nonblank(yard.ownerTenantId),
		) ||
		new Set(baseline.map((yard) => yard.yardId)).size !== baseline.length
	)
		throw new YardGenerationQuotaDeniedError(
			"invalid",
			"quota baseline Yard identities must be unique and complete",
		);
	baseline.sort((a, b) =>
		a.yardId < b.yardId ? -1 : a.yardId > b.yardId ? 1 : 0,
	);
	const baselineDescriptor = {
		scopeId: options.scopeId,
		maxConcurrentGenerations,
		maxYardsPerTenant,
		yards: baseline,
	};
	const legacyBaselineHash = contentHashOf(baselineDescriptor);
	const baselineHash = contentHashOf({
		version: 2,
		baseline: baselineDescriptor,
	});
	const verifyReady = options.verifyReady;
	const database = new DatabaseSync(options.path);
	function transaction<T>(operation: () => T): T {
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			database.exec("COMMIT");
			return result;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}
	function writeClaims<T>(operation: () => T): T {
		database.exec("INSERT INTO generation_quota_write_permit(id) VALUES(1)");
		try {
			return operation();
		} finally {
			database.exec("DELETE FROM generation_quota_write_permit WHERE id=1");
		}
	}
	try {
		const main = database
			.prepare("PRAGMA database_list")
			.all()
			.find((entry) => entry.name === "main");
		if (!isJsonString(main?.file) || !nonblank(main.file))
			throw new YardGenerationQuotaDeniedError(
				"invalid",
				"quota authority must use a persistent SQLite database",
			);
		database.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS generation_quota_meta (id INTEGER PRIMARY KEY CHECK(id=1), scope_id TEXT NOT NULL, baseline_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generation_quota_baseline (yard_id TEXT PRIMARY KEY, owner_tenant_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generation_quota_claims (idempotency_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, owner_tenant_id TEXT NOT NULL, yard_id TEXT NOT NULL UNIQUE, plan_hash TEXT NOT NULL, max_concurrent INTEGER NOT NULL, max_yards INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','ready')), ready_evidence_ref TEXT)",
		);
		transaction(() => {
			const meta = database
				.prepare(
					"SELECT scope_id, baseline_hash FROM generation_quota_meta WHERE id=1",
				)
				.get();
			if (
				meta &&
				(meta.scope_id !== options.scopeId ||
					(meta.baseline_hash !== legacyBaselineHash &&
						meta.baseline_hash !== baselineHash))
			)
				throw new YardGenerationQuotaDeniedError(
					"conflict",
					"quota scope or initial inventory differs from the stored baseline",
				);
			// Transaction-local permits make already-open older writers fail closed.
			// BEGIN IMMEDIATE prevents another connection from observing a permit.
			database.exec(
				"CREATE TABLE IF NOT EXISTS generation_quota_execution (idempotency_key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS generation_quota_cancelled (idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generation_quota_write_permit (id INTEGER PRIMARY KEY CHECK(id=1)); CREATE TRIGGER IF NOT EXISTS generation_quota_guard_insert BEFORE INSERT ON generation_quota_claims WHEN NOT EXISTS(SELECT 1 FROM generation_quota_write_permit WHERE id=1) BEGIN SELECT RAISE(ABORT, 'quota execution fencing required'); END; CREATE TRIGGER IF NOT EXISTS generation_quota_guard_update BEFORE UPDATE ON generation_quota_claims WHEN NOT EXISTS(SELECT 1 FROM generation_quota_write_permit WHERE id=1) BEGIN SELECT RAISE(ABORT, 'quota execution fencing required'); END; CREATE TRIGGER IF NOT EXISTS generation_quota_guard_delete BEFORE DELETE ON generation_quota_claims WHEN NOT EXISTS(SELECT 1 FROM generation_quota_write_permit WHERE id=1) BEGIN SELECT RAISE(ABORT, 'quota execution fencing required'); END",
			);
			if (
				database
					.prepare("SELECT id FROM generation_quota_write_permit LIMIT 1")
					.get()
			)
				throw new Error("unexpected persistent generation quota write permit");
			if (meta) {
				if (meta.baseline_hash === legacyBaselineHash) {
					// Old pending attempts may already have reached a provider. Fence
					// every pre-upgrade claim before enabling cancellation.
					database.exec(
						"INSERT OR IGNORE INTO generation_quota_execution(idempotency_key) SELECT idempotency_key FROM generation_quota_claims",
					);
					database
						.prepare(
							"UPDATE generation_quota_meta SET baseline_hash=? WHERE id=1",
						)
						.run(baselineHash);
				}
				return;
			}
			database
				.prepare(
					"INSERT INTO generation_quota_meta(id,scope_id,baseline_hash) VALUES(1,?,?)",
				)
				.run(options.scopeId, baselineHash);
			const insert = database.prepare(
				"INSERT INTO generation_quota_baseline(yard_id,owner_tenant_id) VALUES(?,?)",
			);
			for (const yard of baseline) insert.run(yard.yardId, yard.ownerTenantId);
		});
	} catch (error) {
		database.close();
		throw error;
	}

	function lookup(
		idempotencyKey: ContentHash,
	): YardGenerationQuotaClaim | undefined {
		const row = database
			.prepare(
				"SELECT c.idempotency_key, c.attempt_id, c.owner_tenant_id, c.yard_id, c.plan_hash, c.max_concurrent, c.max_yards, c.status, c.ready_evidence_ref, EXISTS(SELECT 1 FROM generation_quota_execution e WHERE e.idempotency_key=c.idempotency_key) AS execution_claimed FROM generation_quota_claims c WHERE c.idempotency_key=?",
			)
			.get(idempotencyKey);
		if (!row) return undefined;
		if (
			!isJsonString(row.idempotency_key) ||
			!validHash(row.idempotency_key) ||
			!isJsonString(row.plan_hash) ||
			!validHash(row.plan_hash) ||
			!isJsonString(row.attempt_id) ||
			!nonblank(row.attempt_id) ||
			!isJsonString(row.owner_tenant_id) ||
			!nonblank(row.owner_tenant_id) ||
			!isJsonString(row.yard_id) ||
			!nonblank(row.yard_id) ||
			!isJsonNumber(row.max_concurrent) ||
			!Number.isSafeInteger(row.max_concurrent) ||
			row.max_concurrent <= 0 ||
			!isJsonNumber(row.max_yards) ||
			!Number.isSafeInteger(row.max_yards) ||
			row.max_yards <= 0 ||
			(row.execution_claimed !== 0 && row.execution_claimed !== 1) ||
			(row.status !== "pending" && row.status !== "ready") ||
			(row.status === "ready" &&
				(row.execution_claimed !== 1 ||
					!isJsonString(row.ready_evidence_ref) ||
					!nonblank(row.ready_evidence_ref))) ||
			(row.status === "pending" && row.ready_evidence_ref !== null)
		)
			throw new Error("invalid stored generation quota claim");
		const claim: YardGenerationQuotaClaim = {
			// SAFETY: hashes have been validated above.
			idempotencyKey: row.idempotency_key as ContentHash,
			attemptId: row.attempt_id,
			ownerTenantId: row.owner_tenant_id,
			yardId: row.yard_id,
			// SAFETY: hashes have been validated above.
			planHash: row.plan_hash as ContentHash,
			maxConcurrentGenerations: row.max_concurrent,
			maxYardsPerTenant: row.max_yards,
			status: row.status,
			executionClaimed: row.execution_claimed === 1,
		};
		if (isJsonString(row.ready_evidence_ref))
			return Object.freeze({
				...claim,
				readyEvidenceRef: row.ready_evidence_ref,
			});
		return Object.freeze(claim);
	}

	function lookupCancellation(
		idempotencyKey: ContentHash,
	): ContentHash | undefined {
		const row = database
			.prepare(
				"SELECT request_digest FROM generation_quota_cancelled WHERE idempotency_key=?",
			)
			.get(idempotencyKey);
		if (!row) return undefined;
		if (!isJsonString(row.request_digest) || !validHash(row.request_digest))
			throw new Error("invalid stored generation quota cancellation");
		// SAFETY: the stored digest has been validated above.
		return row.request_digest as ContentHash;
	}

	return {
		persistence: "durable-sqlite",
		lookup,
		lookupCancellation,
		reserve(input) {
			const request = structuredClone(input);
			validateRequest(request);
			if (
				request.maxConcurrentGenerations !== maxConcurrentGenerations ||
				request.maxYardsPerTenant !== maxYardsPerTenant
			)
				throw new YardGenerationQuotaDeniedError(
					"conflict",
					"request limits differ from the authority's fixed limits",
				);
			return transaction(() => {
				const cancelled = database
					.prepare(
						"SELECT request_digest FROM generation_quota_cancelled WHERE idempotency_key=?",
					)
					.get(request.idempotencyKey);
				if (cancelled)
					throw new YardGenerationQuotaDeniedError(
						"conflict",
						"generation quota key was cancelled and cannot be reused",
					);
				const previous = lookup(request.idempotencyKey);
				if (previous) {
					if (!matchesRequest(previous, request))
						throw new YardGenerationQuotaDeniedError(
							"conflict",
							"generation quota key belongs to another claim",
						);
					return Object.freeze({ kind: "existing" as const, claim: previous });
				}
				const duplicateYard = database
					.prepare(
						"SELECT yard_id FROM generation_quota_baseline WHERE yard_id=? UNION ALL SELECT yard_id FROM generation_quota_claims WHERE yard_id=? LIMIT 1",
					)
					.get(request.yardId, request.yardId);
				if (duplicateYard)
					throw new YardGenerationQuotaDeniedError(
						"conflict",
						"Yard already exists or is reserved",
					);
				const concurrent = database
					.prepare(
						"SELECT COUNT(*) AS count FROM generation_quota_claims WHERE status='pending'",
					)
					.get()?.count;
				const tenant = database
					.prepare(
						"SELECT (SELECT COUNT(*) FROM generation_quota_baseline WHERE owner_tenant_id=?) + (SELECT COUNT(*) FROM generation_quota_claims WHERE owner_tenant_id=?) AS count",
					)
					.get(request.ownerTenantId, request.ownerTenantId)?.count;
				if (
					!isJsonNumber(concurrent) ||
					!Number.isSafeInteger(concurrent) ||
					!isJsonNumber(tenant) ||
					!Number.isSafeInteger(tenant)
				)
					throw new Error("invalid generation quota counts");
				if (concurrent >= request.maxConcurrentGenerations)
					throw new YardGenerationQuotaDeniedError(
						"concurrent-limit",
						"generation concurrency limit reached",
					);
				if (tenant >= request.maxYardsPerTenant)
					throw new YardGenerationQuotaDeniedError(
						"tenant-limit",
						"tenant Yard limit reached",
					);
				writeClaims(() => {
					database
						.prepare(
							"INSERT INTO generation_quota_claims(idempotency_key,attempt_id,owner_tenant_id,yard_id,plan_hash,max_concurrent,max_yards,status) VALUES(?,?,?,?,?,?,?,'pending')",
						)
						.run(
							request.idempotencyKey,
							request.attemptId,
							request.ownerTenantId,
							request.yardId,
							request.planHash,
							request.maxConcurrentGenerations,
							request.maxYardsPerTenant,
						);
				});
				const claim = lookup(request.idempotencyKey);
				if (!claim)
					throw new Error("generation quota claim missing after insert");
				return Object.freeze({ kind: "reserved" as const, claim });
			});
		},
		claimExecution(input) {
			const request = structuredClone(input);
			validateRequest(request);
			return transaction(() => {
				const claim = lookup(request.idempotencyKey);
				if (!claim || !matchesRequest(claim, request))
					throw new YardGenerationQuotaDeniedError(
						"conflict",
						"generation quota claim is missing or belongs to another attempt",
					);
				if (claim.executionClaimed)
					return Object.freeze({ kind: "existing" as const, claim });
				database
					.prepare(
						"INSERT INTO generation_quota_execution(idempotency_key) VALUES(?)",
					)
					.run(request.idempotencyKey);
				const claimed = lookup(request.idempotencyKey);
				if (!claimed?.executionClaimed)
					throw new Error(
						"generation quota execution fence missing after claim",
					);
				return Object.freeze({ kind: "claimed" as const, claim: claimed });
			});
		},
		cancelUnclaimed(input) {
			const request = structuredClone(input);
			validateRequest(request);
			return transaction(() => {
				const cancelled = database
					.prepare(
						"SELECT request_digest FROM generation_quota_cancelled WHERE idempotency_key=?",
					)
					.get(request.idempotencyKey);
				if (cancelled) {
					if (cancelled.request_digest !== requestDigest(request))
						throw new YardGenerationQuotaDeniedError(
							"conflict",
							"cancelled generation quota key belongs to another attempt",
						);
					return Object.freeze({
						kind: "existing" as const,
						requestDigest: requestDigest(request),
					});
				}
				const claim = lookup(request.idempotencyKey);
				if (!claim || !matchesRequest(claim, request))
					throw new YardGenerationQuotaDeniedError(
						"conflict",
						"generation quota claim is missing or belongs to another attempt",
					);
				if (claim.executionClaimed || claim.status !== "pending")
					throw new YardGenerationQuotaDeniedError(
						"conflict",
						"generation quota execution was already claimed",
					);
				database
					.prepare(
						"INSERT INTO generation_quota_cancelled(idempotency_key,request_digest) VALUES(?,?)",
					)
					.run(request.idempotencyKey, requestDigest(request));
				writeClaims(() => {
					database
						.prepare(
							"DELETE FROM generation_quota_claims WHERE idempotency_key=?",
						)
						.run(request.idempotencyKey);
				});
				return Object.freeze({
					kind: "cancelled" as const,
					requestDigest: requestDigest(request),
				});
			});
		},
		markReady(input) {
			const request = Object.freeze({ ...input });
			if (
				!validHash(request.idempotencyKey) ||
				!validHash(request.planHash) ||
				!nonblank(request.attemptId) ||
				!nonblank(request.ownerTenantId) ||
				!nonblank(request.yardId) ||
				!nonblank(request.evidenceRef)
			)
				throw new YardGenerationQuotaDeniedError(
					"invalid",
					"complete ready evidence binding required",
				);
			const claim = lookup(request.idempotencyKey);
			if (
				!claim ||
				claim.attemptId !== request.attemptId ||
				claim.ownerTenantId !== request.ownerTenantId ||
				claim.planHash !== request.planHash ||
				claim.yardId !== request.yardId
			)
				throw new YardGenerationQuotaDeniedError(
					"conflict",
					"ready evidence does not bind the quota claim",
				);
			if (!claim.executionClaimed)
				throw new YardGenerationQuotaDeniedError(
					"conflict",
					"generation quota execution must be claimed before readiness",
				);
			if (
				verifyReady?.(
					Object.freeze({ claim, evidenceRef: request.evidenceRef }),
				) !== true
			)
				throw new YardGenerationQuotaDeniedError(
					"unverified-ready",
					"readiness evidence was not verified",
				);
			return transaction(() => {
				const current = lookup(request.idempotencyKey);
				if (
					!current ||
					current.attemptId !== request.attemptId ||
					current.ownerTenantId !== request.ownerTenantId ||
					current.planHash !== request.planHash ||
					current.yardId !== request.yardId ||
					!current.executionClaimed
				)
					throw new YardGenerationQuotaDeniedError(
						"conflict",
						"quota claim changed while readiness was checked",
					);
				if (current.status === "ready") {
					if (current.readyEvidenceRef !== request.evidenceRef)
						throw new YardGenerationQuotaDeniedError(
							"conflict",
							"different readiness evidence was already recorded",
						);
					return current;
				}
				writeClaims(() => {
					database
						.prepare(
							"UPDATE generation_quota_claims SET status='ready', ready_evidence_ref=? WHERE idempotency_key=? AND status='pending'",
						)
						.run(request.evidenceRef, request.idempotencyKey);
				});
				const ready = lookup(request.idempotencyKey);
				if (!ready || ready.status !== "ready")
					throw new Error("generation quota readiness update failed");
				return ready;
			});
		},
		close() {
			database.close();
		},
	};
}
