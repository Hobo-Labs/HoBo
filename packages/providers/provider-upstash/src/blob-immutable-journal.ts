/** Upstash-owned, non-TTL journal voter over its private R2 bucket. */
import { createHash } from "node:crypto";
import {
	assignmentKey,
	type FleetAssignment,
	type ImmutableJournalMember,
	type ImmutableJournalSeal,
	parseFleetAssignment,
	type SealableImmutableJournalReplica,
} from "@hobo/backend-fleet";
import type { HttpTransport } from "@hobo/core";
import { createR2ObjectClient } from "@hobo/r2-object";
import { z } from "zod";
import {
	createUpstashBlobCredentials,
	upstashBlobFailureDomains,
} from "./blob-credentials.js";
import { assertUpstashBlobJournalTransport } from "./blob-journal-transport.js";
import { isJsonString } from "./json.js";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/u,
	NAME = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const ROOT = "0".repeat(64);
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
export type UpstashBlobJournalCharge = Readonly<{
	operation: "read" | "write";
	maxRequestBytes: number;
	maxResponseBytes: number;
	maxAdditionalLogicalBytes: number;
}>;
export type UpstashBlobJournalMintCharge = Readonly<{
	maxRequestBytes: number;
	maxResponseBytes: number;
}>;
export interface UpstashBlobImmutableJournalOptions {
	readonly member: ImmutableJournalMember;
	readonly fleetId: string;
	readonly members: readonly ImmutableJournalMember[];
	readonly anchorDigest: string;
	readonly initializationId: string;
	readonly upstashAccountId: string;
	readonly bucketId: string;
	readonly r2AccountId: string;
	readonly credentialRef: string;
	readonly namespace: string;
	readonly maxEntries: number;
	readonly maxLogBytes: number;
	readonly maxDocumentBytes: number;
	readonly maxObjectBytes: number;
	readonly resolveToken: () => Promise<string>;
	readonly transport: HttpTransport;
	readonly now: () => number;
	/** Admit each mint and return a reusable guard that revalidates its hold. */
	readonly authorizeMint: (
		charge: UpstashBlobJournalMintCharge,
	) => Promise<() => Promise<void>>;
	/** Each actual R2 request is independently admitted. */
	readonly authorizeObject: (
		charge: UpstashBlobJournalCharge,
	) => Promise<() => Promise<void>>;
}
export class UpstashBlobImmutableJournalError extends Error {
	constructor(readonly reason: string) {
		super(`Upstash Blob immutable journal ${reason}`);
		this.name = "UpstashBlobImmutableJournalError";
	}
}
export type UpstashBlobImmutableJournalIdentity = Readonly<{
	member: ImmutableJournalMember;
	fleetId: string;
	anchorDigest: string;
	initializationId: string;
	upstashAccountId: string;
	bucketId: string;
	r2AccountId: string;
	credentialRef: string;
	namespace: string;
	maxObjectBytes: number;
	failureDomains: readonly string[];
}>;
const bindings = new WeakMap<
	object,
	Readonly<{
		identity: UpstashBlobImmutableJournalIdentity;
		transport: HttpTransport;
		resolveToken: UpstashBlobImmutableJournalOptions["resolveToken"];
		authorizeMint: UpstashBlobImmutableJournalOptions["authorizeMint"];
		authorizeObject: UpstashBlobImmutableJournalOptions["authorizeObject"];
	}>
>();
export function upstashBlobImmutableJournalIdentity(
	replica: SealableImmutableJournalReplica,
): UpstashBlobImmutableJournalIdentity {
	const binding = bindings.get(replica);
	if (!binding)
		throw new UpstashBlobImmutableJournalError("replica-unverified");
	return binding.identity;
}
export function assertUpstashBlobImmutableJournalWiring(
	replica: SealableImmutableJournalReplica,
	input: {
		readonly transport: HttpTransport;
		readonly resolveToken: UpstashBlobImmutableJournalOptions["resolveToken"];
		readonly authorizeMint: UpstashBlobImmutableJournalOptions["authorizeMint"];
		readonly authorizeObject: UpstashBlobImmutableJournalOptions["authorizeObject"];
	},
): void {
	const binding = bindings.get(replica);
	if (
		!binding ||
		binding.transport !== input.transport ||
		binding.resolveToken !== input.resolveToken ||
		binding.authorizeMint !== input.authorizeMint ||
		binding.authorizeObject !== input.authorizeObject
	)
		throw new UpstashBlobImmutableJournalError("replica-wiring-mismatch");
	try {
		assertUpstashBlobJournalTransport(binding.transport, {
			r2AccountId: binding.identity.r2AccountId,
			bucketId: binding.identity.bucketId,
			namespace: binding.identity.namespace,
			maxObjectBytes: binding.identity.maxObjectBytes,
		});
	} catch {
		throw new UpstashBlobImmutableJournalError("transport-unverified");
	}
}

