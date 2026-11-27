/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: this fixture implements the raw SQLite actor boundary. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DurableMessagingConformanceHarness } from "@hobo/conformance";
import { migrateDurableTopicJournal } from "@hobo/runtime/durable-topic-journal";
import type { RawAccess } from "rivetkit/db";
import { createRivetDurableTopicBusActor } from "../../src/durable-topic-actor.js";
import { createRivetDurableTopicMetadataGrant } from "../../src/durable-topic-client.js";
import type { RivetMessagingConformanceHost } from "./durable-topic-conformance.js";

function sqlite(
	path: string,
	onReceiptRead: () => void,
	beforeCommit: () => Promise<void>,
) {
	const sql = new DatabaseSync(path);
	let tail = Promise.resolve();
	const execute = async (query: string, ...args: SQLInputValue[]) => {
		const result = sql.prepare(query).all(...args);
		if (query.startsWith("SELECT CASE WHEN length(CAST(fingerprint AS BLOB))"))
			onReceiptRead();
		return result;
	};
	const transaction = async <T>(
		run: (tx: RawAccess) => Promise<T>,
	): Promise<T> => {
		const previous = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		sql.exec("BEGIN IMMEDIATE");
		try {
			// SAFETY: this fixture exposes the transaction's execute operation only.
			const result = await run({ execute } as RawAccess);
			await beforeCommit();
			sql.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				sql.exec("ROLLBACK");
			} catch {}
			throw error;
		} finally {
			release();
		}
	};
	// SAFETY: the actor uses only these database methods.
	return { sql, db: { execute, transaction } as RawAccess };
}

type Claim = {
	readonly actorName: string;
	readonly actorKey: readonly string[];
	readonly tenant: string;
	readonly instance: string;
	readonly semanticDigest: string;
	readonly method: string;
	readonly requestBase64: string;
};
export const signFixtureClaim = (claim: Claim, purpose: string) =>
	createHmac("sha256", "test-only-conformance-key")
		.update(
			JSON.stringify([
				purpose,
				claim.actorName,
				claim.actorKey,
				claim.tenant,
				claim.instance,
				claim.semanticDigest,
				claim.method,
				claim.requestBase64,
			]),
		)
		.digest("hex");
const matches = (actual: string | null, expected: string) =>
	actual !== null &&
	/^[a-f0-9]{64}$/u.test(actual) &&
	timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

export async function createSqliteBusConformanceHost(): Promise<RivetMessagingConformanceHost> {
	return createSqliteBusConformanceHostWithStorage({});
}

