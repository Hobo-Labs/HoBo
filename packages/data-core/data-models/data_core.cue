package data_models

// Invariants for the engine-neutral data contract (ADR-0177).
//
// These constrain the shape and the relationships the TypeScript parsers
// enforce at runtime, so a record a parser would refuse is refused here too.
// The relationships are the point: an engine with no capture port cannot
// claim a capture ordering, an upsert must carry a record and a delete must
// not, and a verdict with findings cannot also be ok.

import "list"

#Identifier: =~"^[a-z][a-z0-9_]{0,62}$"
#Sha256Ref:  =~"^sha256:[0-9a-f]{64}$"
#HexDigest:  =~"^[0-9a-f]{64}$"
#Instant:    =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"

// ── canonical model ────────────────────────────────────────────────────────

#CanonicalType: "bool" | "int64" | "float64" | "decimal" | "string" | "bytes" |
	"timestamp" | "date" | "uuid" | "json" | "encrypted"

// Key fields must order and compare exactly in every engine.
#CanonicalKeyType: "string" | "int64" | "uuid"

#DatasetField: {
	name:     #Identifier
	type:     #CanonicalType
	nullable: bool
}

#DatasetSchema: {
	contract:  "hobo.dataset-schema/v1"
	name:      #Identifier
	version:   int & >=1
	keyFields: [...#Identifier] & list.MinItems(1) & list.UniqueItems()
	fields:    [...#DatasetField] & list.MinItems(1)
	open:      bool
}

#ChangeOp: "upsert" | "delete"

#RecordMutation: {
	tenant: string
	key:    string & !=""
	op:     #ChangeOp
	record?: {...}
	// An upsert carries a record; a delete carries none.
	if op == "upsert" {
		record!: {...}
	}
	if op == "delete" {
		record?: _|_
	}
}

#ChangeEnvelope: {
	contract:      "hobo.change-envelope/v1"
	dataset:       #Identifier
	position:      string & !=""
	schemaVersion: int & >=1
	tenant:        string
	key:           string & !=""
	op:            #ChangeOp
	record?: {...}
	classification?: #DataClassification
	if op == "upsert" {
		record!: {...}
	}
	if op == "delete" {
		record?: _|_
	}
}

#DataClassification: "public" | "internal" | "pii" | "phi" | "pci" | "secret"

// ── digests ────────────────────────────────────────────────────────────────

#BucketDigest: {
	bucket: int & >=0 & <4096
	count:  int & >=0
	digest: #HexDigest
}

#DatasetDigest: {
	contract: "hobo.dataset-digest/v1"
	dataset:  #Identifier
	tenant:   string
	count:    int & >=0
	digest:   #HexDigest
	buckets:  [...#BucketDigest] & list.MinItems(1) & list.MaxItems(4096)
}

// ── type mapping ───────────────────────────────────────────────────────────

#MappingFidelity: "exact" | "widening" | "constrained" | "lossy"

#TypeMappingEdge: {
	canonical: #CanonicalType
	native:    string & !=""
	write:     #MappingFidelity
	read:      #MappingFidelity
	note:      string
}

#TypeMappingAnnex: {
	engine: string & !=""
	edges:  [...#TypeMappingEdge]
}

#MappingFinding: {
	code:      "MAPPING_UNSUPPORTED_TYPE" | "MAPPING_LOSSY" | "MAPPING_CONSTRAINED" | "MAPPING_WIDENING"
	field:     #Identifier
	canonical: #CanonicalType
	fidelity:  #MappingFidelity | "unsupported"
	waiverKey: string & !=""
	detail:    string
}

// ── engine declaration ─────────────────────────────────────────────────────

#SpiPort: "datasets" | "records" | "snapshot" | "capture" | "apply" | "verify" |
	"fence" | "retire" | "schema"

#NativeMigrationProfile: {
	profile: =~"^migration\\.[a-z0-9.-]+/v[0-9]+$"
	pattern: #MigrationPatternId
}

