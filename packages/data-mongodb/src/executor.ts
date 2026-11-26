import type { MongoDocument, MongoValue } from "./extended-json.js";

// domain-view:
export interface MongoEnsureCollectionRequest {
	readonly collection: string;
	readonly validator?: MongoDocument;
	readonly changeImages: boolean;
}

// domain-view:
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

// domain-view:
export type MongoIdSelector = MongoIdSet | MongoIdRange;

// domain-view:
export interface MongoFindRequest {
	readonly collection: string;
	readonly select: MongoIdSelector;
	readonly limit?: number;
}

// domain-view:
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

// domain-view:
export type MongoWriteOperation =
	| MongoInsertOperation
	| MongoReplaceOperation
	| MongoDeleteOperation
	| MongoDeleteRangeOperation;

// domain-view:
export interface MongoBulkWriteRequest {
	readonly collection: string;
	readonly operations: readonly MongoWriteOperation[];
}

// domain-view:
export interface MongoBulkWriteResult {
	readonly inserted: number;
	readonly replaced: number;
	readonly deleted: number;
}

// domain-view:
export interface MongoChangeHeadRequest {
	readonly collection: string;
}

// domain-view: result record of MongoExecutor.changeHead; wire form is MongoChangeToken in data-models/data_mongodb.proto.
export interface MongoChangeToken {
	readonly token: string;
}

// domain-view:
export interface MongoKeyMatch {
	readonly path: string;
	readonly equals: MongoValue;
}

// domain-view:
export interface MongoChangeReadRequest {
	readonly collection: string;
	readonly after: string;
	readonly limit: number;
	readonly where?: MongoKeyMatch;
}

// domain-view:
export interface MongoChangeEvent {
	readonly token: string;
	readonly operation: string;
	readonly id?: MongoValue;
	readonly document?: MongoDocument;
	readonly transaction?: string;
}

// domain-view:
export interface MongoChangeBatch {
	readonly events: readonly MongoChangeEvent[];
	readonly token: string;
	readonly drained: boolean;
}

// domain-view:
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
