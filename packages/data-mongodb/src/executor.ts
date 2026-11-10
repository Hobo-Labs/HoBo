/**
 * The executor port — the one boundary that leaves this package.
 *
 * The binding never imports a driver. It asks an injected `MongoExecutor` for
 * a handful of operations, each a closed request record answered by a closed
 * result record, every value in canonical Extended JSON
 * (`./extended-json.ts`). An adapter over the official driver is about a
 * hundred lines (`test/support/driver-executor.ts` is the reference one); the
 * in-memory executor in `./memory-executor.ts` implements the same port with
 * no server.
 *
 * The port is deliberately narrower than MongoDB. Documents are addressed by
 * `_id` only — a point lookup, a set of ids, or a contiguous `_id` range — and
 * results are always in ascending `_id` order. That is all the SPI needs, it
 * is all served by the `_id` index, and it leaves no query language for an
 * in-memory implementation to get subtly wrong.
 *
 * An executor reports a refused command by throwing `MongoCommandError` with
 * the server's numeric code. It never puts a server message, a document, or a
 * connection string in an error.
 */
import type { MongoDocument, MongoValue } from "./extended-json.js";

// ── collections ─────────────────────────────────────────────────────────────

// domain-view: request record of MongoExecutor.ensureCollection; wire form is MongoEnsureCollectionRequest in data-models/data_mongodb.proto.
export interface MongoEnsureCollectionRequest {
	readonly collection: string;
	/** A `{ $jsonSchema: … }` validator, enforced strictly on every write. */
	readonly validator?: MongoDocument;
	/**
	 * Keep pre- and post-images (`changeStreamPreAndPostImages`), so a change
	 * stream can return the document as of each change even for an in-place
	 * update. Needs a replica set.
	 */
	readonly changeImages: boolean;
}

// domain-view: result record of MongoExecutor.ensureCollection; wire form is MongoEnsureCollectionResult in data-models/data_mongodb.proto.
export interface MongoEnsureCollectionResult {
	/** False when the collection already existed; its options were converged. */
	readonly created: boolean;
}

// ── reads ───────────────────────────────────────────────────────────────────

/** Exactly these `_id`s. */
export interface MongoIdSet {
	readonly kind: "ids";
	readonly ids: readonly MongoValue[];
}

/** Every `_id` strictly between two bounds; an absent bound is open. */
export interface MongoIdRange {
	readonly kind: "range";
	readonly after?: MongoValue;
	readonly before?: MongoValue;
}

// domain-view: closed union over the wire record MongoIdSelector in data-models/data_mongodb.proto.
export type MongoIdSelector = MongoIdSet | MongoIdRange;

// domain-view: request record of MongoSession.find; wire form is MongoFindRequest in data-models/data_mongodb.proto.
export interface MongoFindRequest {
	readonly collection: string;
	readonly select: MongoIdSelector;
	/** At most this many documents; absent returns every match. */
	readonly limit?: number;
}

// domain-view: result record of MongoSession.find; wire form is MongoFindResult in data-models/data_mongodb.proto.
export interface MongoFindResult {
	/** Ascending `_id` order (BSON comparison order). */
	readonly documents: readonly MongoDocument[];
}

// ── writes ──────────────────────────────────────────────────────────────────

/** Insert; a duplicate `_id` is refused with server code 11000. */
export interface MongoInsertOperation {
	readonly kind: "insert";
	readonly document: MongoDocument;
}

/** Replace the whole document with this `_id`, inserting it when absent. */
export interface MongoReplaceOperation {
	readonly kind: "replace";
	readonly document: MongoDocument;
}

export interface MongoDeleteOperation {
	readonly kind: "delete";
	readonly id: MongoValue;
}

/** Delete every document whose `_id` lies strictly between the bounds. */
export interface MongoDeleteRangeOperation {
	readonly kind: "deleteRange";
	readonly after?: MongoValue;
	readonly before?: MongoValue;
}

// domain-view: closed union over the wire record MongoWriteOperation in data-models/data_mongodb.proto.
export type MongoWriteOperation =
	| MongoInsertOperation
	| MongoReplaceOperation
	| MongoDeleteOperation
	| MongoDeleteRangeOperation;

// domain-view: request record of MongoSession.bulkWrite; wire form is MongoBulkWriteRequest in data-models/data_mongodb.proto.
export interface MongoBulkWriteRequest {
	readonly collection: string;
	/** Applied in order; the first refusal stops the batch. */
	readonly operations: readonly MongoWriteOperation[];
}

// domain-view: result record of MongoSession.bulkWrite; wire form is MongoBulkWriteResult in data-models/data_mongodb.proto.
export interface MongoBulkWriteResult {
	/** Documents that did not exist before: inserts and replace-upserts. */
	readonly inserted: number;
	/** Existing documents a replace matched, changed or not. */
	readonly replaced: number;
	readonly deleted: number;
}

// ── change streams ──────────────────────────────────────────────────────────

// domain-view: request record of MongoExecutor.changeHead; wire form is MongoChangeHeadRequest in data-models/data_mongodb.proto.
export interface MongoChangeHeadRequest {
	readonly collection: string;
}

// domain-view: result record of MongoExecutor.changeHead; wire form is MongoChangeToken in data-models/data_mongodb.proto.
export interface MongoChangeToken {
	/** A resume token as text: every later change sits strictly after it. */
	readonly token: string;
}

/** Keep only events whose document key holds `equals` at a dotted `path`. */
// domain-view: filter record of MongoChangeReadRequest; wire form is MongoKeyMatch in data-models/data_mongodb.proto.
export interface MongoKeyMatch {
	readonly path: string;
	readonly equals: MongoValue;
}

// domain-view: request record of MongoExecutor.readChanges; wire form is MongoChangeReadRequest in data-models/data_mongodb.proto.
export interface MongoChangeReadRequest {
	readonly collection: string;
	/** Return events strictly after this token. */
	readonly after: string;
	/** At most this many events; at least 1. */
	readonly limit: number;
	readonly where?: MongoKeyMatch;
}

// domain-view: one change-stream event; wire form is MongoChangeEvent in data-models/data_mongodb.proto.
export interface MongoChangeEvent {
	/** The event's own resume token. */
	readonly token: string;
	/** `insert`, `replace`, `update`, `delete`, or any other operation type. */
	readonly operation: string;
	/** `documentKey._id`; absent for events that are not about one document. */
	readonly id?: MongoValue;
	/** The whole document as of this change; absent for a delete. */
	readonly document?: MongoDocument;
}

// domain-view: result record of MongoExecutor.readChanges; wire form is MongoChangeBatch in data-models/data_mongodb.proto.
export interface MongoChangeBatch {
	/** In commit order. */
	readonly events: readonly MongoChangeEvent[];
	/** Resume point: every event at or before it, matching or not, was seen. */
	readonly token: string;
	/** True only when the stream had nothing further when the read ended. */
	readonly drained: boolean;
}

// ── transactions ────────────────────────────────────────────────────────────

// domain-view: request record of MongoExecutor.awaitTransactions; wire form is MongoAwaitTransactionsRequest in data-models/data_mongodb.proto.
export interface MongoAwaitTransactionsRequest {
	readonly collection: string;
}

/** The operations available inside a transaction, and outside one. */
export interface MongoSession {
	find(request: MongoFindRequest): Promise<MongoFindResult>;
	/** Ordered. Atomic only inside `transaction`. */
	bulkWrite(request: MongoBulkWriteRequest): Promise<MongoBulkWriteResult>;
}

export interface MongoExecutor extends MongoSession {
	/**
	 * Create the collection, or converge an existing one onto these options.
	 * Idempotent.
	 */
	ensureCollection(
		request: MongoEnsureCollectionRequest,
	): Promise<MongoEnsureCollectionResult>;
	/**
	 * Run `body` as one multi-document transaction: snapshot reads, all writes
	 * or none, majority-committed before it resolves. `body` may be invoked
	 * more than once (a transient conflict retries it), so it must not have
	 * effects outside the session it is given. An error thrown by `body` aborts
	 * the transaction and is rethrown unchanged.
	 */
	transaction<T>(body: (session: MongoSession) => Promise<T>): Promise<T>;
	/**
	 * Resolve once every transaction that had touched `collection` when the
	 * call was made has committed or aborted. The fence uses it to wait out a
	 * writer that read "not fenced" a moment before the fence was raised.
	 */
	awaitTransactions(request: MongoAwaitTransactionsRequest): Promise<void>;
	/** The stream's current resume point: nothing before it is ever returned. */
	changeHead(request: MongoChangeHeadRequest): Promise<MongoChangeToken>;
	/** Read forward from a token without consuming anything. */
	readChanges(request: MongoChangeReadRequest): Promise<MongoChangeBatch>;
	close(): Promise<void>;
}
