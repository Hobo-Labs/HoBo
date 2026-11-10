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

// An instant a gate compares: RFC 3339 with a mandatory offset bounded to
// ±23:59. Without the offset the text is local time, and a retention deadline
// would mean a different instant on every host.
#OffsetInstant: =~#"^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?([Zz]|[+-]([01][0-9]|2[0-3]):?[0-5][0-9])$"#

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

#NativeProfileId: =~"^migration\\.[a-z0-9.-]+/v[0-9]+$"

#NativeTransferRef: {
	profile:  #NativeProfileId
	transfer: string & !=""
	dataset:  #Identifier
	tenant:   string
}

// The prepare checkpoint of a native realization. The ticket names server
// objects. It is journaled, so it never carries a connection string.
#NativeTransferCheckpoint: {
	realization: "native"
	profile:     #NativeProfileId
	transfer:    string & !=""
	ticket: {[string]: (string & !~"(?i)(postgres(ql)?|mongodb(\\+srv)?)://") | number | bool | null | [...] | {...}}
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
	// The engine's bound on one stored record, in bytes, when it states one.
	// Absent means no bound is stated — not that there is none.
	maxRecordBytes?: int & >=1

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

// `target-event-log` is the log a stream-handoff moves the journal into: a
// role of its own, so a path that names only the log being left does not
// cover the handoff.
#CustodyRole: "source" | "target" | "event-log" | "staging-artifact" | "relay" |
	"capture-log" | "rollback-snapshot" | "retiring-source" | "target-event-log"

#CustodyProtection: "encryptedAtRest" | "encryptedInTransit" | "accessScoped" |
	"auditLogged" | "fieldLevelKeys"

#CustodyPoint: {
	id:          string & !=""
	role:        #CustodyRole
	region:      string & !=""
	protections: [...#CustodyProtection]
	retainUntil?: #OffsetInstant
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
	// The roles the path named: what the verdict judged, and all it judged.
	roles:          [...#CustodyRole] & list.UniqueItems()
	custodyDigest:  #Sha256Ref
	evaluatedAt:    #OffsetInstant
	// A verdict is ok exactly when it has no findings.
	ok: len(findings) == 0
}

// What a router compares-and-sets on when asked to move write authority: the
// migration, and the journal head its decision was made at. A router keeps
// the highest head applied per migration and refuses a lower one. No token:
// the fence token that accompanies the call is a credential.
#AuthorityMoveRef: {
	migrationId: string & !=""
	head:        int & >=1
	direction?:  "to-target" | "to-source"
	fenceToken?: _|_
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
		"EVIDENCE_STALE" | "EVIDENCE_POSTDATED" | "POLICY_DENIED" | "CUSTODY_INCOMPLETE" |
		"FREEZE_UNESTIMATED" | "FREEZE_EXCEEDS_BUDGET" | "ROLLBACK_INSUFFICIENT"
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
	// A rollback was decided and journaled; until RolledBack follows, a
	// resumed run finishes handing authority back.
	rollbackDecided: bool
	heldAt?:         #MigrationPhase
	heldReason?:     string
	// How records travel, as the plan recorded it. A native realization
	// names its profile; the hub — or a plan that predates the field — has
	// none to name.
	*{realization?: "hub"} | {realization!: "native", profile!: #NativeProfileId}
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
	// declared-limit: the engine does not hold the property and its
	// declaration says so; the detail then begins with the impedance code.
	status: "pass" | "fail" | "blocked" | "not-run" | "declared-limit"
	// Never record payload and never a credential.
	detail: string
}

#EngineConformanceReport: {
	suite:     "hobo.data-engine-conformance/v1"
	engine:    string & !=""
	outcome:   "pass" | "fail" | "unknown"
	results:   [...#EngineConformanceResult]
	skipped:   [...string]
	// The case ids the run was restricted to; empty when the whole suite ran.
	only:      [...string]
	checkedAt: #Instant

	// A restricted run proves what it ran and nothing else: it never passes.
	if len(only) > 0 {
		outcome: "fail" | "unknown"
	}
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
	// A native realization names its profile; the hub — or a plan that
	// predates the field — has none to name.
	*{realization?: "hub"} | {realization!: "native", profile!: #NativeProfileId}
}

#MigrationPhaseAppliedEventData: {
	migrationId: string & !=""
	phase:       #MigrationPhase | "expand" | "backfill" | "contract"
	appliedAt:   #Instant
	// An in-place phase records what it ran; a phase of the uniform model
	// records a checkpoint instead.
	statements?: int & >=0
	changes?:    int & >=0
	// An in-place phase the plan's probe found already in effect.
	recovered?: bool
	// Positions, counts, and digests — never a record, and never a fence
	// token: a checkpoint names the fence it was taken under by digest.
	checkpoint?: {
		fenceToken?: _|_
		...
	}
}

// Written before an in-place phase runs its statements, as a
// compare-and-set on the journal head.
#MigrationPhaseIntendedEventData: {
	migrationId: string & !=""
	phase:       "expand" | "backfill" | "contract"
	statements:  int & >=0
	intendedAt:  #Instant
	retry?:      bool
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
	// A digest of the fence token, never the token: a fence token is a
	// write-authority credential and a journal is evidence.
	fenceTokenDigest?: #Sha256Ref
	fenceToken?:       _|_
	reversePosition?:  string & !=""
	logPosition?:      string & !=""
	// When the source's fence was first requested: where a rollback's erasure
	// replay is windowed from.
	fencedFrom?: #Instant
}