/** R2 origin ETag CAS serializes the complete assignment log and seal. Immutable
 * documents use create-only PUT; a lost response is reconciled by exact readback.
 * External custody, quota, anti-rollback and failure-domain evidence remain
 * the supervisor's responsibility. */
export function createUpstashBlobImmutableJournalReplica(
	options: UpstashBlobImmutableJournalOptions,
): Readonly<{
	replica: SealableImmutableJournalReplica;
	initializeFresh(
		verifyFresh: (
			member: ImmutableJournalMember,
			initializationId: string,
		) => Promise<void>,
	): Promise<void>;
}> {
	const member = Object.freeze({ ...options.member }),
		members = options.members.map((entry) => ({ ...entry }));
	const {
		fleetId,
		anchorDigest,
		initializationId,
		upstashAccountId,
		bucketId,
		r2AccountId,
		credentialRef,
		namespace,
		maxEntries,
		maxLogBytes,
		maxDocumentBytes,
		maxObjectBytes,
		resolveToken,
		transport,
		now,
		authorizeMint,
		authorizeObject,
	} = options;
	const anchor = JSON.stringify({
		contract: "hobo.immutable-journal-anchor/v1",
		fleetId,
		members,
	});
	const genesis = JSON.stringify({
		contract: "hobo.immutable-journal-command/v1",
		position: 0,
		previous: ROOT,
		operationId: "genesis",
		value: anchor,
	});
	const genesisDigest = hash(genesis);
	let domains: readonly string[];
	try {
		domains = Object.freeze([
			...upstashBlobFailureDomains(upstashAccountId, r2AccountId),
		]);
	} catch {
		throw new UpstashBlobImmutableJournalError("invalid-configuration");
	}
	if (
		!NAME.test(fleetId) ||
		!NAME.test(initializationId) ||
		!HASH.test(anchorDigest) ||
		hash(anchor) !== anchorDigest ||
		members.length < 3 ||
		members.length > 31 ||
		members.length % 2 === 0 ||
		new Set(members.map((entry) => entry.id)).size !== members.length ||
		members.some((entry) =>
			Object.values(entry).some(
				(value) => !isJsonString(value) || !NAME.test(value),
			),
		) ||
		JSON.stringify(members.find((entry) => entry.id === member.id)) !==
			JSON.stringify(member) ||
		member.provider !== "upstash" ||
		member.accountId !== upstashAccountId ||
		member.resourceId !== bucketId ||
		!/^[a-z][a-z0-9+.-]*:\/\/[^ @#]+$/u.test(credentialRef) ||
		!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(namespace) ||
		namespace.length > 700 ||
		!Number.isSafeInteger(maxEntries) ||
		maxEntries < 1 ||
		maxEntries > 10_000 ||
		!Number.isSafeInteger(maxLogBytes) ||
		maxLogBytes < 1024 ||
		maxLogBytes > 2_000_000 ||
		!Number.isSafeInteger(maxDocumentBytes) ||
		maxDocumentBytes < 1024 ||
		maxDocumentBytes > 2_000_000 ||
		!Number.isSafeInteger(maxObjectBytes) ||
		maxObjectBytes < Math.max(maxLogBytes, maxDocumentBytes) ||
		maxObjectBytes > 8 * 1024 * 1024 ||
		!(resolveToken instanceof Function) ||
		!(transport instanceof Function) ||
		!(now instanceof Function) ||
		!(authorizeMint instanceof Function) ||
		!(authorizeObject instanceof Function)
	)
		throw new UpstashBlobImmutableJournalError("invalid-configuration");
	async function guard(action: () => Promise<() => Promise<void>>) {
		let revalidate: () => Promise<void>;
		try {
			revalidate = await action();
			if (!(revalidate instanceof Function)) throw new Error("missing hold");
			await revalidate();
		} catch {
			throw new UpstashBlobImmutableJournalError("authorization-unavailable");
		}
		return revalidate;
	}
	const credentials = createUpstashBlobCredentials({
		upstashAccountId,
		bucketId,
		r2AccountId,
		resolveToken,
		transport,
		now,
		reserveMint: async () => {
			const revalidate = await guard(() =>
				authorizeMint({ maxRequestBytes: 32_768, maxResponseBytes: 49_152 }),
			);
			return { claim: revalidate, revalidate };
		},
	});
	const objects = createR2ObjectClient({
		accountId: r2AccountId,
		bucket: bucketId,
		now,
		maxObjectBytes,
		resolveCredentials: credentials.resolveCredentials,
		transport: async (request) => {
			const bytes =
				request.body === undefined
					? 0
					: Buffer.byteLength(request.body, "utf8");
			// Includes a conservative allowance for signed HTTP headers. A host
			// must independently bound TLS/network overhead and buffered overread.
			const revalidate = await guard(() =>
				authorizeObject({
					operation: request.method === "PUT" ? "write" : "read",
					maxRequestBytes: bytes + 32_768,
					maxResponseBytes: request.maxResponseBytes + 32_768,
					maxAdditionalLogicalBytes: bytes,
				}),
			);
			const response = await transport(request);
			await revalidate();
			return response;
		},
	});
	const envelope = z.strictObject({
		contract: z.literal("hobo.upstash-blob-journal/v1"),
		anchorDigest: z.literal(anchorDigest),
		fleetId: z.literal(fleetId),
		member: z.strictObject({
			id: z.literal(member.id),
			provider: z.literal(member.provider),
			accountId: z.literal(member.accountId),
			resourceId: z.literal(member.resourceId),
			incarnation: z.literal(member.incarnation),
		}),
		initializationId: z.literal(initializationId),
		entries: z.array(row).max(maxEntries + 1),
		seal: z
			.strictObject({
				transitionId: z.string().regex(NAME),
				epoch: z.number().int().positive().safe(),
				digest: z.string().regex(HASH),
			})
			.optional(),
	});
	const logPath = `${namespace}/assignments`,
		docPath = (digest: string) => `${namespace}/documents/${digest}`;
	function encode(
		entries: readonly FleetAssignment[],
		seal?: ImmutableJournalSeal,
	) {
		return JSON.stringify({
			contract: "hobo.upstash-blob-journal/v1",
			anchorDigest,
			fleetId,
			member,
			initializationId,
			entries,
			...(seal ? { seal } : undefined),
		});
	}
	function decode(body: string) {
		if (Buffer.byteLength(body, "utf8") > maxLogBytes)
			throw new UpstashBlobImmutableJournalError("invalid-log");
		let value: z.infer<typeof envelope>;
		try {
			value = envelope.parse(JSON.parse(body));
		} catch {
			throw new UpstashBlobImmutableJournalError("identity-unverified");
		}
		let previous = ROOT;
		const entries = value.entries.map((entry, index) => {
			let parsed: FleetAssignment;
			try {
				parsed = parseFleetAssignment({
					epoch: entry.epoch,
					active: entry.active,
					sealed: entry.sealed,
					target: entry.target,
					reason: entry.reason,
					lossWindowMs: entry.lossWindowMs,
					decidedAtMs: entry.decidedAtMs,
					decidedBy: entry.decidedBy,
				});
			} catch {
				throw new UpstashBlobImmutableJournalError("invalid-log");
			}
			const link = /^j:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(parsed.reason);
			if (
				parsed.epoch !== index + 1 ||
				parsed.active !== undefined ||
				parsed.target !== undefined ||
				parsed.sealed ||
				parsed.lossWindowMs !== undefined ||
				parsed.decidedAtMs !== 0 ||
				parsed.decidedBy !== "journal" ||
				!link ||
				link[1] !== previous ||
				(index === 0 && link[2] !== genesisDigest)
			)
				throw new UpstashBlobImmutableJournalError("invalid-log");
			previous = link[2] ?? "";
			return parsed;
		});
		if (
			value.seal &&
			(value.seal.epoch !== entries.length || value.seal.digest !== previous)
		)
			throw new UpstashBlobImmutableJournalError("invalid-seal");
		return { entries, ...(value.seal ? { seal: value.seal } : undefined) };
	}
	async function get(path: string, maxBytes: number) {
		let value: Awaited<ReturnType<typeof objects.get>>;
		try {
			value = await objects.get(path);
		} catch {
			throw new UpstashBlobImmutableJournalError("read-unavailable");
		}
		if (value && Buffer.byteLength(value.body, "utf8") > maxBytes)
			throw new UpstashBlobImmutableJournalError("invalid-response");
		return value;
	}
	async function put(path: string, body: string, etag?: string) {
		try {
			const result = await objects.put(
				path,
				body,
				etag === undefined ? { kind: "absent" } : { kind: "match", etag },
			);
			if (!result.applied) throw new Error("condition failed");
		} catch {
			throw new UpstashBlobImmutableJournalError("write-outcome-unknown");
		}
	}
	async function log() {
		const result = await get(logPath, maxLogBytes);
		if (!result)
			throw new UpstashBlobImmutableJournalError("identity-unverified");
		return { ...decode(result.body), etag: result.etag };
	}
	const replica: SealableImmutableJournalReplica = {
		id: member.id,
		async read(limit) {
			if (
				limit !== undefined &&
				(!Number.isSafeInteger(limit) || limit < 1 || limit > maxEntries + 1)
			)
				throw new UpstashBlobImmutableJournalError("invalid-limit");
			const { entries } = await log();
			return entries.slice(-(limit ?? entries.length));
		},
		async accept(input) {
			let proposed: FleetAssignment;
			try {
				proposed = parseFleetAssignment(input);
			} catch {
				throw new UpstashBlobImmutableJournalError("invalid-assignment");
			}
			const current = await log(),
				existing = current.entries[proposed.epoch - 1];
			if (existing)
				return assignmentKey(existing) === assignmentKey(proposed)
					? "duplicate"
					: "conflict";
			if (current.seal)
				throw new UpstashBlobImmutableJournalError("generation-sealed");
			if (proposed.epoch !== current.entries.length + 1) return "gap";
			const body = encode([...current.entries, proposed]);
			decode(body);
			if (Buffer.byteLength(body, "utf8") > maxLogBytes)
				throw new UpstashBlobImmutableJournalError("log-full");
			const link = /^j:[a-f0-9]{64}:([a-f0-9]{64})$/u.exec(proposed.reason);
			if (!link?.[1] || (await replica.readDocument(link[1])) === undefined)
				throw new UpstashBlobImmutableJournalError("document-unavailable");
			try {
				await put(logPath, body, current.etag);
				return "accepted";
			} catch (error) {
				if (
					!(error instanceof UpstashBlobImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
				const observed = await log(),
					winner = observed.entries[proposed.epoch - 1];
				if (winner)
					return assignmentKey(winner) === assignmentKey(proposed)
						? "duplicate"
						: "conflict";
				throw new UpstashBlobImmutableJournalError("write-outcome-unknown");
			}
		},
		async readDocument(digest) {
			if (!HASH.test(digest))
				throw new UpstashBlobImmutableJournalError("invalid-digest");
			await log();
			const result = await get(docPath(digest), maxDocumentBytes);
			if (!result) return undefined;
			if (hash(result.body) !== digest)
				throw new UpstashBlobImmutableJournalError("invalid-document");
			return result.body;
		},
		async writeDocument(digest, body) {
			if (
				!HASH.test(digest) ||
				!isJsonString(body) ||
				Buffer.byteLength(body, "utf8") > maxDocumentBytes ||
				hash(body) !== digest
			)
				throw new UpstashBlobImmutableJournalError("invalid-document");
			if ((await log()).seal)
				throw new UpstashBlobImmutableJournalError("generation-sealed");
			try {
				await put(docPath(digest), body);
			} catch (error) {
				if (
					!(error instanceof UpstashBlobImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
				const observed = await get(docPath(digest), maxDocumentBytes);
				if (!observed)
					throw new UpstashBlobImmutableJournalError("write-outcome-unknown");
				if (observed.body !== body)
					throw new UpstashBlobImmutableJournalError("immutable-conflict");
			}
		},
		async seal(raw) {
			const input = Object.freeze({ ...raw });
			if (
				!NAME.test(input.transitionId) ||
				!Number.isSafeInteger(input.epoch) ||
				input.epoch < 1 ||
				!HASH.test(input.digest)
			)
				throw new UpstashBlobImmutableJournalError("invalid-seal");
			const current = await log(),
				matches = (value: ImmutableJournalSeal | undefined) =>
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
				await put(logPath, body, current.etag);
				return "sealed";
			} catch (error) {
				if (
					!(error instanceof UpstashBlobImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
				const observed = await log();
				if (matches(observed.seal)) return "duplicate";
				if (observed.seal || observed.entries.length !== input.epoch)
					return "conflict";
				throw new UpstashBlobImmutableJournalError("write-outcome-unknown");
			}
		},
	};
	bindings.set(
		replica,
		Object.freeze({
			identity: Object.freeze({
				member,
				fleetId,
				anchorDigest,
				initializationId,
				upstashAccountId,
				bucketId,
				r2AccountId,
				credentialRef,
				namespace,
				maxObjectBytes,
				failureDomains: domains,
			}),
			transport,
			resolveToken,
			authorizeMint,
			authorizeObject,
		}),
	);
	return Object.freeze({
		replica: Object.freeze(replica),
		async initializeFresh(verifyFresh) {
			if (!(verifyFresh instanceof Function))
				throw new UpstashBlobImmutableJournalError("freshness-unverified");
			try {
				await verifyFresh(member, initializationId);
			} catch {
				throw new UpstashBlobImmutableJournalError("freshness-unverified");
			}
			try {
				await put(logPath, encode([]));
			} catch (error) {
				if (
					!(error instanceof UpstashBlobImmutableJournalError) ||
					error.reason !== "write-outcome-unknown"
				)
					throw error;
				await log();
			}
		},
	});
}
