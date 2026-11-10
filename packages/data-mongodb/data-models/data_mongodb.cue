package data_models

// Invariants for the MongoDB engine binding.
//
// These constrain the relationships the TypeScript parsers and the binding
// enforce at runtime, so a record `parseFindRequest` or
// `parseMongoEngineOptions` would refuse is refused here too.

// A dataset name: a portable identifier, which is also the collection name.
#MongoDatasetName: string & =~"^[a-z][a-z0-9_]{0,62}$"

// A collection the port may address: a dataset's, or the metadata collection.
#MongoCollectionName: #MongoDatasetName | (string & =~"^_[a-z0-9_]{1,62}$")

// A BSON value as canonical MongoDB Extended JSON v2.
#MongoExtendedJson: _

// A BSON document as canonical Extended JSON; every stored one has an `_id`.
#MongoStoredDocument: {
	_id: #MongoExtendedJson
	...
}

#MongoEngineSettings: {
	capture: bool
	// It starts with `_`, so it can never be a dataset's collection.
	metadataCollection: string & =~"^_[a-z0-9_]{1,62}$"
	scanPageSize:       int & >=1
}

// Codes, never messages: a server message can quote a key or a document.
#MongoCommandFailure: {
	code:     int & >=0
	codeName: string
	labels?: [...string]
}

#MongoEnsureCollectionRequest: {
	collection: #MongoCollectionName
	validator?: {...}
	changeImages: bool
}

#MongoEnsureCollectionResult: {
	created: bool
}

#MongoIdSelectorKind: "ids" | "range"

// A set of ids has no bounds, and a range has no id list.
#MongoIdSelector: {
	kind: "ids"
	ids: [...#MongoExtendedJson]
} | {
	kind:    "range"
	after?:  #MongoExtendedJson
	before?: #MongoExtendedJson
}

#MongoFindRequest: {
	collection: #MongoCollectionName
	select:     #MongoIdSelector
	limit?:     int & >=1
}

#MongoFindResult: {
	documents: [...#MongoStoredDocument]
}

#MongoWriteKind: "insert" | "replace" | "delete" | "deleteRange"

// Each kind carries exactly what it needs and nothing else.
#MongoWriteOperation: {
	kind:     "insert" | "replace"
	document: #MongoStoredDocument
} | {
	kind: "delete"
	id:   #MongoExtendedJson
} | {
	kind:    "deleteRange"
	after?:  #MongoExtendedJson
	before?: #MongoExtendedJson
}

#MongoBulkWriteRequest: {
	collection: #MongoCollectionName
	operations: [...#MongoWriteOperation]
}

#MongoBulkWriteResult: {
	inserted: int & >=0
	replaced: int & >=0
	deleted:  int & >=0
}

#MongoChangeHeadRequest: {
	collection: #MongoCollectionName
}

// Opaque, but never empty: an empty token would mean "from the beginning".
#MongoChangeToken: {
	token: string & !=""
}

#MongoKeyMatch: {
	path:   string & =~"^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$"
	equals: #MongoExtendedJson
}

#MongoChangeReadRequest: {
	collection: #MongoCollectionName
	after:      string & !=""
	limit:      int & >=1
	where?:     #MongoKeyMatch
}

// A delete carries no document; an insert, replace, or update carries one.
#MongoChangeEvent: {
	token:     string & !=""
	operation: string & !=""
	id?:       #MongoExtendedJson
	document?: #MongoStoredDocument
}

#MongoChangeBatch: {
	events: [...#MongoChangeEvent]
	token:   string & !=""
	drained: bool
}

#MongoAwaitTransactionsRequest: {
	collection: #MongoCollectionName
}

// The `_id` of a record's document: tenant, then canonical key.
#MongoRecordId: {
	t: string
	k: string & !=""
}

#MongoMetadataKind: "dataset" | "fence" | "watermark" | "subscription"

#MongoDatasetEntry: {
	_id:          string & =~"^dataset:[a-z][a-z0-9_]{0,62}$"
	kind:         "dataset"
	dataset:      #MongoDatasetName
	schema:       string & !=""
	schemaDigest: string & =~"^sha256:[0-9a-f]{64}$"
}

#MongoFenceEntry: {
	_id:     string & =~"^fence:[a-z][a-z0-9_]{0,62}:"
	kind:    "fence"
	dataset: #MongoDatasetName
	tenant:  string
	token:   string & !=""
	reason:  string
}

#MongoWatermarkEntry: {
	_id:      string & =~"^watermark:[a-z][a-z0-9_]{0,62}:"
	kind:     "watermark"
	dataset:  #MongoDatasetName
	source:   string & !=""
	position: string & !=""
}

#MongoSubscriptionEntry: {
	_id:          string & =~"^subscription:"
	kind:         "subscription"
	subscription: string & !=""
	dataset:      #MongoDatasetName
	tenant:       string
	start:        string & !=""
}
