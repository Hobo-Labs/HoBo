// CUE constraints for every protobuf type in migration.proto, so the
// architecture guard can confirm the live-migration shapes are bounded at
// parse time.

package trails

#CompatibilityInputsRecord: {
	current_version:           string & !=""
	target_version:            string & !=""
	deployment_mode:           "hosted-control-plane" | "self-host-yard" | "local-dev-runtime" | "sdk-package" | "data-shape"
	component_host_pin:        string & !=""
	manifest_version:          string & !=""
	contract_compatibility:    "supported" | "unsupported" | "needs-review"
	data_schema_posture:       "none" | "expand-only" | "expand-backfill" | "expand-backfill-contract"
	provider_state_dependency?: string
	backup_prerequisite:       "required-and-satisfied" | "required-but-missing" | "optional-local-snapshot-present" | "not-required"
	rollback_evidence_ref?:    string
	support_handoff_owner:     string & !=""
}

#RollbackEvidenceRecord: {
	state:                  "available" | "unavailable" | "required-before-execution" | "recoverable"
	immutable_set_ref?:     string
	snapshot_ref?:          string
	restore_prerequisite?:  string
	blocked_restore_reason?: string
	escalation_owner:       string & !=""
}

#MigrationPlanRecord: {
	migration_id: string & !=""
	expand: [...string & !=""]
	backfill: [...string & !=""]
	contract: [...string & !=""]
	verify_after_backfill: string & !=""
	verify_after_contract?: string
}

#CompatGateEvidenceRecord: {
	gate_id: string & !=""
	consumers_on_old_shape: [...string & !=""]
	verified_at: string & !=""
}

#MigrationPlannedEventData: {
	migration_id: string & !=""
	phases: [...string & !=""]
	planned_at: string & !=""
}

#MigrationSnapshotTakenEventData: {
	migration_id: string & !=""
	snapshot_ref: string & !=""
	taken_at:     string & !=""
}

#MigrationPhaseAppliedEventData: {
	migration_id: string & !=""
	phase:        "expand" | "backfill" | "contract"
	statements:   uint32
	changes?:     uint32
	applied_at:   string & !=""
}

#MigrationVerifiedEventData: {
	migration_id: string & !=""
	point:        "after-backfill" | "after-contract"
	verified_at:  string & !=""
}

#MigrationCutOverEventData: {
	migration_id: string & !=""
	cut_over_at:  string & !=""
}

#MigrationRolledBackEventData: {
	migration_id:   string & !=""
	reason:         string & !=""
	snapshot_ref:   string & !=""
	rolled_back_at: string & !=""
}

#MigrationFailedEventData: {
	migration_id: string & !=""
	reason:       string & !=""
	failed_at:    string & !=""
}

#MigrationExportedEventData: {
	tenant:       string & !=""
	export_id:    string & !=""
	head_seq:     uint32
	stream_count: uint32
	exported_at:  string & !=""
}

#MigrationImportedEventData: {
	tenant:            string & !=""
	export_id:         string & !=""
	imported_head_seq: uint32
	stream_count:      uint32
	imported_at:       string & !=""
}

// ── ADR-0177 additions ──────────────────────────────────────────────────────

#MigrationHeldEventData: {
	migrationId: string & !=""
	// A migration holds only in a safe-hold phase; the cutover step completes
	// or compensates.
	phase:  "plan" | "gate" | "prepare" | "seed" | "converge" | "verify" | "shift-reads" | "soak"
	reason: string & !=""
	heldAt: string & !=""
}

#MigrationResumedEventData: {
	migrationId: string & !=""
	phase:       string & !=""
	resumedAt:   string & !=""
}

#MigrationCompletedEventData: {
	migrationId: string & !=""
	pattern:     "in-place-evolve" | "rebuild-and-swap" | "offline-copy" | "snapshot-and-tail" | "log-pivot" | "stream-handoff"
	completedAt: string & !=""
}

#DataDualEvidenceRecord: {
	sourceCount:  int & >=0
	sourceDigest: =~"^[0-9a-f]{64}$"
	targetCount:  int & >=0
	targetDigest: =~"^[0-9a-f]{64}$"
	fidelity:     "live"
}

#CanTrailPolicyFindingRecord: {
	code:   string & !=""
	point:  string & !=""
	detail: string
}

#CanTrailPolicyVerdictRecord: {
	ok:            bool
	findings:      [...#CanTrailPolicyFindingRecord]
	custodyDigest: =~"^sha256:[0-9a-f]{64}$"
	// A verdict is ok exactly when it has no findings.
	ok: len(findings) == 0
}

