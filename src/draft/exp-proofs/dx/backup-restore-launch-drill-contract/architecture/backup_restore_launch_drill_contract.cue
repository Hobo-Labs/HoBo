// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#BackupRestoreDrillEvidenceKind:
	"unspecified" |
	"design-record" |
	"drill-fixture" |
	"failure-route" |
	"readiness-guard"

#BackupRestoreDataSet: {
	id:              string & !=""
	owner:           string & !=""
	restore_target:  string & !=""
	source_evidence: string & !=""
}

#DrillEvidenceOutput: {
	format: "backup-restore.drill-evidence/v1"
	fields: [...string] & [_, _, _, _, _, _, _, _, _, ...]
}

#BackupRestorePath: {
	id:                 string & !=""
	context:            "saas" | "self-host" | "local-dev"
	owner:              string & !=""
	restore_target:     string & !=""
	rpo_minutes:        uint & >0
	rto_minutes:        uint & >0
	evidence_source:    string & !=""
	evidence_output:    #DrillEvidenceOutput
	rollback_path:      string & !=""
	unsupported_states: [...string] & [_, ...]
}

#FailureModeRouting: {
	id:                     string & !=""
	required_routing:       string & !=""
	rollback_or_escalation: string & !=""
}

#GapRoute: {
	id:    string & !=""
	owner: string & !=""
}

#ScopeGuard: {
	id:              string & !=""
	forbidden_work:  string & !=""
	owning_boundary: string & !=""
}

#BackupRestoreLaunchDrillRecord: {
	issue:         "HOBO-498"
	phase:         "M1"
	data_sets:     [...#BackupRestoreDataSet] & [_, _, _, _, _]
	restore_paths: [...#BackupRestorePath] & [_, _, _]
	failure_modes: [...#FailureModeRouting] & [_, _, _, _, _, _]
	gap_routes:    [...#GapRoute] & [_, _, _, _]
	scope_guards:  [...#ScopeGuard] & [_, _, _, _]
}