#EngineDeclaration: {
	contract:            "hobo.data-engine/v1"
	engine:              =~"^[a-z][a-z0-9-]{0,31}$"
	profile:             =~"^[a-z][a-z0-9.-]*/v[0-9]+$"
	paradigm:            "relational" | "document" | "key-value" | "reference"
	ports:               [...#SpiPort] & list.UniqueItems() & list.MinItems(2)
	captureOrdering:     "global" | "per-key" | "none"
	fenceEnforcement:    "store" | "entry-point" | "none"
	snapshotConsistency: "consistent" | "fuzzy" | "none"
	ddlTransactional:    bool
	nativeProfiles:      [...#NativeMigrationProfile]
	typeMapping:         #TypeMappingAnnex
	impedance:           [...string]

	// Every engine provides datasets and records. The length guard keeps the
	// definition itself evaluable before any instance is unified with it.
	if len(ports) > 0 && !list.Contains(ports, "datasets") {
		ports: _|_
	}
	if len(ports) > 0 && !list.Contains(ports, "records") {
		ports: _|_
	}
	// A capability is "none" exactly when its port is absent.
	if list.Contains(ports, "capture") {
		captureOrdering: "global" | "per-key"
	}
	if !list.Contains(ports, "capture") {
		captureOrdering: "none"
	}
	if list.Contains(ports, "fence") {
		fenceEnforcement: "store" | "entry-point"
	}
	if !list.Contains(ports, "fence") {
		fenceEnforcement: "none"
	}
	if list.Contains(ports, "snapshot") {
		snapshotConsistency: "consistent" | "fuzzy"
	}
	if !list.Contains(ports, "snapshot") {
		snapshotConsistency: "none"
	}
}

// ── custody and policy ─────────────────────────────────────────────────────

#CustodyRole: "source" | "target" | "event-log" | "staging-artifact" | "relay" |
	"capture-log" | "rollback-snapshot" | "retiring-source"

#CustodyProtection: "encryptedAtRest" | "encryptedInTransit" | "accessScoped" |
	"auditLogged" | "fieldLevelKeys"

#CustodyPoint: {
	id:          string & !=""
	role:        #CustodyRole
	region:      string & !=""
	protections: [...#CustodyProtection]
	retainUntil?: #Instant
}

#CustodyPath: {
	contract: "hobo.custody-path/v1"
	points:   [...#CustodyPoint]
}

#CustodyFinding: {
	code: "CUSTODY_PATH_INCOMPLETE" | "CUSTODY_REGION_UNMAPPED" | "CUSTODY_RESIDENCY_CONFLICT" |
		"CUSTODY_PROTECTION_DOWNGRADE" | "CUSTODY_RETENTION_UNBOUNDED" | "CUSTODY_RETENTION_EXPIRED"
	point:       string & !=""
	role:        #CustodyRole | "path"
	detail:      string
	remediation: string
}

#PolicyVerdict: {
	contract:       "hobo.data-migration-policy-verdict/v1"
	ok:             bool
	classification: #DataClassification
	findings:       [...#CustodyFinding]
	custodyDigest:  #Sha256Ref
	evaluatedAt:    #Instant
	// A verdict is ok exactly when it has no findings.
	ok: len(findings) == 0
}

// ── pattern catalog and selection ──────────────────────────────────────────

#MigrationPatternId: "in-place-evolve" | "rebuild-and-swap" | "offline-copy" |
	"snapshot-and-tail" | "log-pivot" | "stream-handoff"

#MigrationPhase: "plan" | "gate" | "prepare" | "seed" | "converge" | "verify" |
	"shift-reads" | "fence-and-flip" | "soak" | "finalize"

#RollbackPosture: "none" | "to-snapshot" | "lossless"
#WriteFreeze:     "none" | "bounded" | "window"

