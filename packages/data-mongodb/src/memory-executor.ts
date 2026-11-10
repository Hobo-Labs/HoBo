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
 * - a transaction commits all of its writes and events at once, or none.
 *
 * It is stricter than a server in one way: every operation runs under one
 * queue, so nothing interleaves. It does not model the 16 MiB document limit,
 * nesting limits, the oplog window, or transaction size and lifetime limits.
 * It is not a store anyone should keep data in.
 */
import { formatDecimal128 } from "./decimal.js";
import { MONGO_SERVER_CODES, MongoCommandError } from "./errors.js";
import type {
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

function storedDocument(document: MongoDocument): MongoDocument {
	const value = stored(document);
	if (!isJsonObject(value) || value._id === undefined) {
		return refuse(BAD_VALUE, "BadValue");
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
	readonly documents: Map<string, MongoDocument>;
}

interface LoggedChange {
	readonly sequence: number;
	readonly collection: string;
	readonly operation: string;
	readonly id: MongoValue;
	readonly document?: MongoDocument;
}

type PendingChange = Omit<LoggedChange, "sequence">;

/** Reads over staged writes, and the one step that makes them durable. */
interface UnitOfWork {
	readonly session: MongoSession;
	commit(): void;
}

/** Writes staged by one transaction; `undefined` marks a deleted slot. */
type Overlay = Map<string, Map<string, MongoDocument | undefined>>;

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

function keyMatches(id: MongoValue, where: MongoKeyMatch | undefined): boolean {
	if (where === undefined) return true;
	const found = valueAt({ _id: id }, where.path);
	return (
		found !== undefined && compareValues(found, stored(where.equals)) === 0
	);
}

export function createMemoryMongoExecutor(): MongoExecutor {
	const collections = new Map<string, Collection>();
	const log: LoggedChange[] = [];
	let sequence = 0;
	let queue: Promise<void> = Promise.resolve();

	/** Run one unit of work after everything queued before it. */
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const result = queue.then(work);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const collection = (name: string): Collection => {
		const existing = collections.get(name);
		if (existing !== undefined) return existing;
		// MongoDB creates a collection on first write, with default options.
		const created: Collection = {
			validator: undefined,
			changeImages: false,
			documents: new Map(),
		};
		collections.set(name, created);
		return created;
	};

	/** A unit of work: reads see its own staged writes over committed state. */
	const unit = (): UnitOfWork => {
		const overlay: Overlay = new Map();
		const pending: PendingChange[] = [];

		const view = (name: string): Map<string, MongoDocument> => {
			const merged = new Map(collections.get(name)?.documents ?? []);
			for (const [slot, document] of overlay.get(name) ?? []) {
				if (document === undefined) merged.delete(slot);
				else merged.set(slot, document);
			}
			return merged;
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
			const documents = view(name);
			const matches =
				selector.kind === "ids"
					? selector.ids.flatMap((id) => {
							const found = documents.get(slotOf(stored(id)));
							return found === undefined ? [] : [found];
						})
					: [...documents.values()].filter((document) =>
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
			stage(name, slotOf(id), undefined);
			pending.push({ collection: name, operation: "delete", id });
		};

		const apply = (
			name: string,
			operation: MongoWriteOperation,
			result: { inserted: number; replaced: number; deleted: number },
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
			const existing = view(name).get(slot);
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
			session: {
				async find(request: MongoFindRequest): Promise<MongoFindResult> {
					const documents = select(request.collection, request.select);
					return {
						documents:
							request.limit === undefined
								? documents
								: documents.slice(0, request.limit),
					};
				},
				async bulkWrite(
					request: MongoBulkWriteRequest,
				): Promise<MongoBulkWriteResult> {
					const result = { inserted: 0, replaced: 0, deleted: 0 };
					for (const operation of request.operations) {
						apply(request.collection, operation, result);
					}
					return result;
				},
			},
			commit() {
				for (const [name, staged] of overlay) {
					const target = collection(name).documents;
					for (const [slot, document] of staged) {
						if (document === undefined) target.delete(slot);
						else target.set(slot, document);
					}
				}
				for (const change of pending) {
					sequence += 1;
					log.push({ ...change, sequence });
				}
			},
		};
	};

	/** One auto-committed operation, as a write outside a transaction is. */
	const single = <T>(work: (session: MongoSession) => Promise<T>): Promise<T> =>
		serial(async () => {
			const { session, commit } = unit();
			try {
				return await work(session);
			} finally {
				// An ordered bulk write outside a transaction keeps the
				// operations that ran before the one that was refused.
				commit();
			}
		});

	return {
		find: (request) => single((session) => session.find(request)),
		bulkWrite: (request) => single((session) => session.bulkWrite(request)),
		ensureCollection: (request: MongoEnsureCollectionRequest) =>
			serial(async () => {
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
					});
					return { created: true };
				}
				if (validator !== undefined || request.changeImages) {
					existing.validator = validator;
					existing.changeImages = request.changeImages;
				}
				return { created: false };
			}),
		transaction: (body) =>
			serial(async () => {
				const { session, commit } = unit();
				const result = await body(session);
				commit();
				return result;
			}),
		awaitTransactions: () => serial(async () => undefined),
		changeHead: () => serial(async () => ({ token: tokenOf(sequence) })),
		readChanges: (request) =>
			serial(async (): Promise<MongoChangeBatch> => {
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
							id: change.id,
							...(change.document === undefined
								? undefined
								: { document: change.document }),
						}),
					),
					token: tokenOf(
						drained ? Math.max(sequence, after) : (last?.sequence ?? after),
					),
					drained,
				};
			}),
		close: async () => undefined,
	};
}
