/**
 * An in-memory `MongoExecutor`.
 *
 * It exists so the whole binding — every port, the conformance kit, the
 * cross-engine runs — can be exercised with no server. It is faithful where
 * faithfulness is what a test would otherwise miss:
 *
 * - values come back the way a driver returns them, not the way they were
 *   sent: a Decimal128 prints in scientific notation when a server would, a
 *   double is re-printed, and text with an unpaired surrogate comes back as
 *   U+FFFD — so a binding that failed to refuse it is caught offline;
 * - `_id` order is BSON order (UTF-8 bytes, not UTF-16 code units);
 * - a `$jsonSchema` validator is enforced, and a keyword this executor does
 *   not implement is an error rather than a silent pass;
 * - a write that changes nothing emits no change event;
 * - a document of 16 MiB or more is refused with code 10334;
 * - a transaction commits all of its writes and events at once, or none, and
 *   its events carry one transaction identity;
 * - transactions interleave. Each reads the snapshot taken at its first
 *   statement, so it does not see a commit made after that; a write to a
 *   document another transaction changed is a write conflict that aborts and
 *   reruns the body; and a commit is never instant — it takes one turn of the
 *   event loop, during which the transaction is still open. That last point
 *   is what lets a race be lost offline: a writer that read "not fenced" is
 *   still in flight when a fence that does not wait returns.
 *
 * A single operation outside a transaction is atomic and immediate. The
 * executor does not model nesting limits, the oplog window, or transaction
 * size and lifetime limits. It is not a store anyone should keep data in.
 */