export async function createSqliteBusConformanceHostWithStorage(options: {
	readonly directory?: string;
	readonly clock?: number;
}): Promise<RivetMessagingConformanceHost> {
	const actorName = "hoboTopic";
	const semanticDigest = `sha256:${"b".repeat(64)}`;
	let clock = options.clock ?? 1_000;
	let receiptFault: "revocation" | "capacity" | "unavailable" | undefined;
	let denyReceiptDisclosure = false;
	const onReceiptRead = () => {
		const fault = receiptFault;
		receiptFault = undefined;
		if (fault === "revocation") denyReceiptDisclosure = true;
		else if (fault !== undefined) throw new Error(`receipt lookup ${fault}`);
	};
	let closed = false;
	let barrier:
		| { reached: () => void; wait: Promise<void>; release: () => void }
		| undefined;
	let failBeforeCommit = false;
	let commitBarrier:
		| { reached: () => void; wait: Promise<void>; release: () => void }
		| undefined;
	const beforeCommit = async () => {
		const held = commitBarrier;
		if (held !== undefined) {
			commitBarrier = undefined;
			held.reached();
			await held.wait;
		}
		if (failBeforeCommit) {
			failBeforeCommit = false;
			throw new Error("injected failure before commit");
		}
	};
	const outstanding: Array<() => void> = [];
	const stores = new Map<string, Promise<ReturnType<typeof sqlite>>>();
	const active = new Set<Promise<Response>>();
	const actor = createRivetDurableTopicBusActor({
		actorName,
		semanticDigest,
		now: () => clock,
		resolveScope: ({ actorKey }) => {
			if (
				actorKey.length !== 1 ||
				(actorKey[0] !== "tenant-a" && actorKey[0] !== "tenant-b")
			)
				throw new Error("invalid test actor key");
			return { tenant: actorKey[0], instance: "orders" };
		},
		authorize: (claim) => {
			if (denyReceiptDisclosure) {
				denyReceiptDisclosure = false;
				return false;
			}
			return matches(
				claim.headers.get("x-hobo-proof"),
				signFixtureClaim(claim, "request"),
			);
		},
		authorizeInstanceScope: (claim) =>
			matches(
				claim.headers.get("x-hobo-instance-proof"),
				signFixtureClaim(claim, "instance"),
			),
		verifyIngress: ({
			maxRequestBytes,
			maxChunkBytes,
			maxHeaderBytes,
			maxChunks,
		}) =>
			maxRequestBytes === 131_072 &&
			maxChunkBytes === 65_536 &&
			maxHeaderBytes === 16_384 &&
			maxChunks === 4096,
	});
	const unavailable = async (): Promise<never> => {
		throw new Error(
			"fixture has no independently controlled process or fault boundary",
		);
	};
	const controls: Omit<DurableMessagingConformanceHarness, "connect"> = {
		restart: unavailable,
		close: async () => {
			closed = true;
			for (const release of outstanding) release();
			await Promise.allSettled(active);
			for (const store of stores.values()) (await store).sql.close();
			stores.clear();
		},
		nowMs: () => clock,
		advanceMs: async (delta) => {
			clock += delta;
		},
		async loseNextMutationResponse(point) {
			if (point !== "before-commit" || failBeforeCommit) return unavailable();
			failBeforeCommit = true;
		},
		loseNextMutationTransport: unavailable,
		rejectNextDeadLetterWrite: unavailable,
		async blockNextReceiptLookup(reason) {
			if (receiptFault !== undefined || denyReceiptDisclosure)
				return unavailable();
			receiptFault = reason;
		},
		switchAuthority: unavailable,
		holdConcurrentMutations: unavailable,
		holdNextMutation: async (point) => {
			if (barrier !== undefined || commitBarrier !== undefined)
				return unavailable();
			let reached = () => {};
			const reachedPromise = new Promise<void>((resolve) => {
				reached = resolve;
			});
			let release = () => {};
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			if (point === "before-commit") commitBarrier = { reached, wait, release };
			else barrier = { reached, wait, release };
			outstanding.push(release);
			return { reached: reachedPromise, release: async () => release() };
		},
	};
	return {
		controls,
		async open(tenant) {
			if (closed) throw new Error("fixture is closed");
			if (tenant !== "tenant-a" && tenant !== "tenant-b")
				throw new Error("invalid fixture tenant");
			let store = stores.get(tenant);
			if (store === undefined) {
				store = (async () => {
					const created = sqlite(
						options.directory === undefined
							? ":memory:"
							: join(options.directory, `${tenant}.sqlite`),
						onReceiptRead,
						beforeCommit,
					);
					try {
						await migrateDurableTopicJournal(created.db);
						return created;
					} catch (error) {
						created.sql.close();
						throw error;
					}
				})();
				stores.set(tenant, store);
			}
			const captured = await store;
			if (closed) throw new Error("fixture closed while opening");
			const actorKey = [tenant];
			const dispatch = async (path: string, init: RequestInit) => {
				const held = barrier;
				if (held !== undefined && path !== "/events") {
					barrier = undefined;
					held.reached();
					await held.wait;
				}
				return actor.handle(
					{ name: actorName, key: actorKey, db: captured.db },
					new Request(`https://actor.test${path}`, init),
				);
			};
			const fetch = (path: string, init: RequestInit) => {
				if (closed) return Promise.reject(new Error("fixture is closed"));
				const pending = dispatch(path, init);
				active.add(pending);
				void pending.finally(() => active.delete(pending)).catch(() => {});
				return pending;
			};
			return {
				binding: {
					actorName,
					actorKey,
					tenant,
					instance: "orders",
					semanticDigest,
					limits: actor.limits,
					actorCapabilities: actor.capabilities,
				},
				metadataGrant: createRivetDurableTopicMetadataGrant(),
				verifyTransport: (claim) => claim.fetch === fetch,
				authorize: (claim) => ({
					"x-hobo-proof": signFixtureClaim(claim, "request"),
					"x-hobo-instance-proof": signFixtureClaim(claim, "instance"),
				}),
				revalidate: () => true,
				fetch,
			};
		},
	};
}
