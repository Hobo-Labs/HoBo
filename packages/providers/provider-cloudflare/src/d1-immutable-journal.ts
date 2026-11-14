/**
 * Durable immutable-journal voter on a dedicated Cloudflare D1 primary. Every
 * request is bounded and funded; the host must independently attest primary
 * consistency, exclusive schema ownership, fresh enrollment and anti-rollback.
 */
import { createHash } from "node:crypto";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	assignmentKey,
	type FleetAssignment,
	type ImmutableJournalMember,
	type ImmutableJournalReplica,
	type ImmutableJournalSeal,
	parseFleetAssignment,
	type SealableImmutableJournalReplica,
} from "@hobo/backend-fleet";
import { createBoundedFetchTransport, guardTransport } from "@hobo/core";
import { z } from "zod";
import { D1JournalLogSchema } from "./_generated/hobo/provider/cloudflare/d1_journal/v1/d1_immutable_journal_pb.js";

const digest = /^[a-f0-9]{64}$/u;
const name = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const root = "0".repeat(64);
const row = z.strictObject({
	epoch: z.number().int().positive().safe(),
	active: z.string().optional(),
	sealed: z.boolean(),
	target: z.string().optional(),
	reason: z.string(),
	lossWindowMs: z.number().int().nonnegative().safe().optional(),
	decidedAtMs: z.number().int().nonnegative().safe(),
	decidedBy: z.string(),
});
const response = z.object({
	success: z.literal(true),
	result: z
		.array(
			z.object({
				success: z.literal(true),
				meta: z.object({
					served_by_primary: z.literal(true),
					rows_read: z.number().int().nonnegative(),
					rows_written: z.number().int().nonnegative(),
				}),
				results: z
					.object({
						rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
					})
					.optional(),
			}),
		)
		.length(1),
});

export type D1ImmutableJournalCharge = Readonly<{
	operation: "read" | "write";
	maxRowsRead: number;
	maxRowsWritten: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
	/** Includes SQL input and provider-observed bounded physical overhead. */
	maxAdditionalStorageBytes: number;
}>;
export interface D1ImmutableJournalOptions {
	readonly member: ImmutableJournalMember;
	readonly fleetId: string;
	readonly members: readonly ImmutableJournalMember[];
	readonly anchorDigest: string;
	readonly initializationId: string;
	readonly accountId: string;
	readonly databaseId: string;
	readonly maxEntries: number;
	readonly maxLogBytes: number;
	readonly maxDocumentBytes: number;
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	/** Independent provider observation of a dedicated database's maximum
	 * catalog/index rows and retained physical bytes per statement. */
	readonly maxRowsPerQuery: number;
	readonly maxStorageOverheadBytes: number;
	readonly resolveToken: () => Promise<string>;
	readonly fetchImpl: typeof globalThis.fetch;
	readonly authorize: (
		charge: D1ImmutableJournalCharge,
	) => Promise<() => Promise<void>>;
}
export class D1ImmutableJournalError extends Error {
	constructor(readonly reason: string) {
		super(`Cloudflare D1 immutable journal ${reason}`);
		this.name = "D1ImmutableJournalError";
	}
}

export type D1ImmutableJournalReplicaIdentity = Readonly<{
	member: ImmutableJournalMember;
	fleetId: string;
	anchorDigest: string;
	initializationId: string;
	accountId: string;
	databaseId: string;
	table: string;
}>;
const replicaBindings = new WeakMap<
	object,
	Readonly<{
		identity: D1ImmutableJournalReplicaIdentity;
		resolveToken: D1ImmutableJournalOptions["resolveToken"];
		fetchImpl: typeof globalThis.fetch;
		authorize: D1ImmutableJournalOptions["authorize"];
	}>
>();
/** Adapter construction identity; account access and funding are independent. */
export function d1ImmutableJournalReplicaIdentity(
	replica: ImmutableJournalReplica | null | undefined,
): D1ImmutableJournalReplicaIdentity {
	if (!replica) throw new D1ImmutableJournalError("replica-unverified");
	const binding = replicaBindings.get(replica);
	if (!binding) throw new D1ImmutableJournalError("replica-unverified");
	return binding.identity;
}
/** Match the exact credential, transport and Broker callbacks installed at construction. */
export function assertD1ImmutableJournalReplicaWiring(
	replica: ImmutableJournalReplica | null | undefined,
	input: {
		readonly resolveToken: D1ImmutableJournalOptions["resolveToken"];
		readonly fetchImpl: typeof globalThis.fetch;
		readonly authorize: D1ImmutableJournalOptions["authorize"];
	},
): void {
	if (!replica) throw new D1ImmutableJournalError("replica-unverified");
	const binding = replicaBindings.get(replica);
	if (
		!binding ||
		binding.resolveToken !== input.resolveToken ||
		binding.fetchImpl !== input.fetchImpl ||
		binding.authorize !== input.authorize
	)
		throw new D1ImmutableJournalError("replica-wiring-mismatch");
}

