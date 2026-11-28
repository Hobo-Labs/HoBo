import type { MongoDocument, MongoValue } from "./extended-json.js";

// domain-view: request record of MongoExecutor.ensureCollection; wire form is MongoEnsureCollectionRequest in data-models/data_mongodb.proto.
export interface MongoEnsureCollectionRequest {
	readonly collection: string;
	readonly validator?: MongoDocument;
	readonly changeImages: boolean;
}

// domain-view: result record of MongoExecutor.ensureCollection; wire form is MongoEnsureCollectionResult in data-models/data_mongodb.proto.
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

// domain-view: closed union over the wire record MongoIdSelector in data-models/data_mongodb.proto.
export type MongoIdSelector = MongoIdSet | MongoIdRange;

// domain-view: request record of MongoSession.find; wire form is MongoFindRequest in data-models/data_mongodb.proto.
export interface MongoFindRequest {
	readonly collection: string;
	readonly select: MongoIdSelector;
	readonly limit?: number;
}

// domain-view: result record of MongoSession.find; wire form is MongoFindResult in data-models/data_mongodb.proto.
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

// domain-view: closed union over the wire record MongoWriteOperation in data-models/data_mongodb.proto.
export type MongoWriteOperation =
	| MongoInsertOperation
	| MongoReplaceOperation
	| MongoDeleteOperation
	| MongoDeleteRangeOperation;

// domain-view: request record of MongoSession.bulkWrite; wire form is MongoBulkWriteRequest in data-models/data_mongodb.proto.
export interface MongoBulkWriteRequest {
	readonly collection: string;
	readonly operations: readonly MongoWriteOperation[];
}

// domain-view: result record of MongoSession.bulkWrite; wire form is MongoBulkWriteResult in data-models/data_mongodb.proto.
export interface MongoBulkWriteResult {
	readonly inserted: number;
	readonly replaced: number;
	readonly deleted: number;
}

// domain-view: request record of MongoExecutor.changeHead; wire form is MongoChangeHeadRequest in data-models/data_mongodb.proto.
export interface MongoChangeHeadRequest {
	readonly collection: string;
}

// domain-view: result record of MongoExecutor.changeHead; wire form is MongoChangeToken in data-models/data_mongodb.proto.
export interface MongoChangeToken {
	readonly token: string;
}

// domain-view: filter record of MongoChangeReadRequest; wire form is MongoKeyMatch in data-models/data_mongodb.proto.
export interface MongoKeyMatch {
	readonly path: string;
	readonly equals: MongoValue;
}

// domain-view: request record of MongoExecutor.readChanges; wire form is MongoChangeReadRequest in data-models/data_mongodb.proto.
export interface MongoChangeReadRequest {
	readonly collection: string;
	readonly after: string;
	readonly limit: number;
	readonly where?: MongoKeyMatch;
}

// domain-view: one change-stream event; wire form is MongoChangeEvent in data-models/data_mongodb.proto.
export interface MongoChangeEvent {
	readonly token: string;
	readonly operation: string;
	readonly id?: MongoValue;
	readonly document?: MongoDocument;
	readonly transaction?: string;
}

// domain-view: result record of MongoExecutor.readChanges; wire form is MongoChangeBatch in data-models/data_mongodb.proto.
export interface MongoChangeBatch {
	readonly events: readonly MongoChangeEvent[];
	readonly token: string;
	readonly drained: boolean;
}

// domain-view: request record of MongoExecutor.awaitTransactions; wire form is MongoAwaitTransactionsRequest in data-models/data_mongodb.proto.
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