#MigrationRolledBackEventData: {
	migrationId:  string & !=""
	reason:       string & !=""
	rolledBackAt: #Instant
	// An in-place rollback restores a snapshot; a copy pattern goes back to
	// the old store and names none.
	snapshotRef?:      string & !=""
	lossless?:         bool
	erasuresReplayed?: int & >=0
}

#MigrationHeldEventData: {
	migrationId: string & !=""
	reason:      string & !=""
	heldAt:      #Instant
	// The hold followed a failed verification under a fence, and write
	// authority was given back.
	compensated?: bool
	// The in-place phase whose statements the port reported as failed.
	failedPhase?: "expand" | "backfill" | "contract"
	// A migration may hold only in a safe-hold phase; the fence-and-flip step
	// completes or compensates. The one other form is a hold *between* two
	// phases of a pattern with no soak window: the flip is complete, nothing
	// is half-done, and the fact says which phase was about to start.
	{
		phase: "plan" | "gate" | "prepare" | "seed" | "converge" | "verify" | "shift-reads" | "soak"
		// The phase the run was about to enter, for a hold between two phases.
		before?: #MigrationPhase
	} | {
		phase:   "fence-and-flip"
		before!: "finalize"
	}
}

// Written before a write fence is raised, as a compare-and-set on the
// journal head.
#MigrationFenceRequestedEventData: {
	migrationId: string & !=""
	side:        "source" | "target"
	phase:       #MigrationPhase
	requestedAt: #Instant
}

// Written before write authority is handed back, as a compare-and-set on the
// journal head. A journaled rollback is finished, never reconsidered.
#MigrationRollbackDecidedEventData: {
	migrationId: string & !=""
	lossless:    bool
	decidedAt:   #Instant
	// Where erasure replay is windowed from, for a rollback to a stale store.
	erasuresFrom?: #Instant
	// What both sides digested to, for a rollback under a reverse tail.
	count?:  int & >=0
	digest?: #HexDigest
	// Whether the target was fenced before authority went back. Only a
	// rollback to a stale source may go ahead without it.
	targetFenced?: bool
	if lossless {
		targetFenced?: true
	}
	// Finding codes of the negative verdict the rollback was asked for under.
	policyFindings?: [...string]
}

// Written after a write fence is raised: the digest of the token it answered.
#MigrationFenceRaisedEventData: {
	migrationId:      string & !=""
	side:             "source" | "target"
	phase:            #MigrationPhase
	fenceTokenDigest: #Sha256Ref
	fenceToken?:      _|_
	raisedAt:         #Instant
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
