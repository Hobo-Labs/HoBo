/** PostgreSQL durable immutable journal voter. This never recreates an
 * established or restored member; freshness and rollback protection come from
 * an independently persisted hosting authority, not the database itself. */
import { createHash } from "node:crypto";
import type {
	ImmutableJournalMember,
	ImmutableJournalSeal,
	SealableImmutableJournalReplica,
} from "@hobo/backend-fleet";
import { isJsonString } from "@hobo/data-core";
import { sqlAssignmentReplica } from "./assignment.js";
import { type FleetLayout, parseFleetLayout } from "./layout.js";
import {
	type FleetBackend,
	parseFleetIdentifier,
	type SqlExecutor,
	type SqlParameter,
	type SqlSession,
} from "./sql.js";

export type ImmutableJournalCharge = Readonly<{
	operation: "initialize" | "read" | "write";
	maxStatements: number;
	maxRowsRead: number;
	maxRowsWritten: number;
	maxReadBytes: number;
	maxWriteBytes: number;
	/** Logical bytes only; WAL, indexes, backups, pages and dead tuples need separate funding. */
	maxAdditionalLogicalBytes: number;
}>;

export interface PostgresImmutableJournalOptions {
	readonly member: ImmutableJournalMember;
	readonly backend: FleetBackend;
	readonly anchorDigest: string;
	readonly initializationId: string;
	readonly controlPrefix: string;
	readonly maxDocumentBytes: number;
	/** Separate owner custody from the non-owner workload login. The named
	 * schema must already exist and be owned by `ownerRole`; only the
	 * supervisor supplies `managementExecutor` for fresh setup and sealing. */
	readonly roleBoundary?: Readonly<{
		readonly schema: string;
		readonly ownerRole: string;
		readonly runtimeRole: string;
		readonly managementExecutor?: SqlExecutor;
	}>;
	/** Reserve the full operation and return a live guard that rechecks its authority. */
	readonly authorize: (
		charge: ImmutableJournalCharge,
	) => Promise<() => Promise<void>>;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;

export class PostgresImmutableJournalError extends Error {
	constructor(readonly reason: string) {
		super(`PostgreSQL immutable journal ${reason}`);
		this.name = "PostgresImmutableJournalError";
	}
}

export function createPostgresImmutableJournalReplica(
	options: PostgresImmutableJournalOptions,
): Readonly<{
	replica: SealableImmutableJournalReplica;
	initializeFresh(
		verifyFresh: (
			member: ImmutableJournalMember,
			initializationId: string,
		) => Promise<void>,
	): Promise<void>;
}> {
	const member = Object.freeze({ ...options.member });
	if (
		member.id !== options.backend.id ||
		!digestPattern.test(options.anchorDigest) ||
		!tokenPattern.test(options.initializationId) ||
		!tokenPattern.test(member.incarnation) ||
		!Number.isSafeInteger(options.maxDocumentBytes) ||
		options.maxDocumentBytes < 1024 ||
		options.maxDocumentBytes > 7_000_000
	)
		throw new PostgresImmutableJournalError("invalid-configuration");
	const rawLayout: FleetLayout = parseFleetLayout({
		dataPrefix: "hobo_journal_data_",
		controlPrefix: options.controlPrefix,
	});
	const boundary = options.roleBoundary
		? Object.freeze({
				schema: parseFleetIdentifier(options.roleBoundary.schema, "schema"),
				ownerRole: parseFleetIdentifier(
					options.roleBoundary.ownerRole,
					"ownerRole",
				),
				runtimeRole: parseFleetIdentifier(
					options.roleBoundary.runtimeRole,
					"runtimeRole",
				),
				managementExecutor: options.roleBoundary.managementExecutor,
			})
		: undefined;
	if (
		boundary &&
		(boundary.ownerRole === boundary.runtimeRole ||
			["public", "pg_catalog", "information_schema"].includes(boundary.schema))
	)
		throw new PostgresImmutableJournalError("invalid-role-boundary");
	const qualify = (name: string) =>
		boundary ? `${boundary.schema}.${name}` : name;
	const layout: FleetLayout = {
		...rawLayout,
		assignmentTable: qualify(rawLayout.assignmentTable),
	};
	const info = qualify(`${layout.controlPrefix}journal_info`);
	const docs = qualify(`${layout.controlPrefix}journal_documents`);
	const assignments = layout.assignmentTable;
	const sealFunction = qualify(`${layout.controlPrefix}journal_seal_guard`);
	const sealTrigger = `${layout.controlPrefix}journal_seal_trigger`;
	const docSealTrigger = `${layout.controlPrefix}seal_docs`;
	const sealFunctionBody = `BEGIN PERFORM 1 FROM ${info} WHERE singleton=true FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'journal identity missing'; END IF; IF EXISTS (SELECT 1 FROM ${info} WHERE singleton=true AND sealed_epoch IS NOT NULL) THEN RAISE EXCEPTION 'journal generation sealed'; END IF; RETURN NEW; END`;
	const token = options.initializationId;
	const anchor = options.anchorDigest;
	const limit = options.maxDocumentBytes;
	const executor = options.backend.executor;
	const charge = (
		operation: ImmutableJournalCharge["operation"],
		statements: number,
		rows: number,
		bytes: number,
	): ImmutableJournalCharge => ({
		operation,
		maxStatements: statements + (boundary ? 2 : 0),
		maxRowsRead: rows + (boundary ? 2 : 0),
		maxRowsWritten: operation === "read" ? 0 : rows,
		maxReadBytes:
			(operation === "read" ? bytes + 2048 : 8192) + (boundary ? 4096 : 0),
		maxWriteBytes: operation === "read" ? 4096 : bytes + 8192,
		maxAdditionalLogicalBytes: operation === "read" ? 0 : bytes + 4096,
	});
	async function identity(session: SqlSession): Promise<void> {
		const result = await session.query(
			`SELECT anchor_digest, member_id, incarnation, initialization_id FROM ${info} WHERE singleton=true`,
		);
		const row = result.rows[0];
		if (
			result.rows.length !== 1 ||
			row?.anchor_digest !== anchor ||
			row.member_id !== member.id ||
			row.incarnation !== member.incarnation ||
			row.initialization_id !== token
		)
			throw new PostgresImmutableJournalError("identity-unverified");
	}
	async function primary(session: SqlSession): Promise<void> {
		const result = await session.query(
			"SELECT pg_is_in_recovery()::text AS standby",
		);
		if (result.rows.length !== 1 || result.rows[0]?.standby !== "false")
			throw new PostgresImmutableJournalError("primary-unverified");
	}
	async function owner(session: SqlSession): Promise<void> {
		if (!boundary) return;
		const result = await session.query(
			"SELECT current_user::text AS current_role, session_user::text AS session_role",
		);
		if (
			result.rows.length !== 1 ||
			result.rows[0]?.current_role !== boundary.ownerRole ||
			result.rows[0]?.session_role !== boundary.ownerRole
		)
			throw new PostgresImmutableJournalError("owner-role-unverified");
	}
	async function runtimeRole(
		session: SqlSession,
		requireSession: boolean,
	): Promise<void> {
		if (!boundary) return;
		const result = await session.query(
			`SELECT current_user::text AS current_role, session_user::text AS session_role,
				r.rolcanlogin::text AS can_login,
				pg_has_role($1, $2, 'MEMBER')::text AS owner_member,
				(SELECT EXISTS (SELECT 1 FROM pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolcreaterole OR privileged.rolreplication OR privileged.rolbypassrls) AND pg_has_role($1, privileged.rolname, 'MEMBER')))::text AS privileged_member,
				has_parameter_privilege($1, 'session_replication_role', 'SET')::text AS replication_override,
				has_schema_privilege($1, $3, 'USAGE')::text AS schema_usage,
				has_schema_privilege($1, $3, 'CREATE')::text AS schema_create,
				(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=$3) AS schema_owner,
				(SELECT (count(*)=3 AND bool_and(pg_get_userbyid(relowner)=$2))::text FROM pg_class WHERE oid IN ($4::regclass,$5::regclass,$6::regclass)) AS owned_tables,
				has_table_privilege($1,$4,'SELECT')::text AS info_read,
				(has_table_privilege($1,$5,'SELECT') AND has_table_privilege($1,$5,'INSERT'))::text AS docs_access,
				(has_table_privilege($1,$6,'SELECT') AND has_table_privilege($1,$6,'INSERT'))::text AS assignment_access,
				has_table_privilege($1,$4,'INSERT')::text AS info_insert,
				(SELECT bool_or(has_table_privilege($1, target, privilege))::text FROM unnest(ARRAY[$4,$5,$6]::text[]) AS target CROSS JOIN unnest(ARRAY['UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']::text[]) AS privilege) AS forbidden,
				(SELECT bool_or(has_any_column_privilege($1, target, 'UPDATE'))::text FROM unnest(ARRAY[$4,$5,$6]::text[]) AS target) AS column_update
			 FROM pg_roles r WHERE r.rolname=$1`,
			[
				boundary.runtimeRole,
				boundary.ownerRole,
				boundary.schema,
				info,
				docs,
				assignments,
			],
		);
		const row = result.rows[0];
		if (
			result.rows.length !== 1 ||
			!row ||
			(requireSession &&
				(row.current_role !== boundary.runtimeRole ||
					row.session_role !== boundary.runtimeRole)) ||
			row.can_login !== "true" ||
			row.owner_member !== "false" ||
			row.privileged_member !== "false" ||
			row.replication_override !== "false" ||
			row.schema_usage !== "true" ||
			row.schema_create !== "false" ||
			row.schema_owner !== boundary.ownerRole ||
			row.owned_tables !== "true" ||
			row.info_read !== "true" ||
			row.docs_access !== "true" ||
			row.assignment_access !== "true" ||
			row.info_insert !== "false" ||
			row.forbidden !== "false" ||
			row.column_update !== "false"
		)
			throw new PostgresImmutableJournalError("runtime-role-unverified");
	}
	async function verifySealTrigger(session: SqlSession): Promise<void> {
		const result = await session.query(
			`SELECT p.prosrc AS body, t.tgenabled::text AS enabled, t.tgtype::text AS kind, t.tgnargs::text AS arguments, (t.tgqual IS NULL)::text AS unconditional, current_setting('session_replication_role') AS replication_role, p.prosecdef::text AS security_definer, pg_get_userbyid(p.proowner) AS function_owner, COALESCE(array_to_string(p.proconfig, ','), '') AS function_config FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND ((t.tgrelid=$1::regclass AND t.tgname=$2) OR (t.tgrelid=$3::regclass AND t.tgname=$4))`,
			[assignments, sealTrigger, docs, docSealTrigger],
		);
		if (
			result.rows.length !== 2 ||
			result.rows.some(
				(row) =>
					row.body !== sealFunctionBody ||
					row.enabled !== "O" ||
					row.kind !== "7" || // FOR EACH ROW, BEFORE INSERT
					row.arguments !== "0" ||
					row.unconditional !== "true" ||
					!["origin", "local"].includes(row.replication_role ?? "") ||
					(boundary !== undefined &&
						(row.security_definer !== "true" ||
							row.function_owner !== boundary.ownerRole ||
							row.function_config !== "search_path=pg_catalog")),
			)
		)
			throw new PostgresImmutableJournalError("seal-trigger-unverified");
		await runtimeRole(session, false);
	}
	async function execute<T>(
		details: ImmutableJournalCharge,
		run: (session: SqlSession, guard: () => Promise<void>) => Promise<T>,
		management = false,
	): Promise<T> {
		const selected =
			management && boundary ? boundary.managementExecutor : executor;
		if (!selected)
			throw new PostgresImmutableJournalError("owner-custody-unavailable");
		let guard: () => Promise<void>;
		try {
			guard = await options.authorize(details);
		} catch {
			throw new PostgresImmutableJournalError("authorization-unavailable");
		}
		if (!(guard instanceof Function))
			throw new PostgresImmutableJournalError("authorization-unavailable");
		try {
			return await selected.session(async (session) => {
				await guard();
				await primary(session);
				await guard();
				if (management) await owner(session);
				else await runtimeRole(session, true);
				await guard();
				const value = await run(session, guard);
				await guard();
				return value;
			});
		} catch (error) {
			if (error instanceof PostgresImmutableJournalError) throw error;
			throw new PostgresImmutableJournalError(
				details.operation === "read" ? "read-unavailable" : "outcome-unknown",
			);
		}
	}
	const scopedBackend: FleetBackend = {
		id: member.id,
		executor: {
			async query(sql: string, parameters?: readonly SqlParameter[]) {
				return execute(
					charge(
						sql.startsWith("SELECT") ? "read" : "write",
						4,
						10_001,
						Math.max(limit, 10_001 * 1024),
					),
					async (session, guard) => {
						await identity(session);
						await guard();
						await verifySealTrigger(session);
						await guard();
						return session.query(sql, parameters);
					},
				);
			},
			session: executor.session.bind(executor),
		},
	};
	const assignmentsReplica = sqlAssignmentReplica(scopedBackend, layout);
	const replica: SealableImmutableJournalReplica = {
		id: member.id,
		async read(max) {
			if (
				max !== undefined &&
				(!Number.isSafeInteger(max) || max < 1 || max > 10_001)
			)
				throw new PostgresImmutableJournalError("invalid-limit");
			// sqlAssignmentReplica treats an absent table as empty. Check it first,
			// so lost provider state is never interpreted as a fresh voter.
			await execute(charge("read", 4, 1, 4096), async (session, guard) => {
				await identity(session);
				await guard();
				await verifySealTrigger(session);
				await guard();
				await session.query(`SELECT epoch FROM ${assignments} LIMIT 0`);
			});
			return assignmentsReplica.read(max ?? 10_001);
		},
		async accept(assignment) {
			return assignmentsReplica.accept(assignment);
		},
		async readDocument(digest) {
			if (!digestPattern.test(digest))
				throw new PostgresImmutableJournalError("invalid-digest");
			return execute(
				charge("read", 4 + (boundary ? 1 : 0), 1, limit * 2),
				async (session, guard) => {
					await identity(session);
					await guard();
					await verifySealTrigger(session);
					await guard();
					const result = await session.query(
						`SELECT CASE WHEN octet_length(body) <= $2::int THEN encode(convert_to(body, 'UTF8'), 'base64') ELSE NULL END AS body FROM ${docs} WHERE digest=$1`,
						[digest, limit],
					);
					if (result.rows.length === 0) return undefined;
					const encoded = result.rows[0]?.body;
					if (!isJsonString(encoded))
						throw new PostgresImmutableJournalError("invalid-document");
					const raw = Buffer.from(encoded.replaceAll("\n", ""), "base64");
					if (
						raw.byteLength > limit ||
						createHash("sha256").update(raw).digest("hex") !== digest
					)
						throw new PostgresImmutableJournalError("invalid-document");
					try {
						return new TextDecoder("utf-8", { fatal: true }).decode(raw);
					} catch {
						throw new PostgresImmutableJournalError("invalid-document");
					}
				},
			);
		},
		async writeDocument(digest, body) {
			if (
				!digestPattern.test(digest) ||
				!isJsonString(body) ||
				Buffer.byteLength(body, "utf8") > limit ||
				createHash("sha256").update(body).digest("hex") !== digest
			)
				throw new PostgresImmutableJournalError("invalid-document");
			await execute(
				charge(
					"write",
					4 + (boundary ? 1 : 0),
					1,
					Buffer.byteLength(body, "utf8") * 2,
				),
				async (session, guard) => {
					await identity(session);
					await guard();
					await verifySealTrigger(session);
					await guard();
					await session.query(
						`INSERT INTO ${docs} (digest, body) VALUES ($1, $2) ON CONFLICT (digest) DO NOTHING`,
						[digest, body],
					);
				},
			);
			if ((await replica.readDocument(digest)) !== body)
				throw new PostgresImmutableJournalError("immutable-conflict");
		},
		async seal(input) {
			const requested: ImmutableJournalSeal = { ...input };
			if (
				!tokenPattern.test(requested.transitionId) ||
				!Number.isSafeInteger(requested.epoch) ||
				requested.epoch < 1 ||
				!digestPattern.test(requested.digest)
			)
				throw new PostgresImmutableJournalError("invalid-seal");
			const state = async (session: SqlSession, lock: boolean) => {
				const result = await session.query(
					`SELECT sealed_epoch::text AS epoch, seal_digest, seal_transition FROM ${info} WHERE singleton=true${lock ? " FOR UPDATE" : ""}`,
				);
				const row = result.rows[0];
				if (result.rows.length !== 1 || !row)
					throw new PostgresImmutableJournalError("identity-unverified");
				return row;
			};
			const matches = (row: Awaited<ReturnType<typeof state>>) =>
				row.epoch === String(requested.epoch) &&
				row.seal_digest === requested.digest &&
				row.seal_transition === requested.transitionId;
			try {
				return await execute(
					charge("write", 10, 2, 8192),
					async (session, guard) => {
						await session.query("BEGIN");
						try {
							await identity(session);
							await guard();
							await verifySealTrigger(session);
							await guard();
							const current = await state(session, true);
							if (current.epoch !== null) {
								await session.query("COMMIT");
								return matches(current)
									? ("duplicate" as const)
									: ("conflict" as const);
							}
							const result = await session.query(
								`SELECT epoch::text AS epoch, reason FROM ${assignments} ORDER BY epoch DESC LIMIT 1`,
							);
							const head = result.rows[0];
							const link = /^j:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(
								head?.reason ?? "",
							);
							if (
								!head ||
								head.epoch !== String(requested.epoch) ||
								link?.[2] !== requested.digest
							) {
								await session.query("COMMIT");
								return "conflict" as const;
							}
							await guard();
							await session.query(
								`UPDATE ${info} SET sealed_epoch=$1,seal_digest=$2,seal_transition=$3 WHERE singleton=true AND sealed_epoch IS NULL`,
								[requested.epoch, requested.digest, requested.transitionId],
							);
							await guard();
							await session.query("COMMIT");
							return "sealed" as const;
						} catch (error) {
							await session.query("ROLLBACK").catch(() => {});
							throw error;
						}
					},
					true,
				);
			} catch (error) {
				if (
					!(error instanceof PostgresImmutableJournalError) ||
					error.reason !== "outcome-unknown"
				)
					throw error;
				const current = await execute(
					charge("read", 4, 1, 8192),
					async (session, guard) => {
						await identity(session);
						await guard();
						await verifySealTrigger(session);
						await guard();
						return state(session, false);
					},
					true,
				);
				if (matches(current)) return "duplicate";
				if (current.epoch !== null) return "conflict";
				throw error;
			}
		},
	};
	return Object.freeze({
		replica,
		async initializeFresh(verifyFresh) {
			try {
				await verifyFresh(member, token);
			} catch {
				throw new PostgresImmutableJournalError("freshness-unverified");
			}
			try {
				await execute(
					charge("initialize", 13 + (boundary ? 4 : 0), 1, 16_384),
					async (session, guard) => {
						await session.query("BEGIN");
						try {
							await guard();
							await session.query(
								`CREATE TABLE ${info} (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), anchor_digest text NOT NULL, member_id text NOT NULL, incarnation text NOT NULL, initialization_id text NOT NULL, sealed_epoch bigint, seal_digest text, seal_transition text, CHECK ((sealed_epoch IS NULL AND seal_digest IS NULL AND seal_transition IS NULL) OR (sealed_epoch > 0 AND seal_digest IS NOT NULL AND seal_transition IS NOT NULL)))`,
							);
							await session.query(
								`INSERT INTO ${info} (anchor_digest, member_id, incarnation, initialization_id) VALUES ($1,$2,$3,$4)`,
								[anchor, member.id, member.incarnation, token],
							);
							await session.query(
								`CREATE TABLE ${docs} (digest text PRIMARY KEY, body text NOT NULL)`,
							);
							await session.query(
								`CREATE TABLE ${assignments} (epoch bigint PRIMARY KEY CHECK (epoch >= 1), active text CHECK (octet_length(active) <= 63), sealed boolean NOT NULL, target text CHECK (octet_length(target) <= 63), reason text NOT NULL CHECK (octet_length(reason) <= 200), loss_window_ms bigint CHECK (loss_window_ms >= 0), decided_at timestamptz NOT NULL, decided_by text NOT NULL CHECK (octet_length(decided_by) <= 120), CHECK (sealed = (target IS NOT NULL)), CHECK (NOT sealed OR target IS DISTINCT FROM active))`,
							);
							await session.query(
								`CREATE FUNCTION ${sealFunction}() RETURNS trigger LANGUAGE plpgsql ${boundary ? "SECURITY DEFINER SET search_path = pg_catalog " : ""}AS $hobo$${sealFunctionBody}$hobo$`,
							);
							await session.query(
								`CREATE TRIGGER ${sealTrigger} BEFORE INSERT ON ${assignments} FOR EACH ROW EXECUTE FUNCTION ${sealFunction}()`,
							);
							await session.query(
								`CREATE TRIGGER ${docSealTrigger} BEFORE INSERT ON ${docs} FOR EACH ROW EXECUTE FUNCTION ${sealFunction}()`,
							);
							if (boundary) {
								await session.query(
									`GRANT USAGE ON SCHEMA ${boundary.schema} TO ${boundary.runtimeRole}`,
								);
								await session.query(
									`GRANT SELECT ON ${info} TO ${boundary.runtimeRole}`,
								);
								await session.query(
									`GRANT SELECT, INSERT ON ${docs}, ${assignments} TO ${boundary.runtimeRole}`,
								);
								await verifySealTrigger(session);
							}
							await guard();
							await session.query("COMMIT");
						} catch (error) {
							await session.query("ROLLBACK").catch(() => {});
							throw error;
						}
					},
					true,
				);
			} catch (error) {
				if (
					error instanceof PostgresImmutableJournalError &&
					error.reason === "authorization-unavailable"
				)
					throw error;
				// A lost COMMIT response is recovered only by matching every durable
				// identity field and both tables under the same fresh admission.
				try {
					await execute(
						charge("read", 5, 1, 4096),
						async (session, guard) => {
							await identity(session);
							await guard();
							await verifySealTrigger(session);
							await guard();
							await session.query(`SELECT epoch FROM ${assignments} LIMIT 0`);
							await session.query(`SELECT digest FROM ${docs} LIMIT 0`);
						},
						true,
					);
				} catch {
					throw error;
				}
			}
		},
	});
}