/** The actual dedicated journal table, derived from the anchored member and
 * the independently approved initialization identity. */
export function d1ImmutableJournalTable(input: {
	readonly anchorDigest: string;
	readonly member: ImmutableJournalMember;
	readonly initializationId: string;
}): string {
	if (
		!digest.test(input.anchorDigest) ||
		!name.test(input.initializationId) ||
		Object.values(input.member).some((value) => !name.test(value))
	)
		throw new D1ImmutableJournalError("invalid-configuration");
	return `hobo_journal_${hash(JSON.stringify([input.anchorDigest, input.member, input.initializationId])).slice(0, 32)}`;
}

export function createD1ImmutableJournalReplica(
	options: D1ImmutableJournalOptions,
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
	const members = options.members.map((entry) => ({ ...entry }));
	const fleetId = options.fleetId,
		anchorDigest = options.anchorDigest,
		token = options.initializationId;
	const anchor = JSON.stringify({
		contract: "hobo.immutable-journal-anchor/v1",
		fleetId,
		members,
	});
	const genesis = JSON.stringify({
		contract: "hobo.immutable-journal-command/v1",
		position: 0,
		previous: root,
		operationId: "genesis",
		value: anchor,
	});
	if (
		!name.test(fleetId) ||
		!name.test(token) ||
		!digest.test(anchorDigest) ||
		hash(anchor) !== anchorDigest ||
		members.length < 3 ||
		members.length > 31 ||
		members.length % 2 === 0 ||
		new Set(members.map((item) => item.id)).size !== members.length ||
		members.some((item) =>
			Object.values(item).some(
				(value) => !z.string().regex(name).safeParse(value).success,
			),
		) ||
		JSON.stringify(members.find((item) => item.id === member.id)) !==
			JSON.stringify(member) ||
		member.provider !== "cloudflare" ||
		member.accountId !== options.accountId ||
		member.resourceId !== options.databaseId ||
		!/^[a-f0-9]{32}$/u.test(options.accountId) ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
			options.databaseId,
		) ||
		!Number.isSafeInteger(options.maxEntries) ||
		options.maxEntries < 1 ||
		options.maxEntries > 10_000 ||
		!Number.isSafeInteger(options.maxLogBytes) ||
		options.maxLogBytes < 1024 ||
		options.maxLogBytes > 500_000 ||
		!Number.isSafeInteger(options.maxDocumentBytes) ||
		options.maxDocumentBytes < 1024 ||
		options.maxDocumentBytes > 1_000_000 ||
		!Number.isSafeInteger(options.maxRequestBytes) ||
		options.maxRequestBytes < 1024 ||
		options.maxRequestBytes > 2_000_000 ||
		!Number.isSafeInteger(options.maxResponseBytes) ||
		options.maxResponseBytes < 1024 ||
		options.maxResponseBytes > 2_000_000 ||
		!Number.isSafeInteger(options.maxRowsPerQuery) ||
		options.maxRowsPerQuery < 1 ||
		options.maxRowsPerQuery > 100_000 ||
		!Number.isSafeInteger(options.maxStorageOverheadBytes) ||
		options.maxStorageOverheadBytes < 1 ||
		options.maxStorageOverheadBytes > 2_000_000_000 ||
		!(options.resolveToken instanceof Function) ||
		!(options.fetchImpl instanceof Function) ||
		!(options.authorize instanceof Function)
	)
		throw new D1ImmutableJournalError("invalid-configuration");
	const maxEntries = options.maxEntries,
		maxLogBytes = options.maxLogBytes,
		maxDocumentBytes = options.maxDocumentBytes;
	const maxRequestBytes = options.maxRequestBytes,
		maxResponseBytes = options.maxResponseBytes,
		maxRowsPerQuery = options.maxRowsPerQuery,
		overhead = options.maxStorageOverheadBytes;
	const resolveToken = options.resolveToken.bind(options),
		authorize = options.authorize.bind(options);
	const table = d1ImmutableJournalTable({
		anchorDigest,
		member,
		initializationId: token,
	});
	const schema = `CREATE TABLE ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`;
	const path = `/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/raw`;
	const transport = guardTransport(
		createBoundedFetchTransport({ fetchImpl: options.fetchImpl }),
		{
			allowedHosts: ["api.cloudflare.com"],
			allowedPathPrefixes: [path],
			maxTimeoutMs: 15_000,
			maxResponseBytes,
		},
	);
	const envelope = z.strictObject({
		contract: z.literal("hobo.d1-immutable-journal/v1"),
		anchorDigest: z.literal(anchorDigest),
		fleetId: z.literal(fleetId),
		member: z.strictObject({
			id: z.literal(member.id),
			provider: z.literal(member.provider),
			accountId: z.literal(member.accountId),
			resourceId: z.literal(member.resourceId),
			incarnation: z.literal(member.incarnation),
		}),
		initializationId: z.literal(token),
		entries: z.array(row).max(maxEntries + 1),
		seal: z
			.strictObject({
				transitionId: z.string().regex(name),
				epoch: z.number().int().positive().safe(),
				digest: z.string().regex(digest),
			})
			.optional(),
	});
	function encode(
		entries: readonly FleetAssignment[],
		seal?: ImmutableJournalSeal,
	) {
		const record = create(D1JournalLogSchema, {
			contract: "hobo.d1-immutable-journal/v1",
			anchorDigest,
			fleetId,
			member,
			initializationId: token,
			entries: [...entries],
			...(seal ? { seal } : undefined),
		});
		return toJsonString(D1JournalLogSchema, record, {
			alwaysEmitImplicit: true,
		});
	}
	function decode(text: string) {
		if (Buffer.byteLength(text, "utf8") > maxLogBytes)
			throw new D1ImmutableJournalError("invalid-log");
		let parsed: z.infer<typeof envelope>;
		try {
			fromJsonString(D1JournalLogSchema, text);
			// Protobuf supplies scalar defaults; this persisted format also requires
			// the original input to contain every mandatory journal field.
			parsed = envelope.parse(JSON.parse(text));
		} catch {
			throw new D1ImmutableJournalError("identity-unverified");
		}
		let previous = root;
		const entries = parsed.entries.map((item, index) => {
			let value: FleetAssignment;
			try {
				value = parseFleetAssignment({
					epoch: item.epoch,
					active: item.active,
					sealed: item.sealed,
					target: item.target,
					reason: item.reason,
					lossWindowMs: item.lossWindowMs,
					decidedAtMs: item.decidedAtMs,
					decidedBy: item.decidedBy,
				});
			} catch {
				throw new D1ImmutableJournalError("invalid-log");
			}
			const link = /^j:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(value.reason);
			if (
				value.epoch !== index + 1 ||
				value.active !== undefined ||
				value.sealed ||
				value.target !== undefined ||
				value.lossWindowMs !== undefined ||
				value.decidedAtMs !== 0 ||
				value.decidedBy !== "journal" ||
				!link ||
				link[1] !== previous ||
				(index === 0 && link[2] !== hash(genesis))
			)
				throw new D1ImmutableJournalError("invalid-log");
			previous = link[2] ?? "";
			return value;
		});
		if (
			parsed.seal &&
			(parsed.seal.epoch !== entries.length || parsed.seal.digest !== previous)
		)
			throw new D1ImmutableJournalError("invalid-seal");
		return { entries, ...(parsed.seal ? { seal: parsed.seal } : undefined) };
	}
	async function query(
		sql: string,
		params: readonly string[],
		operation: "read" | "write",
	) {
		const body = JSON.stringify({ sql, params });
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > maxRequestBytes)
			throw new D1ImmutableJournalError("request-too-large");
		let guard: () => Promise<void>;
		try {
			guard = await authorize({
				operation,
				maxRowsRead: maxRowsPerQuery,
				maxRowsWritten: operation === "read" ? 0 : maxRowsPerQuery,
				maxRequestBytes: bytes,
				maxResponseBytes,
				maxAdditionalStorageBytes: operation === "read" ? 0 : bytes + overhead,
			});
			if (!(guard instanceof Function)) throw new Error();
			await guard();
		} catch {
			throw new D1ImmutableJournalError("authorization-unavailable");
		}
		let credential: string;
		try {
			credential = await resolveToken();
		} catch {
			throw new D1ImmutableJournalError("credential-unavailable");
		}
		if (!credential || credential.length > 32_768 || /[\r\n]/u.test(credential))
			throw new D1ImmutableJournalError("credential-unavailable");
		try {
			await guard();
		} catch {
			throw new D1ImmutableJournalError("authorization-unavailable");
		}
		let value: Awaited<ReturnType<typeof transport>>;
		try {
			value = await transport({
				method: "POST",
				url: `https://api.cloudflare.com${path}`,
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body,
				timeoutMs: 15_000,
				maxResponseBytes,
			});
			await guard();
		} catch {
			throw new D1ImmutableJournalError(
				operation === "read" ? "read-unavailable" : "write-outcome-unknown",
			);
		}
		if (value.status !== 200)
			throw new D1ImmutableJournalError(
				operation === "read" ? "read-unavailable" : "write-outcome-unknown",
			);
		let parsed: z.infer<typeof response>;
		try {
			parsed = response.parse(JSON.parse(value.body));
		} catch {
			// A malformed, failed or non-primary response may follow a committed
			// mutation. Only a separate primary read can resolve its outcome.
			throw new D1ImmutableJournalError(
				operation === "read" ? "primary-unverified" : "write-outcome-unknown",
			);
		}
		const result = parsed.result[0];
		if (
			!result ||
			result.meta.rows_read > maxRowsPerQuery ||
			result.meta.rows_written > (operation === "read" ? 0 : maxRowsPerQuery)
		)
			throw new D1ImmutableJournalError("capacity-exceeded");
		return result.results?.rows ?? [];
	}
	async function log() {
		const rows = await query(
			`SELECT value FROM ${table} WHERE key=?1`,
			["log"],
			"read",
		);
		const value = z.string().safeParse(rows[0]?.[0]);
		if (rows.length !== 1 || !value.success)
			throw new D1ImmutableJournalError("identity-unverified");
		return { body: value.data, ...decode(value.data) };
	}
	async function verifySchema() {
		const rows = await query(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
			[table],
			"read",
		);
		if (rows.length !== 1 || rows[0]?.[0] !== schema)
			throw new D1ImmutableJournalError("schema-unverified");
	}
	const replica: SealableImmutableJournalReplica = {
		id: member.id,
		async read(limit) {
			if (
				limit !== undefined &&
				(!Number.isSafeInteger(limit) || limit < 1 || limit > maxEntries + 1)
			)
				throw new D1ImmutableJournalError("invalid-limit");
			const { entries } = await log();
			return entries.slice(-(limit ?? entries.length));
		},
		async accept(input) {
			let proposed: FleetAssignment;
			try {
				proposed = parseFleetAssignment(input);
			} catch {
				throw new D1ImmutableJournalError("invalid-assignment");
			}
			const current = await log(),
				old = current.entries[proposed.epoch - 1];
			if (old)
				return assignmentKey(old) === assignmentKey(proposed)
					? "duplicate"
					: "conflict";
			if (current.seal) throw new D1ImmutableJournalError("generation-sealed");
			if (proposed.epoch !== current.entries.length + 1) return "gap";
			// The persisted log holds at most maxEntries + 1 rows; report a full
			// voter as such rather than as an unverifiable identity.
			if (proposed.epoch > maxEntries + 1)
				throw new D1ImmutableJournalError("retention-limit");
			const body = encode([...current.entries, proposed]);
			decode(body);
			const link = /^j:[a-f0-9]{64}:([a-f0-9]{64})$/u.exec(proposed.reason);
			if (!link?.[1] || (await replica.readDocument(link[1])) === undefined)
				throw new D1ImmutableJournalError("document-unavailable");
			try {
				const updated = await query(
					`UPDATE ${table} SET value=?1 WHERE key='log' AND value=?2 RETURNING 1`,
					[body, current.body],
					"write",
				);
				if (updated.length === 1 && updated[0]?.[0] === 1) return "accepted";
				if (updated.length !== 0)
					throw new D1ImmutableJournalError("invalid-response");
			} catch (error) {
				if (
					!(error instanceof D1ImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
			}
			const observed = await log(),
				winner = observed.entries[proposed.epoch - 1];
			if (winner)
				return assignmentKey(winner) === assignmentKey(proposed)
					? "duplicate"
					: "conflict";
			// No entry at this epoch under a seal: the append can never apply.
			if (observed.seal) throw new D1ImmutableJournalError("generation-sealed");
			throw new D1ImmutableJournalError("write-outcome-unknown");
		},
		async readDocument(value) {
			if (!digest.test(value))
				throw new D1ImmutableJournalError("invalid-digest");
			await log();
			const rows = await query(
				`SELECT value FROM ${table} WHERE key=?1`,
				[`doc:${value}`],
				"read",
			);
			if (rows.length === 0) return undefined;
			const body = z.string().safeParse(rows[0]?.[0]);
			if (
				rows.length !== 1 ||
				!body.success ||
				Buffer.byteLength(body.data, "utf8") > maxDocumentBytes ||
				hash(body.data) !== value
			)
				throw new D1ImmutableJournalError("invalid-document");
			return body.data;
		},
		async writeDocument(value, body) {
			if (
				!digest.test(value) ||
				!z.string().safeParse(body).success ||
				Buffer.byteLength(body, "utf8") > maxDocumentBytes ||
				hash(body) !== value
			)
				throw new D1ImmutableJournalError("invalid-document");
			const existing = await replica.readDocument(value);
			if (existing === body) return;
			if (existing !== undefined)
				throw new D1ImmutableJournalError("immutable-conflict");
			if ((await log()).seal)
				throw new D1ImmutableJournalError("generation-sealed");
			try {
				await query(
					`INSERT INTO ${table} (key,value) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM ${table} WHERE key='log' AND json_type(value,'$.seal') IS NULL) ON CONFLICT(key) DO NOTHING RETURNING 1`,
					[`doc:${value}`, body],
					"write",
				);
			} catch (error) {
				if (
					!(error instanceof D1ImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
			}
			// The INSERT checks the native log seal in the same SQLite statement.
			// If a seal won while this request was delayed, the document was not
			// inserted and a caller must not mistake it for a completed write.
			if ((await replica.readDocument(value)) === body) return;
			if ((await log()).seal)
				throw new D1ImmutableJournalError("generation-sealed");
			throw new D1ImmutableJournalError("write-outcome-unknown");
		},
		async seal(original) {
			const input = Object.freeze({ ...original });
			if (
				!name.test(input.transitionId) ||
				!Number.isSafeInteger(input.epoch) ||
				input.epoch < 1 ||
				!digest.test(input.digest)
			)
				throw new D1ImmutableJournalError("invalid-seal");
			const current = await log();
			const matches = (value: ImmutableJournalSeal | undefined) =>
				!!value &&
				value.transitionId === input.transitionId &&
				value.epoch === input.epoch &&
				value.digest === input.digest;
			if (current.seal) return matches(current.seal) ? "duplicate" : "conflict";
			const head = current.entries.at(-1);
			if (
				head?.epoch !== input.epoch ||
				head.reason.split(":")[2] !== input.digest
			)
				return "conflict";
			const body = encode(current.entries, input);
			decode(body);
			try {
				const rows = await query(
					`UPDATE ${table} SET value=?1 WHERE key='log' AND value=?2 RETURNING 1`,
					[body, current.body],
					"write",
				);
				if (rows.length === 1 && rows[0]?.[0] === 1) return "sealed";
				if (rows.length !== 0)
					throw new D1ImmutableJournalError("invalid-response");
			} catch (error) {
				if (
					!(error instanceof D1ImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
			}
			const observed = await log();
			if (matches(observed.seal)) return "duplicate";
			if (observed.seal || observed.entries.length !== input.epoch)
				return "conflict";
			throw new D1ImmutableJournalError("write-outcome-unknown");
		},
	};
	replicaBindings.set(
		replica,
		Object.freeze({
			identity: Object.freeze({
				member,
				fleetId,
				anchorDigest,
				initializationId: token,
				accountId: options.accountId,
				databaseId: options.databaseId,
				table,
			}),
			resolveToken: options.resolveToken,
			fetchImpl: options.fetchImpl,
			authorize: options.authorize,
		}),
	);
	return Object.freeze({
		replica: Object.freeze(replica),
		async initializeFresh(verifyFresh) {
			if (!(verifyFresh instanceof Function))
				throw new D1ImmutableJournalError("freshness-unverified");
			try {
				await verifyFresh(member, token);
			} catch {
				throw new D1ImmutableJournalError("freshness-unverified");
			}
			try {
				await query(schema, [], "write");
			} catch (error) {
				if (
					!(error instanceof D1ImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
			}
			await verifySchema();
			try {
				await query(
					`INSERT INTO ${table} (key,value) VALUES ('log',?1) ON CONFLICT(key) DO NOTHING RETURNING 1`,
					[encode([])],
					"write",
				);
			} catch (error) {
				if (
					!(error instanceof D1ImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
			}
			await log();
		},
	});
}
