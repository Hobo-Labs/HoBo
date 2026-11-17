/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- SAFETY: SQLite rows and capability data are checked at the persistence boundary; optional fields remain absent. */
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	type IacRouteAuthority,
	type IacRouteAuthorizedIdentity,
	type IacRouteIdentity,
	type IacRouteOutcome,
	type IacRoutePermit,
	routeAuthorization,
	routeDigest,
	routeName,
	routeSecret,
} from "./iac-route.js";

function secret(): string {
	return randomBytes(32).toString("base64url");
}
function identity(input: IacRouteIdentity): void {
	if (!routeName(input.tenantId) || !routeName(input.requestId))
		throw new TypeError("invalid route identity");
}
function permitValid(permit: IacRoutePermit): boolean {
	return (
		permit !== null &&
		typeof permit === "object" &&
		routeName(permit.tenantId) &&
		routeName(permit.requestId) &&
		routeDigest(permit.operationId) &&
		routeName(permit.targetId) &&
		routeDigest(permit.inventoryHash) &&
		routeSecret(permit.attemptId)
	);
}

/** A shared local-disk SQLite authority. Distributed installations need an equivalent shared transactional CAS. */
export function createSqliteIacRouteAuthority(options: {
	path: string;
	/** Independent host authentication of tenant, request and logical operation. */
	verifyOperation: (
		input: IacRouteAuthorizedIdentity,
	) => boolean | Promise<boolean>;
}): IacRouteAuthority & { close(): void } {
	if (typeof options.verifyOperation !== "function")
		throw new TypeError("an independent operation verifier is required");
	const verifyOperation = options.verifyOperation;
	if (!options.path || options.path === ":memory:")
		throw new TypeError("a persistent route authority path is required");
	const database = new DatabaseSync(options.path);
	database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
		CREATE TABLE IF NOT EXISTS iac_routes (
			tenant TEXT NOT NULL, request TEXT NOT NULL, claim_token TEXT NOT NULL,
			phase TEXT NOT NULL CHECK(phase IN ('running','finished')),
			active_attempt TEXT, target TEXT, outcome TEXT,
			PRIMARY KEY (tenant, request)
		);
		CREATE TABLE IF NOT EXISTS iac_route_operations (
			tenant TEXT NOT NULL, operation_id TEXT NOT NULL, request TEXT NOT NULL,
			PRIMARY KEY(tenant,operation_id), UNIQUE(tenant,request)
		);
		CREATE TABLE IF NOT EXISTS iac_route_successors (
			tenant TEXT NOT NULL, operation_id TEXT NOT NULL, predecessor TEXT NOT NULL, successor TEXT NOT NULL,
			PRIMARY KEY(tenant,operation_id,predecessor), UNIQUE(tenant,successor),
			FOREIGN KEY(tenant,operation_id) REFERENCES iac_route_operations(tenant,operation_id)
		);
		CREATE TABLE IF NOT EXISTS iac_route_attempts (
			tenant TEXT NOT NULL, request TEXT NOT NULL, attempt TEXT NOT NULL,
			target TEXT NOT NULL, inventory_hash TEXT NOT NULL, ordinal INTEGER NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('running','denied','finished')),
			consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
			PRIMARY KEY (tenant, request, attempt), UNIQUE(tenant, request, ordinal),
			FOREIGN KEY (tenant,request) REFERENCES iac_routes(tenant,request)
		);`);
	// Serialize upgrades; pre-upgrade live permits may already be in use.
	database.exec("BEGIN IMMEDIATE");
	try {
		const columns = database
			.prepare("PRAGMA table_info(iac_route_attempts)")
			.all();
		if (!columns.some((column) => column.name === "consumed")) {
			database.exec(
				"ALTER TABLE iac_route_attempts ADD COLUMN consumed INTEGER NOT NULL DEFAULT 1 CHECK(consumed IN (0,1))",
			);
		}
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			/* Preserve the migration error. */
		}
		database.close();
		throw error;
	}
	function transaction<T>(run: () => T): T {
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				/* Preserve the original failure. */
			}
			throw error;
		}
	}
	function running(input: IacRouteIdentity & { readonly claimToken: string }) {
		identity(input);
		if (!routeSecret(input.claimToken)) throw new Error("invalid route owner");
		const row = database
			.prepare(
				"SELECT phase,claim_token,active_attempt,target,outcome FROM iac_routes WHERE tenant=? AND request=?",
			)
			.get(input.tenantId, input.requestId);
		if (row === undefined || row.claim_token !== input.claimToken)
			throw new Error("route owner mismatch");
		return row;
	}
	return {
		persistence: "durable-cas",
		async claim(input) {
			identity(input);
			const stable = Object.freeze({
				tenantId: input.tenantId,
				requestId: input.requestId,
				operationId: input.operationId,
				authorization: input.authorization,
			});
			if (
				!routeDigest(stable.operationId) ||
				!routeAuthorization(stable.authorization) ||
				(await verifyOperation(stable)) !== true
			)
				throw new Error("logical operation identity not authenticated");
			return transaction(() => {
				const mapping = database
					.prepare(
						"SELECT request FROM iac_route_operations WHERE tenant=? AND operation_id=?",
					)
					.get(stable.tenantId, stable.operationId);
				const byRequest = database
					.prepare(
						"SELECT operation_id FROM iac_route_operations WHERE tenant=? AND request=?",
					)
					.get(stable.tenantId, stable.requestId);
				if (
					byRequest !== undefined &&
					byRequest.operation_id !== stable.operationId
				)
					throw new Error("request belongs to another operation");
				let routeRequest = stable.requestId;
				if (mapping !== undefined) {
					if (
						typeof mapping.request !== "string" ||
						!routeName(mapping.request)
					)
						throw new Error("corrupt operation mapping");
					routeRequest = mapping.request;
					if (routeRequest !== stable.requestId) {
						const grant = database
							.prepare(
								"SELECT 1 AS found FROM iac_route_successors WHERE tenant=? AND operation_id=? AND predecessor=? AND successor=?",
							)
							.get(
								stable.tenantId,
								stable.operationId,
								routeRequest,
								stable.requestId,
							);
						if (grant?.found === 1) {
							const predecessor = database
								.prepare(
									"SELECT phase,active_attempt,outcome FROM iac_routes WHERE tenant=? AND request=?",
								)
								.get(stable.tenantId, routeRequest);
							if (
								predecessor?.phase !== "finished" ||
								predecessor.active_attempt !== null ||
								predecessor.outcome !== JSON.stringify({ status: "denied" })
							)
								throw new Error(
									"successor predecessor is not resolved without effect",
								);
							if (
								database
									.prepare(
										"SELECT 1 FROM iac_routes WHERE tenant=? AND request=?",
									)
									.get(stable.tenantId, stable.requestId) !== undefined
							)
								throw new Error("successor request already exists");
							database
								.prepare(
									"UPDATE iac_route_operations SET request=? WHERE tenant=? AND operation_id=? AND request=?",
								)
								.run(
									stable.requestId,
									stable.tenantId,
									stable.operationId,
									routeRequest,
								);
							routeRequest = stable.requestId;
						}
					}
				} else {
					const legacy = database
						.prepare("SELECT 1 FROM iac_routes WHERE tenant=? AND request=?")
						.get(stable.tenantId, stable.requestId);
					if (legacy === undefined) {
						const unbound = database
							.prepare(
								"SELECT r.request FROM iac_routes r LEFT JOIN iac_route_operations o ON o.tenant=r.tenant AND o.request=r.request WHERE r.tenant=? AND o.request IS NULL LIMIT 1",
							)
							.get(stable.tenantId);
						if (unbound !== undefined)
							throw new Error(
								"legacy route identities require authenticated binding",
							);
					}
					database
						.prepare(
							"INSERT INTO iac_route_operations(tenant,operation_id,request) VALUES(?,?,?)",
						)
						.run(stable.tenantId, stable.operationId, stable.requestId);
				}
				const row = database
					.prepare(
						"SELECT phase,target,outcome FROM iac_routes WHERE tenant=? AND request=?",
					)
					.get(stable.tenantId, routeRequest);
				if (row !== undefined) {
					if (
						(row.phase !== "running" && row.phase !== "finished") ||
						(row.target !== null &&
							(typeof row.target !== "string" || !routeName(row.target)))
					)
						throw new Error("corrupt route record");
					const targetId =
						typeof row.target === "string" ? row.target : undefined;
					const common = {
						tenantId: stable.tenantId,
						requestId: stable.requestId,
						operationId: stable.operationId,
						status: "existing" as const,
						...(targetId === undefined ? {} : { targetId }),
					};
					if (row.phase === "running") {
						if (row.outcome !== null) throw new Error("corrupt route outcome");
						return { ...common, phase: "running" as const };
					}
					if (typeof row.outcome !== "string" || row.outcome.length > 1024)
						throw new Error("corrupt route outcome");
					// SAFETY: validate the persisted route outcome before returning it.
					const outcome = JSON.parse(row.outcome) as IacRouteOutcome;
					if (
						!outcome ||
						!["selected", "denied", "uncertain", "replay"].includes(
							outcome.status,
						) ||
						(outcome.targetId !== undefined && !routeName(outcome.targetId)) ||
						(outcome.targetId !== undefined && outcome.targetId !== targetId)
					)
						throw new Error("corrupt route outcome");
					return { ...common, phase: "finished" as const, outcome };
				}
				if (mapping !== undefined && routeRequest !== stable.requestId)
					throw new Error("operation route is missing");
				if (mapping !== undefined && mapping.request === stable.requestId)
					throw new Error("operation route is missing");
				const claimToken = secret();
				database
					.prepare(
						"INSERT INTO iac_routes(tenant,request,claim_token,phase) VALUES(?,?,?,'running')",
					)
					.run(stable.tenantId, stable.requestId, claimToken);
				return {
					tenantId: stable.tenantId,
					requestId: stable.requestId,
					operationId: stable.operationId,
					status: "claimed" as const,
					claimToken,
				};
			});
		},
		inspect(input) {
			identity(input);
			return transaction(() => {
				const row = database
					.prepare(
						"SELECT phase,outcome FROM iac_routes WHERE tenant=? AND request=?",
					)
					.get(input.tenantId, input.requestId);
				if (row === undefined) return undefined;
				if (row.phase !== "running" && row.phase !== "finished")
					throw new Error("corrupt route phase");
				const attempts = database
					.prepare(
						"SELECT target,inventory_hash,status,ordinal FROM iac_route_attempts WHERE tenant=? AND request=? ORDER BY ordinal LIMIT 257",
					)
					.all(input.tenantId, input.requestId);
				if (attempts.length > 256)
					throw new Error("route attempt limit exceeded");
				const safeAttempts = attempts.map((attempt, index) => {
					if (
						typeof attempt.target !== "string" ||
						!routeName(attempt.target) ||
						typeof attempt.inventory_hash !== "string" ||
						!routeDigest(attempt.inventory_hash) ||
						(attempt.status !== "running" &&
							attempt.status !== "denied" &&
							attempt.status !== "finished") ||
						attempt.ordinal !== index + 1
					)
						throw new Error("corrupt route attempt");
					const status: "running" | "denied" | "finished" = attempt.status;
					return {
						targetId: attempt.target,
						inventoryHash: attempt.inventory_hash,
						status,
					};
				});
				if (row.phase === "running") {
					if (row.outcome !== null) throw new Error("corrupt route outcome");
					return {
						...input,
						phase: "running" as const,
						attempts: safeAttempts,
					};
				}
				if (typeof row.outcome !== "string" || row.outcome.length > 1024)
					throw new Error("corrupt route outcome");
				// SAFETY: persisted JSON is validated before it crosses the authority boundary.
				const outcome = JSON.parse(row.outcome) as IacRouteOutcome;
				if (
					!outcome ||
					!["selected", "denied", "uncertain", "replay"].includes(
						outcome.status,
					) ||
					(outcome.targetId !== undefined && !routeName(outcome.targetId))
				)
					throw new Error("corrupt route outcome");
				return {
					...input,
					phase: "finished" as const,
					outcome,
					attempts: safeAttempts,
				};
			});
		},
		beginAttempt(input) {
			if (
				!routeName(input.targetId) ||
				!routeDigest(input.inventoryHash) ||
				!routeDigest(input.operationId)
			)
				throw new TypeError("invalid route target");
			return transaction(() => {
				const row = running(input);
				if (
					database
						.prepare(
							"SELECT 1 FROM iac_route_operations WHERE tenant=? AND operation_id=? AND request=?",
						)
						.get(input.tenantId, input.operationId, input.requestId) ===
					undefined
				)
					throw new Error("operation is not the active route");
				if (row.phase !== "running" || row.active_attempt !== null)
					throw new Error("route already has an active attempt");
				const count = database
					.prepare(
						"SELECT COUNT(*) AS n FROM iac_route_attempts WHERE tenant=? AND request=?",
					)
					.get(input.tenantId, input.requestId)?.n;
				if (
					typeof count !== "number" ||
					!Number.isSafeInteger(count) ||
					count >= 256
				)
					throw new Error("route attempt limit exceeded");
				const permit: IacRoutePermit = {
					tenantId: input.tenantId,
					requestId: input.requestId,
					operationId: input.operationId,
					targetId: input.targetId,
					inventoryHash: input.inventoryHash,
					attemptId: secret(),
				};
				database
					.prepare(
						"INSERT INTO iac_route_attempts(tenant,request,attempt,target,inventory_hash,ordinal,status,consumed) VALUES(?,?,?,?,?,?,'running',0)",
					)
					.run(
						input.tenantId,
						input.requestId,
						permit.attemptId,
						permit.targetId,
						permit.inventoryHash,
						count + 1,
					);
				database
					.prepare(
						"UPDATE iac_routes SET active_attempt=?,target=? WHERE tenant=? AND request=?",
					)
					.run(
						permit.attemptId,
						permit.targetId,
						input.tenantId,
						input.requestId,
					);
				return permit;
			});
		},
		denyAttempt(input) {
			if (
				!permitValid(input.permit) ||
				input.permit.tenantId !== input.tenantId ||
				input.permit.requestId !== input.requestId
			)
				throw new Error("invalid route permit");
			return transaction(() => {
				const row = running(input);
				if (
					database
						.prepare(
							"SELECT 1 FROM iac_route_operations WHERE tenant=? AND operation_id=? AND request=?",
						)
						.get(input.tenantId, input.permit.operationId, input.requestId) ===
					undefined
				)
					throw new Error("operation is not the active route");
				if (
					row.phase !== "running" ||
					row.active_attempt !== input.permit.attemptId ||
					row.target !== input.permit.targetId
				)
					throw new Error("route attempt is not active");
				const updated = database
					.prepare(
						"UPDATE iac_route_attempts SET status='denied' WHERE tenant=? AND request=? AND attempt=? AND target=? AND inventory_hash=? AND status='running'",
					)
					.run(
						input.tenantId,
						input.requestId,
						input.permit.attemptId,
						input.permit.targetId,
						input.permit.inventoryHash,
					);
				if (updated.changes !== 1) throw new Error("route attempt mismatch");
				database
					.prepare(
						"UPDATE iac_routes SET active_attempt=NULL WHERE tenant=? AND request=?",
					)
					.run(input.tenantId, input.requestId);
				return { status: "denied" as const };
			});
		},
		finish(input) {
			const outcome = input.outcome;
			if (
				!outcome ||
				!["selected", "denied", "uncertain", "replay"].includes(
					outcome.status,
				) ||
				(outcome.targetId !== undefined && !routeName(outcome.targetId))
			)
				throw new TypeError("invalid route outcome");
			const encoded = JSON.stringify({
				status: outcome.status,
				...(outcome.targetId === undefined
					? {}
					: { targetId: outcome.targetId }),
			});
			return transaction(() => {
				const row = running(input);
				if (row.phase === "finished") {
					if (row.outcome !== encoded)
						throw new Error("route outcome conflict");
					return { status: "finished" as const, outcome };
				}
				if (
					row.phase !== "running" ||
					(outcome.status === "denied" && row.active_attempt !== null) ||
					(outcome.status === "selected" &&
						(row.active_attempt === null || row.target !== outcome.targetId)) ||
					(row.active_attempt !== null &&
						outcome.targetId !== undefined &&
						row.target !== outcome.targetId)
				)
					throw new Error("route outcome does not match active attempt");
				if (outcome.status === "selected") {
					const attempt = database
						.prepare(
							"SELECT consumed FROM iac_route_attempts WHERE tenant=? AND request=? AND attempt=? AND status='running'",
						)
						.get(input.tenantId, input.requestId, row.active_attempt);
					if (attempt?.consumed !== 1)
						throw new Error("route attempt was not consumed");
				}
				if (row.active_attempt !== null)
					database
						.prepare(
							"UPDATE iac_route_attempts SET status='finished' WHERE tenant=? AND request=? AND attempt=? AND status='running'",
						)
						.run(input.tenantId, input.requestId, row.active_attempt);
				database
					.prepare(
						"UPDATE iac_routes SET phase='finished',active_attempt=NULL,outcome=? WHERE tenant=? AND request=?",
					)
					.run(encoded, input.tenantId, input.requestId);
				return { status: "finished" as const, outcome };
			});
		},
		consumeAttempt(permit) {
			if (!permitValid(permit)) return false;
			return transaction(() => {
				const updated = database
					.prepare(
						`UPDATE iac_route_attempts SET consumed=1 WHERE tenant=? AND request=? AND attempt=? AND target=? AND inventory_hash=? AND status='running' AND consumed=0 AND EXISTS (SELECT 1 FROM iac_routes r WHERE r.tenant=iac_route_attempts.tenant AND r.request=iac_route_attempts.request AND r.phase='running' AND r.active_attempt=iac_route_attempts.attempt AND EXISTS (SELECT 1 FROM iac_route_operations o WHERE o.tenant=r.tenant AND o.request=r.request AND o.operation_id=?))`,
					)
					.run(
						permit.tenantId,
						permit.requestId,
						permit.attemptId,
						permit.targetId,
						permit.inventoryHash,
						permit.operationId,
					);
				return updated.changes === 1;
			});
		},
		verifyAttempt(permit) {
			if (!permitValid(permit)) return false;
			const row = database
				.prepare(
					`SELECT 1 AS found FROM iac_routes r JOIN iac_route_attempts a ON a.tenant=r.tenant AND a.request=r.request AND a.attempt=r.active_attempt WHERE r.tenant=? AND r.request=? AND r.phase='running' AND a.status='running' AND a.attempt=? AND a.target=? AND a.inventory_hash=? AND EXISTS (SELECT 1 FROM iac_route_operations o WHERE o.tenant=r.tenant AND o.request=r.request AND o.operation_id=?)`,
				)
				.get(
					permit.tenantId,
					permit.requestId,
					permit.attemptId,
					permit.targetId,
					permit.inventoryHash,
					permit.operationId,
				);
			return row?.found === 1;
		},
		close() {
			database.close();
		},
	};
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread */
