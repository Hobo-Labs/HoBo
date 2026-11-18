import type { MongoDocument, MongoValue } from "./extended-json.js";

export interface MongoEnsureCollectionRequest {
	readonly collection: string;
	readonly validator?: MongoDocument;
	readonly changeImages: boolean;
}

export interface MongoEnsureCollectionResult {
	readonly created: boolean;
}

export interface MongoIdSet {
	readonly kind: "ids";
	readonly ids: readonly MongoValue[];
}

export interface MongoIdRange {
	readonly kind: "range";
	readonly after?: MongoValue;
	readonly before?: MongoValue;
}

export type MongoIdSelector = MongoIdSet | MongoIdRange;

export interface MongoFindRequest {
	readonly collection: string;
	readonly select: MongoIdSelector;
	readonly limit?: number;
}

export interface MongoFindResult {
	readonly documents: readonly MongoDocument[];
}

export interface MongoInsertOperation {
	readonly kind: "insert";
	readonly document: MongoDocument;
}

export interface MongoReplaceOperation {
	readonly kind: "replace";
	readonly document: MongoDocument;
}

export interface MongoDeleteOperation {
	readonly kind: "delete";
	readonly id: MongoValue;
}

export interface MongoDeleteRangeOperation {
	readonly kind: "deleteRange";
	readonly after?: MongoValue;
	readonly before?: MongoValue;
}

export type MongoWriteOperation =
	| MongoInsertOperation
	| MongoReplaceOperation
	| MongoDeleteOperation
	| MongoDeleteRangeOperation;

export interface MongoBulkWriteRequest {
	readonly collection: string;
	readonly operations: readonly MongoWriteOperation[];
}

export interface MongoBulkWriteResult {
	readonly inserted: number;
	readonly replaced: number;
	readonly deleted: number;
}

export interface MongoChangeHeadRequest {
	readonly collection: string;
}

export interface MongoChangeToken {
	readonly token: string;
}

export interface MongoKeyMatch {
	readonly path: string;
	readonly equals: MongoValue;
}

export interface MongoChangeReadRequest {
	readonly collection: string;
	readonly after: string;
	readonly limit: number;
	readonly where?: MongoKeyMatch;
}

export interface MongoChangeEvent {
	readonly token: string;
	readonly operation: string;
	readonly id?: MongoValue;
	readonly document?: MongoDocument;
	readonly transaction?: string;
}

export interface MongoChangeBatch {
	readonly events: readonly MongoChangeEvent[];
	readonly token: string;
	readonly drained: boolean;
}

export interface MongoAwaitTransactionsRequest {
	readonly collection: string;
}

export interface MongoSession {
	find(request: MongoFindRequest): Promise<MongoFindResult>;
	bulkWrite(request: MongoBulkWriteRequest): Promise<MongoBulkWriteResult>;
}

export interface MongoExecutor extends MongoSession {
	ensureCollection(
		request: MongoEnsureCollectionRequest,
	): Promise<MongoEnsureCollectionResult>;
	transaction<T>(body: (session: MongoSession) => Promise<T>): Promise<T>;
	awaitTransactions(request: MongoAwaitTransactionsRequest): Promise<void>;
	changeHead(request: MongoChangeHeadRequest): Promise<MongoChangeToken>;
	readChanges(request: MongoChangeReadRequest): Promise<MongoChangeBatch>;
	close(): Promise<void>;
}
