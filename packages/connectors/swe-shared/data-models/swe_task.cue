package swe_shared

// CUE constraints for the shared SWE-task session records (swe_task.proto).

#SweTask: {
	task_id:     string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#SweTaskReport: {
	schema:      "hobo.swe-task-report/v1"
	task_id:     string & !=""
	session_id:  string & !=""
	stop_reason: string & !=""
	edits:       [...string]
	refusals:    [...string]
	completed:   bool
}

#SandboxAccessReport: {
	schema:             "hobo.sandbox-access-report/v1"
	workspace_root:     string & !=""
	granted_actions:    [...string]
	out_of_scope_access: [...string]
	// clean holds exactly when no out-of-scope access was recorded.
	clean: bool
	if len(out_of_scope_access) > 0 {
		clean: false
	}
}

#SweTaskRunResult: {
	report:         #SweTaskReport
	sandbox_report: #SandboxAccessReport
	fact_kinds:     [...string]
}
