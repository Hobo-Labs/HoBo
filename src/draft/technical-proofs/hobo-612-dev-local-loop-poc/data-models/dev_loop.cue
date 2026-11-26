// CUE constraints for hobo dev local loop (HOBO-612).

package dev_loop

#SchemaVersion: "hobo.dev-state/v1"

#FidelityLabel: "FIDELITY_LABEL_UNSPECIFIED" | "FIDELITY_LABEL_REAL" | "FIDELITY_LABEL_SIMULATED" | "FIDELITY_LABEL_MOCKED" | "FIDELITY_LABEL_CAMP_ONLY"

#FidelityLabelValue: "real" | "simulated" | "mocked" | "camp-only"

#DevSessionRecord: {
	session_id:            string & !=""
	port:                  int & >=1024 & <=65535
	local_url:             string & =~"^http://localhost:[0-9]+$"
	boot_ms:               int & >=0
	cold_boot_budget_ms:   int & >0 & <=60000
	cloud_account_required:  false
	runtime:               "runtime-local"
	fidelity_labels:       [string]: #FidelityLabelValue
}

#DevStateSnapshot: {
	schema_version:      #SchemaVersion
	run_count:           int & >=0
	handler_generation:  int & >=1
	last_reloaded:       string
	event_sequence:      int & >=0
}

#DevSessionStarted: {
	session_id: string & !=""
	port:       int & >=1024 & <=65535
	boot_ms:    int & >=0
}

#DevRequestServed: {
	path:      string & !=""
	status:    int & >=100 & <=599
	run_count: int & >=0
}

#DevHandlerReloaded: {
	path:               string & !=""
	handler_generation: int & >=1
}

#DevReloadFailed: {
	path:    string & !=""
	code:    string & =~"^HOBO_DEV_"
	message: string & !=""
}

#DevCodegenRan: {
	changed_sources: [...string]
	written_paths:   [...string]
}

#DevSessionStopped: {
	session_id: string & !=""
}

#DevEvent: {
	sequence: int & >0
	family:   "dev.SessionStarted" | "dev.RequestServed" | "dev.HandlerReloaded" | "dev.ReloadFailed" | "dev.CodegenRan" | "dev.SessionStopped"
}
