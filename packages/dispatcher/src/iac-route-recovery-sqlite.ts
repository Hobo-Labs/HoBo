/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: validate persisted SQLite values before using them. */
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { stableHash } from "./dispatcher.js";
import {
	type IacRouteIdentity,
	type IacRouteOutcome,
	routeDigest,
	routeName,
	routeSecret,
} from "./iac-route.js";
import {
	type IacRouteRecoveryAttempt,
	type IacRouteRecoveryClaim,
	type IacRouteRecoveryRecord,
	type IacRouteRecoverySnapshot,
	type IacRouteRecoveryStore,
	normalizeIacRouteRecoveryClaim,
	recoveryClaimDigest,
	recoveryMatchesSnapshot,
} from "./iac-route-recovery.js";

function assertIdentity(identity: IacRouteIdentity): void {
	if (!routeName(identity.tenantId) || !routeName(identity.requestId))
		throw new TypeError("invalid route identity");
}
function checkRow(
	row: Record<string, SQLOutputValue>,
	maxStringLength = 4096,
): void {
	for (const value of Object.values(row)) {
		if (
			value !== null &&
			(typeof value !== "string" || value.length > maxStringLength) &&
			(typeof value !== "number" || !Number.isSafeInteger(value))
		)
			throw new Error("corrupt route row");
	}
}
function readOutcome(value: unknown): IacRouteOutcome {
	if (typeof value !== "string" || value.length > 1024)
		throw new Error("corrupt route outcome");
	// SAFETY: the parsed outcome's status and target are checked before return.
	const result = JSON.parse(value) as IacRouteOutcome;
	if (
		!result ||
		!["selected", "denied", "uncertain", "replay"].includes(result.status) ||
		(result.targetId !== undefined && !routeName(result.targetId))
	)
		throw new Error("corrupt route outcome");
	return result.targetId === undefined
		? { status: result.status }
		: { status: result.status, targetId: result.targetId };
}
/** Use the same protected SQLite file as the route authority, never a separate ledger. */
export function createSqliteIacRouteRecoveryStore(options: {
	readonly path: string;
	readonly now?: () => number;
}): IacRouteRecoveryStore & { close(): void } {
	if (!options.path || options.path === ":memory:")
		throw new TypeError("a persistent route authority path is required");
	const database = new DatabaseSync(options.path);
	const now = options.now ?? Date.now;
	try {
		database.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
		);
		const routes = database.prepare("PRAGMA table_info(iac_routes)").all();
		const attempts = database
			.prepare("PRAGMA table_info(iac_route_attempts)")
			.all();
		const operations = database
			.prepare("PRAGMA table_info(iac_route_operations)")
			.all();
		const successors = database
			.prepare("PRAGMA table_info(iac_route_successors)")
			.all();
		if (
			!routes.length ||
			!operations.length ||
			!successors.length ||
			!attempts.some((column) => column.name === "consumed")
		)
			throw new Error("route authority and one-use migration are required");
		database.exec(`CREATE TABLE IF NOT EXISTS iac_route_recoveries (
			tenant TEXT NOT NULL, request TEXT NOT NULL, claim_json TEXT NOT NULL,
			claim_digest TEXT NOT NULL, post_version TEXT NOT NULL, successor TEXT,
			PRIMARY KEY(tenant,request), UNIQUE(tenant,successor),
			FOREIGN KEY(tenant,request) REFERENCES iac_routes(tenant,request)
		)`);
	} catch (error) {
		database.close();
		throw error;
	}
	function transaction<T>(write: boolean, run: () => T, deadline?: number): T {
		database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const result = run();
			if (deadline !== undefined) {
				const checkedAt = now();
				if (!Number.isSafeInteger(checkedAt) || checkedAt >= deadline)
					throw new Error("recovery authorization expired");
			}
			database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				/* Preserve the original error. */
			}
			throw error;
		}
	}
	function snapshot(
		identity: IacRouteIdentity,
		operationId?: string,
	): IacRouteRecoverySnapshot | undefined {
		assertIdentity(identity);
		const route = database
			.prepare("SELECT * FROM iac_routes WHERE tenant=? AND request=?")
			.get(identity.tenantId, identity.requestId);
		if (!route) return undefined;
		const operation =
			operationId === undefined
				? database
						.prepare(
							"SELECT * FROM iac_route_operations WHERE tenant=? AND request=?",
						)
						.get(identity.tenantId, identity.requestId)
				: database
						.prepare(
							"SELECT * FROM iac_route_operations WHERE tenant=? AND operation_id=?",
						)
						.get(identity.tenantId, operationId);
		if (!operation) throw new Error("route operation mapping missing");
		checkRow(operation);
		if (
			operation.tenant !== identity.tenantId ||
			typeof operation.operation_id !== "string" ||
			!routeDigest(operation.operation_id) ||
			typeof operation.request !== "string" ||
			!routeName(operation.request) ||
			(operationId !== undefined && operation.operation_id !== operationId)
		)
			throw new Error("corrupt route operation mapping");
		checkRow(route);
		if (
			route.tenant !== identity.tenantId ||
			route.request !== identity.requestId ||
			typeof route.claim_token !== "string" ||
			!routeSecret(route.claim_token) ||
			(route.phase !== "running" && route.phase !== "finished") ||
			(route.target !== null &&
				(typeof route.target !== "string" || !routeName(route.target))) ||
			(route.active_attempt !== null &&
				(typeof route.active_attempt !== "string" ||
					!routeSecret(route.active_attempt)))
		)
			throw new Error("corrupt route");
		const rows = database
			.prepare(
				"SELECT * FROM iac_route_attempts WHERE tenant=? AND request=? ORDER BY ordinal LIMIT 257",
			)
			.all(identity.tenantId, identity.requestId);
		if (rows.length > 256) throw new Error("route attempt limit exceeded");
		const attempts: IacRouteRecoveryAttempt[] = rows.map((row, index) => {
			checkRow(row);
			if (
				row.tenant !== identity.tenantId ||
				row.request !== identity.requestId ||
				typeof row.attempt !== "string" ||
				!routeSecret(row.attempt) ||
				typeof row.target !== "string" ||
				!routeName(row.target) ||
				typeof row.inventory_hash !== "string" ||
				!routeDigest(row.inventory_hash) ||
				row.ordinal !== index + 1 ||
				(row.status !== "running" &&
					row.status !== "denied" &&
					row.status !== "finished") ||
				(row.consumed !== 0 && row.consumed !== 1)
			)
				throw new Error("corrupt route attempt");
			return {
				ordinal: index + 1,
				targetId: row.target,
				inventoryHash: row.inventory_hash,
				attemptRef: stableHash(row.attempt),
				status: row.status,
				consumed: row.consumed === 1,
			};
		});
		const routeVersion = stableHash({ route, attempts: rows });
		const version = stableHash({ route, attempts: rows, operation });
		const operationFields = {
			operationId: operation.operation_id,
			operationCurrentRequest: operation.request,
			routeVersion,
		};
		const active = rows.filter((row) => row.status === "running");
		if (route.phase === "running") {
			if (
				route.outcome !== null ||
				active.length > 1 ||
				(active.length === 0 && route.active_attempt !== null) ||
				(active.length === 1 &&
					(route.active_attempt !== active[0].attempt ||
						route.target !== active[0].target ||
						active[0] !== rows.at(-1)))
			)
				throw new Error("corrupt active route");
			return {
				tenantId: identity.tenantId,
				requestId: identity.requestId,
				version,
				...operationFields,
				phase: "running",
				attempts,
			};
		}
		if (route.active_attempt !== null || active.length !== 0)
			throw new Error("corrupt finished route");
		const outcome = readOutcome(route.outcome);
		if (outcome.targetId !== undefined && outcome.targetId !== route.target)
			throw new Error("corrupt route target");
		return {
			tenantId: identity.tenantId,
			requestId: identity.requestId,
			version,
			...operationFields,
			phase: "finished",
			outcome,
			attempts,
		};
	}
	function record(
		identity: IacRouteIdentity,
	): IacRouteRecoveryRecord | undefined {
		assertIdentity(identity);
		const row = database
			.prepare(
				"SELECT * FROM iac_route_recoveries WHERE tenant=? AND request=?",
			)
			.get(identity.tenantId, identity.requestId);
		if (!row) return undefined;
		checkRow(row, 100_000);
		if (
			typeof row.claim_json !== "string" ||
			row.claim_json.length > 100_000 ||
			typeof row.claim_digest !== "string" ||
			!routeDigest(row.claim_digest) ||
			typeof row.post_version !== "string" ||
			!routeDigest(row.post_version)
		)
			throw new Error("corrupt recovery record");
		const claim = normalizeIacRouteRecoveryClaim(JSON.parse(row.claim_json));
		if (
			!claim ||
			claim.tenantId !== identity.tenantId ||
			claim.requestId !== identity.requestId ||
			recoveryClaimDigest(claim) !== row.claim_digest ||
			(claim.outcome.kind === "no-effect"
				? row.successor !== claim.outcome.successorRequestId
				: row.successor !== null)
		)
			throw new Error("corrupt recovery claim");
		const current = snapshot(identity, claim.operationId);
		const grant = database
			.prepare(
				"SELECT * FROM iac_route_successors WHERE tenant=? AND operation_id=? AND predecessor=?",
			)
			.get(claim.tenantId, claim.operationId, claim.requestId);
		if (
			claim.outcome.kind === "no-effect"
				? !grant || grant.successor !== claim.outcome.successorRequestId
				: grant !== undefined
		)
			throw new Error("recovery grant changed");
		const expectedOutcome =
			claim.outcome.kind === "no-effect"
				? { status: "denied" }
				: { status: "selected", targetId: claim.outcome.targetId };
		if (
			!current ||
			current.routeVersion !== row.post_version ||
			current.phase !== "finished" ||
			JSON.stringify(current.outcome) !== JSON.stringify(expectedOutcome)
		)
			throw new Error("recovered route changed");
		return { claim, claimDigest: row.claim_digest };
	}
	function commit(input: {
		readonly claim: IacRouteRecoveryClaim;
		readonly claimDigest: string;
	}): void {
		const claim = normalizeIacRouteRecoveryClaim(input.claim);
		if (!claim || input.claimDigest !== recoveryClaimDigest(claim))
			throw new Error("invalid recovery claim");
		transaction(
			true,
			() => {
				const existing = record(claim);
				if (existing) {
					if (
						existing.claimDigest !== input.claimDigest ||
						JSON.stringify(existing.claim) !== JSON.stringify(claim)
					)
						throw new Error("conflicting recovery");
					return;
				}
				const currentTime = now();
				if (
					!Number.isSafeInteger(currentTime) ||
					currentTime >= claim.expiresAt ||
					claim.expiresAt > currentTime + 300_000
				)
					throw new Error("recovery authorization expired");
				const before = snapshot(claim, claim.operationId);
				if (!before || !recoveryMatchesSnapshot(claim, before))
					throw new Error("route changed during verification");
				if (claim.outcome.kind === "no-effect") {
					const successor = claim.outcome.successorRequestId;
					if (
						database
							.prepare("SELECT 1 FROM iac_routes WHERE tenant=? AND request=?")
							.get(claim.tenantId, successor) ||
						database
							.prepare(
								"SELECT 1 FROM iac_route_recoveries WHERE tenant=? AND successor=?",
							)
							.get(claim.tenantId, successor)
					)
						throw new Error("successor already used");
				}
				const target =
					claim.outcome.kind === "selected" ? claim.outcome.targetId : null;
				const outcome =
					target === null
						? { status: "denied" }
						: { status: "selected", targetId: target };
				database
					.prepare(
						"UPDATE iac_route_attempts SET status='finished' WHERE tenant=? AND request=? AND status='running'",
					)
					.run(claim.tenantId, claim.requestId);
				database
					.prepare(
						"UPDATE iac_routes SET claim_token=?,phase='finished',active_attempt=NULL,target=?,outcome=? WHERE tenant=? AND request=?",
					)
					.run(
						randomBytes(32).toString("base64url"),
						target,
						JSON.stringify(outcome),
						claim.tenantId,
						claim.requestId,
					);
				if (claim.outcome.kind === "no-effect") {
					database
						.prepare(
							"INSERT INTO iac_route_successors(tenant,operation_id,predecessor,successor) VALUES(?,?,?,?)",
						)
						.run(
							claim.tenantId,
							claim.operationId,
							claim.requestId,
							claim.outcome.successorRequestId,
						);
				}
				const after = snapshot(claim, claim.operationId);
				if (!after) throw new Error("route disappeared");
				database
					.prepare(
						"INSERT INTO iac_route_recoveries(tenant,request,claim_json,claim_digest,post_version,successor) VALUES(?,?,?,?,?,?)",
					)
					.run(
						claim.tenantId,
						claim.requestId,
						JSON.stringify(claim),
						input.claimDigest,
						after.routeVersion,
						claim.outcome.kind === "no-effect"
							? claim.outcome.successorRequestId
							: null,
					);
			},
			claim.expiresAt,
		);
	}
	return {
		persistence: "durable-cas",
		inspect: (identity) => transaction(false, () => snapshot(identity)),
		get: (identity) => transaction(false, () => record(identity)),
		commit,
		close: () => database.close(),
	};
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */
