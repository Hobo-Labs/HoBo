/** Upstash-owned, non-TTL journal voter over its private R2 bucket. */
import { createHash } from "node:crypto";
import {
	type AtomicJournalObject,
	AtomicObjectJournalError,
	createAtomicObjectJournalReplica,
	type ImmutableJournalMember,
	parseFleetAssignment,
	type SealableImmutableJournalReplica,
} from "@hobo/backend-fleet";
import type { HttpTransport } from "@hobo/core";
import { createR2ObjectClient } from "@hobo/r2-object";
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
	/** Maximum bytes of the combined assignments, documents and seal. */
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
	maxStateBytes: number;
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

/** R2 origin ETag CAS fences documents, assignments and the seal together.
 * A lost response is reconciled by exact readback. External custody, quota,
 * anti-rollback and failure-domain evidence remain the supervisor's responsibility. */
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
	// The old split format used this same key for its assignment log. Opening
	// that format as atomic state fails closed; no split-format object is replaced.
	const statePath = `${namespace}/assignments`;
	const object: AtomicJournalObject = {
		async read() {
			const result = await objects.get(statePath);
			return result ? { body: result.body, version: result.etag } : undefined;
		},
		async create(body) {
			const result = await objects.put(statePath, body, { kind: "absent" });
			return result.applied ? "created" : "conflict";
		},
		async replace(body, expectedVersion) {
			const result = await objects.put(statePath, body, {
				kind: "match",
				etag: expectedVersion,
			});
			return result.applied ? "written" : "conflict";
		},
	};
	async function invoke<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			if (error instanceof AtomicObjectJournalError)
				throw new UpstashBlobImmutableJournalError(error.reason);
			throw error;
		}
	}
	let atomic: ReturnType<typeof createAtomicObjectJournalReplica>;
	try {
		atomic = createAtomicObjectJournalReplica({
			member,
			members,
			fleetId,
			anchorDigest,
			initializationId,
			maxEntries,
			maxDocumentBytes,
			maxObjectBytes: maxLogBytes,
			object,
		});
	} catch (error) {
		if (error instanceof AtomicObjectJournalError)
			throw new UpstashBlobImmutableJournalError(error.reason);
		throw error;
	}
	const replica: SealableImmutableJournalReplica = {
		id: member.id,
		read: (limit) => invoke(() => atomic.replica.read(limit)),
		readDocument: (digest) => invoke(() => atomic.replica.readDocument(digest)),
		async writeDocument(digest, body) {
			if (!isJsonString(body))
				throw new UpstashBlobImmutableJournalError("invalid-document");
			return invoke(() => atomic.replica.writeDocument(digest, body));
		},
		async accept(input) {
			let parsed: ReturnType<typeof parseFleetAssignment>;
			try {
				parsed = parseFleetAssignment(input);
			} catch {
				throw new UpstashBlobImmutableJournalError("invalid-assignment");
			}
			return invoke(() => atomic.replica.accept(parsed));
		},
		seal: (input) => invoke(() => atomic.replica.seal(input)),
	};
	Object.freeze(replica);
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
				maxStateBytes: maxLogBytes,
				failureDomains: domains,
			}),
			transport,
			resolveToken,
			authorizeMint,
			authorizeObject,
		}),
	);
	return Object.freeze({
		replica,
		async initializeFresh(verifyFresh) {
			if (!(verifyFresh instanceof Function))
				throw new UpstashBlobImmutableJournalError("freshness-unverified");
			return invoke(() => atomic.initializeFresh(verifyFresh));
		},
	});
}
