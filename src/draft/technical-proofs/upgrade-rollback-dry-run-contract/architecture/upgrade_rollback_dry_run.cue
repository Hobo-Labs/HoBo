// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#UpgradeDryRunStatus: "passed" | "blocked" | "failed"

#CompatibilityResult: "supported" | "unsupported"

#BackupRequirement: "required-and-satisfied" | "required-but-missing" | "optional-local-snapshot-present"

#MigrationPhase: "expand" | "backfill" | "contract"

#RollbackEvidenceState: "available" | "unavailable" | "required-before-execution" | "recoverable"

#UpgradeDryRunRequest: {
	id:                string & !=""
	source_version:    string & !=""
	target_version:    string & !=""
	deployment_mode:   "hosted-control-plane" | "self-host-yard" | "local-dev-runtime" | "sdk-package" | "data-shape"
	compatibility:     #CompatibilityInput
	backup:            #BackupEvidence
	migration_plan:    #MigrationPlan
	rollback_evidence: #RollbackEvidence
	release_notes:     #ReleaseNotesHandoff
	support_handoff:   #SupportHandoff
}

#CompatibilityInput: {
	matrix_ref:         string & !=""
	result:             #CompatibilityResult
	component_host_pin: string & !=""
	manifest_version:   string & !=""
}

#BackupEvidence: {
	requirement:  #BackupRequirement
	evidence_ref: string | null
}

#MigrationPlan: {
	steps:   [...#MigrationStep]
	failure?: #MigrationFailure
}

#MigrationStep: {
	phase:   #MigrationPhase
	summary: string & !=""
}

#MigrationFailure: {
	phase:  #MigrationPhase
	reason: string & !=""
}

#RollbackEvidence: {
	state:                #RollbackEvidenceState
	immutable_set_ref:    string | null
	snapshot_ref:         string | null
	restore_prerequisite?: string
	escalation_owner:     string & !=""
}

#ReleaseNotesHandoff: {
	required_inputs: [...string]
	known_limitation?: string
}

#SupportHandoff: {
	owner:       string & !=""
	handoff:     string & !=""
	next_action?: string
	escalation?: string
}

#UnsupportedPathReport: {
	reason:      string & !=""
	remediation: string & !=""
}

#UpgradeDryRunReport: {
	schema:            "hobo.upgrade-rollback-dry-run/v1"
	status:            #UpgradeDryRunStatus
	compatibility:     #CompatibilityInput
	backup:            #BackupEvidence
	migration_plan:    #MigrationPlan
	rollback_evidence: #RollbackEvidence
	release_notes:     #ReleaseNotesHandoff
	support_handoff:   #SupportHandoff
	unsupported_path?: #UnsupportedPathReport | null
	mutation_commands: []
	digest:            =~"^[a-f0-9]{64}$"
}