#MigrationPattern: {
	id:                            #MigrationPatternId
	summary:                       string & !=""
	authorities:                   [...("projected" | "authoritative" | "journal")] & list.MinItems(1)
	changes:                       [...("shape" | "placement" | "engine" | "paradigm")] & list.MinItems(1)
	phases:                        [...#MigrationPhase] & list.MinItems(1)
	sourcePorts:                   [...#SpiPort]
	targetPorts:                   [...#SpiPort]
	writeFreeze:                   #WriteFreeze
	rollbackBeforeFlip:            #RollbackPosture
	rollbackInSoak:                #RollbackPosture
	rollbackInSoakWithReverseTail: #RollbackPosture
	authorityAfter:                "unchanged" | "log"
	// A pattern that moves authority into the log cannot roll back after it.
	if authorityAfter == "log" {
		rollbackInSoak: "none"
	}
}

#SelectionReason: {
	code: "PATTERN_ILLEGAL_FOR_CELL" | "ENGINE_DECLARATION_MISSING" | "PORT_MISSING" |
		"MAPPING_UNVERIFIED" | "MAPPING_BLOCKED" | "EVIDENCE_MISSING" | "EVIDENCE_FAILED" |
		"EVIDENCE_STALE" | "POLICY_DENIED" | "FREEZE_UNESTIMATED" | "FREEZE_EXCEEDS_BUDGET" |
		"ROLLBACK_INSUFFICIENT"
	detail: string
}

#MigrationCandidate: {
	pattern:        #MigrationPatternId
	realization:    "native" | "hub"
	profile?:       string
	eligible:       bool
	reasons:        [...#SelectionReason]
	writeFreeze:    #WriteFreeze
	rollbackInSoak: #RollbackPosture
	reverseTail:    bool
	// A candidate is eligible exactly when nothing rejected it.
	eligible: len(reasons) == 0
}

#MigrationDecision: {
	contract:        "hobo.migration-decision/v1"
	authority:       "projected" | "authoritative" | "journal"
	change:          "shape" | "placement" | "engine" | "paradigm"
	selected?:       #MigrationCandidate & {eligible: true}
	candidates:      [...#MigrationCandidate]
	mappingFindings: [...#MappingFinding]
	catalogDigest:   #Sha256Ref
	digest:          #Sha256Ref
}

// ── aggregate and results ──────────────────────────────────────────────────

#MigrationState: {
	migrationId:     string & !=""
	status:          "new" | "running" | "held" | "completed" | "rolled-back" | "failed"
	pattern?:        #MigrationPatternId
	completedPhases: [...#MigrationPhase]
	cutOver:         bool
	heldAt?:         #MigrationPhase
	heldReason?:     string
}

#MigrationRunResult: {
	migrationId: string & !=""
	pattern:     #MigrationPatternId
	status:      "completed" | "held" | "rolled-back" | "failed"
	phase:       #MigrationPhase
	rollback:    #RollbackPosture
	reason?:     string
	impedance:   [...string]
}

#InPlaceEvolveResult: {
	contract:       "hobo.in-place-evolve/v1"
	migrationId:    string & !=""
	status:         "completed" | "contract-blocked" | "held" | "rolled-back" | "failed"
	dualWindowOpen: bool
	snapshotRef?:   string
	blockedReasons: [...string]
}

#EngineConformanceResult: {
	caseId: string & !=""
	status: "pass" | "fail" | "blocked" | "not-run"
	// Never record payload and never a credential.
	detail: string
}

#EngineConformanceReport: {
	suite:     "hobo.data-engine-conformance/v1"
	engine:    string & !=""
	outcome:   "pass" | "fail" | "unknown"
	results:   [...#EngineConformanceResult]
	skipped:   [...string]
	checkedAt: #Instant
}

// ── migration.* fact bodies ────────────────────────────────────────────────

#MigrationPlannedEventData: {
	migrationId:     string & !=""
	phases:          [...string] & list.MinItems(1)
	plannedAt:       #Instant
	pattern?:        #MigrationPatternId
	decisionDigest?: #Sha256Ref
	custodyDigest?:  #Sha256Ref
	source?:         string
	target?:         string
	dataset?:        #Identifier
}

#MigrationPhaseAppliedEventData: {
	migrationId: string & !=""
	phase:       #MigrationPhase | "expand" | "backfill" | "contract"
	appliedAt:   #Instant
	// Positions, counts, and digests — never a record.
	checkpoint?: {...}
}

#MigrationVerifiedEventData: {
	migrationId: string & !=""
	point:       string & !=""
	verifiedAt:  #Instant
	count?:      int & >=0
	digest?:     #HexDigest
}

#MigrationCutOverEventData: {
	migrationId:  string & !=""
	cutOverAt:    #Instant
	count?:       int & >=0
	digest?:      #HexDigest
	reverseTail?: bool
	authority?:   "log"
}

#MigrationRolledBackEventData: {
	migrationId:       string & !=""
	reason:            string & !=""
	rolledBackAt:      #Instant
	lossless?:         bool
	erasuresReplayed?: int & >=0
}

#MigrationHeldEventData: {
	migrationId: string & !=""
	// A migration may hold only in a safe-hold phase; the fence-and-flip step
	// completes or compensates.
	phase:  "plan" | "gate" | "prepare" | "seed" | "converge" | "verify" | "shift-reads" | "soak"
	reason: string & !=""
	heldAt: #Instant
}

#MigrationResumedEventData: {
	migrationId: string & !=""
	phase:       #MigrationPhase
	resumedAt:   #Instant
}

#MigrationCompletedEventData: {
	migrationId: string & !=""
	pattern:     #MigrationPatternId
	completedAt: #Instant
}

#MigrationFailedEventData: {
	migrationId: string & !=""
	// An error class name only: a thrown message can carry a connection string.
	reason:   string & !=""
	failedAt: #Instant
}