import { formatDecimal128 } from "./decimal.js";
import { MONGO_SERVER_CODES, MongoCommandError } from "./errors.js";
import type {
	MongoAwaitTransactionsRequest,
	MongoBulkWriteRequest,
	MongoBulkWriteResult,
	MongoChangeBatch,
	MongoChangeEvent,
	MongoEnsureCollectionRequest,
	MongoExecutor,
	MongoFindRequest,
	MongoFindResult,
	MongoIdSelector,
	MongoKeyMatch,
	MongoSession,
	MongoWriteOperation,
} from "./executor.js";
import {
	binaryOf,
	doubleText,
	type MongoBsonType,
	type MongoDocument,
	type MongoValue,
	mongoTypeOf,
	wrappedText,
} from "./extended-json.js";
import {
	freezeJson,
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";

const BAD_VALUE = 2;
const TOKEN_PATTERN = /^82[0-9A-F]{16}$/u;
/** The official driver refuses a document at this size; a server one byte later. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

function refuse(code: number, codeName: string): never {
	throw new MongoCommandError({ code, codeName });
}

// ── values as a server returns them ─────────────────────────────────────────

function storedText(text: string): string {
	// What UTF-8 encoding does to an unpaired surrogate: U+FFFD.
	return Buffer.from(text, "utf8").toString("utf8");
}

function storedWrapper(value: MongoDocument, type: MongoBsonType): MongoValue {
	if (type === "double") {
		const parsed = Number(wrappedText(value, "$numberDouble") ?? "NaN");
		return { $numberDouble: doubleText(parsed) };
	}
	if (type === "decimal") {
		const text = wrappedText(value, "$numberDecimal") ?? "";
		if (/^-?(NaN|Infinity)$/u.test(text)) return value;
		return {
			$numberDecimal: formatDecimal128(text) ?? refuse(BAD_VALUE, "BSONError"),
		};
	}
	if (type === "binData") {
		const binary = binaryOf(value) ?? refuse(BAD_VALUE, "BSONError");
		return {
			$binary: {
				base64: Buffer.from(binary.base64, "base64").toString("base64"),
				subType: binary.subType,
			},
		};
	}
	return value;
}

/** The value a driver would hand back after storing this one. */
function stored(value: MongoValue): MongoValue {
	if (value === null || isJsonBoolean(value)) return value;
	if (isJsonString(value)) return storedText(value);
	if (isJsonNumber(value)) {
		const type = mongoTypeOf(value);
		if (type === "int") return { $numberInt: String(value) };
		if (type === "long") return { $numberLong: BigInt(value).toString() };
		return { $numberDouble: doubleText(value) };
	}
	if (isJsonArray(value)) return value.map((item) => stored(item));
	const type = mongoTypeOf(value);
	if (type === "other") return refuse(BAD_VALUE, "BSONError");
	if (type !== "object") return storedWrapper(value, type);
	return Object.fromEntries(
		Object.keys(value).map((key) => {
			if (key.includes("\u0000")) refuse(BAD_VALUE, "BSONError");
			return [storedText(key), stored(value[key] ?? null)];
		}),
	);
}

/** Bytes a stored value occupies in BSON, without its element header. */
function bsonSize(value: MongoValue): number {
	if (value === null) return 0;
	if (isJsonBoolean(value)) return 1;
	if (isJsonString(value)) return 4 + Buffer.byteLength(value, "utf8") + 1;
	if (isJsonArray(value)) {
		return value.reduce<number>(
			(total, item, index) =>
				total + 1 + String(index).length + 1 + bsonSize(item),
			5,
		);
	}
	const type = mongoTypeOf(value);
	if (type === "int") return 4;
	if (type === "decimal") return 16;
	if (type === "minKey" || type === "maxKey") return 0;
	if (type === "binData") {
		const bytes = Buffer.from(binaryOf(value)?.base64 ?? "", "base64");
		return 4 + 1 + bytes.length;
	}
	if (type !== "object" || !isJsonObject(value)) return 8;
	return Object.keys(value).reduce(
		(total, key) =>
			total +
			1 +
			Buffer.byteLength(key, "utf8") +
			1 +
			bsonSize(value[key] ?? null),
		5,
	);
}

function storedDocument(document: MongoDocument): MongoDocument {
	const value = stored(document);
	if (!isJsonObject(value) || value._id === undefined) {
		return refuse(BAD_VALUE, "BadValue");
	}
	if (bsonSize(value) >= MAX_DOCUMENT_BYTES) {
		refuse(MONGO_SERVER_CODES.bsonObjectTooLarge, "BSONObjectTooLarge");
	}
	return freezeJson(value);
}

// ── BSON comparison order, for the types an `_id` can be ────────────────────

const TYPE_RANK: Readonly<Record<MongoBsonType, number>> = Object.freeze({
	minKey: 0,
	null: 1,
	int: 2,
	long: 2,
	double: 2,
	decimal: 2,
	string: 3,
	object: 4,
	array: 5,
	binData: 6,
	bool: 8,
	date: 9,
	other: 10,
	maxKey: 127,
});

function compareText(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function numberOf(value: MongoValue): number {
	if (isJsonNumber(value)) return value;
	if (!isJsonObject(value)) return Number.NaN;
	const inner = Object.values(value)[0];
	return isJsonString(inner) ? Number(inner) : Number.NaN;
}

function compareValues(left: MongoValue, right: MongoValue): number {
	const leftType = mongoTypeOf(left);
	const rightType = mongoTypeOf(right);
	const rank = TYPE_RANK[leftType] - TYPE_RANK[rightType];
	if (rank !== 0) return rank;
	if (isJsonString(left) && isJsonString(right)) {
		return compareText(left, right);
	}
	if (isJsonBoolean(left) && isJsonBoolean(right)) {
		return Number(left) - Number(right);
	}
	if (isJsonArray(left) && isJsonArray(right)) {
		for (let index = 0; index < left.length && index < right.length; index++) {
			const order = compareValues(left[index] ?? null, right[index] ?? null);
			if (order !== 0) return order;
		}
		return left.length - right.length;
	}
	if (leftType === "object" && isJsonObject(left) && isJsonObject(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		for (
			let index = 0;
			index < leftKeys.length && index < rightKeys.length;
			index++
		) {
			const leftKey = leftKeys[index] ?? "";
			const rightKey = rightKeys[index] ?? "";
			const leftValue = left[leftKey] ?? null;
			const rightValue = right[rightKey] ?? null;
			const order =
				TYPE_RANK[mongoTypeOf(leftValue)] -
					TYPE_RANK[mongoTypeOf(rightValue)] ||
				compareText(leftKey, rightKey) ||
				compareValues(leftValue, rightValue);
			if (order !== 0) return order;
		}
		return leftKeys.length - rightKeys.length;
	}
	if (TYPE_RANK[leftType] === TYPE_RANK.int || leftType === "date") {
		const leftNumber = leftType === "date" ? dateNumber(left) : numberOf(left);
		const rightNumber =
			rightType === "date" ? dateNumber(right) : numberOf(right);
		return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
	}
	return compareText(JSON.stringify(left), JSON.stringify(right));
}

function dateNumber(value: MongoValue): number {
	return isJsonObject(value) ? numberOf(value.$date ?? null) : Number.NaN;
}

/** Identity of an `_id`: field order is significant, as it is in BSON. */
function slotOf(id: MongoValue): string {
	return JSON.stringify(id);
}

// ── the `$jsonSchema` subset ────────────────────────────────────────────────

const RULE_KEYWORDS = new Set([
	"bsonType",
	"required",
	"properties",
	"additionalProperties",
	"pattern",
]);

function stringList(value: MongoValue | undefined): readonly string[] {
	if (isJsonString(value)) return [value];
	if (isJsonArray(value)) return value.filter((entry) => isJsonString(entry));
	return [];
}

function satisfies(value: MongoValue, rule: MongoValue): boolean {
	if (!isJsonObject(rule)) return refuse(BAD_VALUE, "FailedToParse");
	for (const keyword of Object.keys(rule)) {
		// Under-validating silently would make this executor more permissive
		// than a server; an unimplemented keyword is refused instead.
		if (!RULE_KEYWORDS.has(keyword)) refuse(BAD_VALUE, "FailedToParse");
	}
	const type = mongoTypeOf(value);
	const allowed = stringList(rule.bsonType);
	if (allowed.length > 0 && !allowed.includes(type)) return false;
	if (isJsonString(value) && isJsonString(rule.pattern)) {
		if (!new RegExp(rule.pattern, "u").test(value)) return false;
	}
	if (type !== "object" || !isJsonObject(value)) return true;
	if (stringList(rule.required).some((name) => value[name] === undefined)) {
		return false;
	}
	const properties = isJsonObject(rule.properties) ? rule.properties : {};
	return Object.keys(value).every((name) => {
		const property = properties[name];
		if (property === undefined) return rule.additionalProperties !== false;
		return satisfies(value[name] ?? null, property);
	});
}

function assertValid(
	document: MongoDocument,
	validator: MongoDocument | undefined,
): void {
	if (validator === undefined) return;
	const keywords = Object.keys(validator);
	if (keywords.length === 0) return;
	const rule = validator.$jsonSchema;
	if (keywords.length !== 1 || rule === undefined) {
		refuse(BAD_VALUE, "FailedToParse");
	}
	if (!satisfies(document, rule)) {
		refuse(
			MONGO_SERVER_CODES.documentValidationFailure,
			"DocumentValidationFailure",
		);
	}
}

// ── state ───────────────────────────────────────────────────────────────────

interface Collection {
	validator: MongoDocument | undefined;
	changeImages: boolean;
	/** Replaced, never mutated, by a commit: a snapshot is a reference to it. */
	documents: ReadonlyMap<string, MongoDocument>;
	/** The commit that last changed each slot. */
	readonly changedAt: Map<string, number>;
}

interface LoggedChange {
	readonly sequence: number;
	readonly collection: string;
	readonly operation: string;
	/** Absent for an event that is not about one document. */
	readonly id?: MongoValue;
	readonly document?: MongoDocument;
	readonly transaction?: string;
}

type PendingChange = Omit<LoggedChange, "sequence" | "transaction">;

/** One open multi-document transaction. */
interface OpenTransaction {
	/** The identity its change events carry. */
	readonly identity: string;
	/** Collections it has read or written. */
	readonly touched: Set<string>;
	/** Settles when it has committed or aborted. */
	readonly finished: Promise<void>;
	finish(): void;
	/** Set when a write lost a conflict: the body is rerun after `settled`. */
	conflict?: WriteConflict;
}

interface WriteConflict {
	readonly error: MongoCommandError;
	/** What to wait for before the rerun, when the winner is still open. */
	readonly settled?: Promise<void>;
}

/** An auto-committed write found its document held by an open transaction. */
class HeldByTransaction extends Error {
	readonly settled: Promise<void>;

	constructor(settled: Promise<void>) {
		super("the document is held by an open transaction");
		this.settled = settled;
	}
}

/**
 * Reads over staged writes, and the one step that makes them durable. Every
 * method is synchronous, so a unit used and committed in one step is atomic.
 */
interface UnitOfWork {
	find(request: MongoFindRequest): MongoFindResult;
	bulkWrite(request: MongoBulkWriteRequest): MongoBulkWriteResult;
	commit(): void;
}

/** Writes staged by one unit of work; `undefined` marks a deleted slot. */
type Overlay = Map<string, Map<string, MongoDocument | undefined>>;

interface WriteTally {
	inserted: number;
	replaced: number;
	deleted: number;
}

function tokenOf(sequence: number): string {
	return `82${sequence.toString(16).toUpperCase().padStart(16, "0")}`;
}

function sequenceOf(token: string): number {
	if (!TOKEN_PATTERN.test(token)) {
		return refuse(MONGO_SERVER_CODES.invalidResumeToken, "InvalidResumeToken");
	}
	return Number.parseInt(token.slice(2), 16);
}

function inRange(
	id: MongoValue,
	after: MongoValue | undefined,
	before: MongoValue | undefined,
): boolean {
	return (
		(after === undefined || compareValues(id, after) > 0) &&
		(before === undefined || compareValues(id, before) < 0)
	);
}

function valueAt(root: MongoValue, path: string): MongoValue | undefined {
	let current: MongoValue | undefined = root;
	for (const segment of path.split(".")) {
		if (!isJsonObject(current)) return undefined;
		current = current[segment];
	}
	return current;
}

/** An event with no document key — a drop, an invalidate — always matches. */
function keyMatches(
	id: MongoValue | undefined,
	where: MongoKeyMatch | undefined,
): boolean {
	if (where === undefined || id === undefined) return true;
	const found = valueAt({ _id: id }, where.path);
	return (
		found !== undefined && compareValues(found, stored(where.equals)) === 0
	);
}

/** One turn of the event loop: how long a commit takes here. */
function commitLatency(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

function openTransaction(identity: string): OpenTransaction {
	let finish = (): void => undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return { identity, touched: new Set(), finished, finish: () => finish() };
}

/**
 * The in-memory executor, with the one thing a client holding its own
 * connection can do that the port cannot ask for.
 */
export interface MemoryMongoExecutor extends MongoExecutor {
	/**
	 * Drop a collection behind the binding's back. The stream reports a `drop`
	 * and then an `invalidate`, neither about any one document, exactly as a
	 * server does.
	 */
	dropCollection(collection: string): Promise<void>;
}

export function createMemoryMongoExecutor(): MemoryMongoExecutor {
	const collections = new Map<string, Collection>();
	const log: LoggedChange[] = [];
	const open = new Set<OpenTransaction>();
	/** Which open transaction has a staged write to each slot. */
	const held = new Map<string, Map<string, OpenTransaction>>();
	let sequence = 0;
	let commits = 0;
	let transactions = 0;

	const collection = (name: string): Collection => {
		const existing = collections.get(name);
		if (existing !== undefined) return existing;
		// MongoDB creates a collection on first write, with default options.
		const created: Collection = {
			validator: undefined,
			changeImages: false,
			documents: new Map(),
			changedAt: new Map(),
		};
		collections.set(name, created);
		return created;
	};

	const append = (change: PendingChange, transaction?: string): void => {
		sequence += 1;
		log.push({
			...change,
			sequence,
			...(transaction === undefined ? undefined : { transaction }),
		});
	};

	/**
	 * A unit of work: reads see its own staged writes over a base. Inside a
	 * transaction the base is the snapshot taken at the first statement;
	 * outside one it is the committed state, and the unit lives for one
	 * synchronous step.
	 */
	const unit = (owner?: OpenTransaction): UnitOfWork => {
		const overlay: Overlay = new Map();
		const pending: PendingChange[] = [];
		let snapshot: Map<string, ReadonlyMap<string, MongoDocument>> | undefined;
		let snapshotCommit = 0;

		const base = (
			name: string,
		): ReadonlyMap<string, MongoDocument> | undefined => {
			if (owner === undefined) return collections.get(name)?.documents;
			if (snapshot === undefined) {
				snapshotCommit = commits;
				snapshot = new Map(
					[...collections].map(([key, value]) => [key, value.documents]),
				);
			}
			owner.touched.add(name);
			return snapshot.get(name);
		};

		const lookup = (name: string, slot: string): MongoDocument | undefined => {
			const committed = base(name)?.get(slot);
			const staged = overlay.get(name);
			return staged?.has(slot) ? staged.get(slot) : committed;
		};

		const view = (name: string): Map<string, MongoDocument> => {
			const merged = new Map(base(name) ?? []);
			for (const [slot, document] of overlay.get(name) ?? []) {
				if (document === undefined) merged.delete(slot);
				else merged.set(slot, document);
			}
			return merged;
		};

		/** Take the slot for this unit, or lose to whoever changed it first. */
		const claim = (name: string, slot: string): void => {
			const holder = held.get(name)?.get(slot);
			if (owner === undefined) {
				// A server makes this write wait for the transaction to end.
				if (holder !== undefined) throw new HeldByTransaction(holder.finished);
				return;
			}
			const changed = collections.get(name)?.changedAt.get(slot) ?? 0;
			if (
				(holder !== undefined && holder !== owner) ||
				changed > snapshotCommit
			) {
				const error = new MongoCommandError({
					code: MONGO_SERVER_CODES.writeConflict,
					codeName: "WriteConflict",
					labels: ["TransientTransactionError"],
				});
				owner.conflict =
					holder === undefined || holder === owner
						? { error }
						: { error, settled: holder.finished };
				throw error;
			}
			const slots = held.get(name) ?? new Map<string, OpenTransaction>();
			slots.set(slot, owner);
			held.set(name, slots);
		};

		const stage = (
			name: string,
			slot: string,
			document: MongoDocument | undefined,
		): void => {
			const staged = overlay.get(name) ?? new Map();
			staged.set(slot, document);
			overlay.set(name, staged);
		};

		const select = (
			name: string,
			selector: MongoIdSelector,
		): MongoDocument[] => {
			const matches =
				selector.kind === "ids"
					? selector.ids.flatMap((id) => {
							const found = lookup(name, slotOf(stored(id)));
							return found === undefined ? [] : [found];
						})
					: [...view(name).values()].filter((document) =>
							inRange(
								document._id ?? null,
								selector.after === undefined
									? undefined
									: stored(selector.after),
								selector.before === undefined
									? undefined
									: stored(selector.before),
							),
						);
			return matches.sort((left, right) =>
				compareValues(left._id ?? null, right._id ?? null),
			);
		};

		const remove = (name: string, document: MongoDocument): void => {
			const id = document._id ?? null;
			claim(name, slotOf(id));
			stage(name, slotOf(id), undefined);
			pending.push({ collection: name, operation: "delete", id });
		};

		const apply = (
			name: string,
			operation: MongoWriteOperation,
			result: WriteTally,
		): void => {
			if (operation.kind === "delete") {
				for (const found of select(name, {
					kind: "ids",
					ids: [operation.id],
				})) {
					remove(name, found);
					result.deleted += 1;
				}
				return;
			}
			if (operation.kind === "deleteRange") {
				for (const found of select(name, { ...operation, kind: "range" })) {
					remove(name, found);
					result.deleted += 1;
				}
				return;
			}
			const document = storedDocument(operation.document);
			const id = document._id ?? null;
			const slot = slotOf(id);
			const existing = lookup(name, slot);
			claim(name, slot);
			if (operation.kind === "insert" && existing !== undefined) {
				refuse(MONGO_SERVER_CODES.duplicateKey, "DuplicateKey");
			}
			assertValid(document, collection(name).validator);
			if (existing === undefined) {
				result.inserted += 1;
				stage(name, slot, document);
				pending.push({
					collection: name,
					operation: "insert",
					id,
					document,
				});
				return;
			}
			result.replaced += 1;
			// An identical replacement is a no-op: no oplog entry, no event.
			if (JSON.stringify(existing) === JSON.stringify(document)) return;
			stage(name, slot, document);
			pending.push({ collection: name, operation: "replace", id, document });
		};

		return {
			find(request) {
				const documents = select(request.collection, request.select);
				return {
					documents:
						request.limit === undefined
							? documents
							: documents.slice(0, request.limit),
				};
			},
			bulkWrite(request) {
				owner?.touched.add(request.collection);
				const result = { inserted: 0, replaced: 0, deleted: 0 };
				for (const operation of request.operations) {
					apply(request.collection, operation, result);
				}
				return result;
			},
			commit() {
				if (overlay.size === 0) return;
				commits += 1;
				for (const [name, staged] of overlay) {
					const target = collection(name);
					const next = new Map(target.documents);
					for (const [slot, document] of staged) {
						if (document === undefined) next.delete(slot);
						else next.set(slot, document);
						target.changedAt.set(slot, commits);
					}
					target.documents = next;
				}
				for (const change of pending) append(change, owner?.identity);
			},
		};
	};

	/**
	 * One auto-committed write, as a write outside a transaction is. It is
	 * applied and committed in one synchronous step, so nothing interleaves
	 * with it; it waits only for a transaction that holds one of its documents.
	 */
	const write = async (
		request: MongoBulkWriteRequest,
	): Promise<MongoBulkWriteResult> => {
		for (;;) {
			const work = unit();
			try {
				const result = work.bulkWrite(request);
				work.commit();
				return result;
			} catch (cause) {
				if (!(cause instanceof HeldByTransaction)) {
					// An ordered bulk write outside a transaction keeps the
					// operations that ran before the one that was refused.
					work.commit();
					throw cause;
				}
				await cause.settled;
			}
		}
	};

	const close = (transaction: OpenTransaction): void => {
		open.delete(transaction);
		for (const slots of held.values()) {
			for (const [slot, holder] of slots) {
				if (holder === transaction) slots.delete(slot);
			}
		}
		transaction.finish();
	};

	const transaction = async <T>(
		body: (session: MongoSession) => Promise<T>,
	): Promise<T> => {
		for (;;) {
			transactions += 1;
			const current = openTransaction(`memory:${transactions}`);
			open.add(current);
			const work = unit(current);
			const session: MongoSession = {
				find: async (request) => work.find(request),
				bulkWrite: async (request) => work.bulkWrite(request),
			};
			try {
				const result = await body(session);
				// A body that swallowed a write conflict still cannot commit.
				if (current.conflict !== undefined) throw current.conflict.error;
				await commitLatency();
				work.commit();
				return result;
			} catch (cause) {
				// Any other error aborts the transaction and is rethrown as is.
				if (cause !== current.conflict?.error) throw cause;
			} finally {
				close(current);
			}
			// A transient conflict reruns the body, as a driver would, once the
			// transaction it lost to is out of the way.
			await current.conflict?.settled;
		}
	};

	return {
		find: async (request) => unit().find(request),
		bulkWrite: write,
		async ensureCollection(request: MongoEnsureCollectionRequest) {
			const existing = collections.get(request.collection);
			const validator =
				request.validator === undefined
					? undefined
					: freezeJson(structuredClone(request.validator));
			if (existing === undefined) {
				collections.set(request.collection, {
					validator,
					changeImages: request.changeImages,
					documents: new Map(),
					changedAt: new Map(),
				});
				return { created: true };
			}
			if (validator !== undefined || request.changeImages) {
				existing.validator = validator;
				existing.changeImages = request.changeImages;
			}
			return { created: false };
		},
		transaction,
		async awaitTransactions(request: MongoAwaitTransactionsRequest) {
			await Promise.all(
				[...open]
					.filter((entry) => entry.touched.has(request.collection))
					.map((entry) => entry.finished),
			);
		},
		changeHead: async () => ({ token: tokenOf(sequence) }),
		async readChanges(request): Promise<MongoChangeBatch> {
			const after = sequenceOf(request.after);
			if (!Number.isInteger(request.limit) || request.limit < 1) {
				refuse(BAD_VALUE, "BadValue");
			}
			const matching = log.filter(
				(change) =>
					change.sequence > after &&
					change.collection === request.collection &&
					keyMatches(change.id, request.where),
			);
			const page = matching.slice(0, request.limit);
			const drained = matching.length <= request.limit;
			const last = page[page.length - 1];
			return {
				events: page.map(
					(change): MongoChangeEvent => ({
						token: tokenOf(change.sequence),
						operation: change.operation,
						...(change.id === undefined ? undefined : { id: change.id }),
						...(change.document === undefined
							? undefined
							: { document: change.document }),
						...(change.transaction === undefined
							? undefined
							: { transaction: change.transaction }),
					}),
				),
				token: tokenOf(
					drained ? Math.max(sequence, after) : (last?.sequence ?? after),
				),
				drained,
			};
		},
		async dropCollection(name: string) {
			if (!collections.delete(name)) return;
			append({ collection: name, operation: "drop" });
			append({ collection: name, operation: "invalidate" });
		},
		close: async () => undefined,
	};
}
