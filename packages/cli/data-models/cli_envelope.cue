package cli

import "list"

#CanonicalVerb: "up" | "down" | "dev" | "new" | "login" | "claim" | "plan" | "verify" | "can-deploy" | "inspect" | "logs" | "doctor" | "codegen" | "build" | "collect" | "stub" | "drift" | "add" | "registry" | "import" | "generate" | "sandbox" | "test" | "attest" | "erase" | "derivative" | "runbook" | "ci"

#CliClients: {
	read_api: string
	runtime:  string
}

#CliContext: {
	cwd:          string
	project_dir?: string
	identity?:    string
	clients:      #CliClients
}

#CliEnvelope: {
	ok:          bool
	verb:        #CanonicalVerb
	status:      string
	code:        string & =~"^HOBO_[A-Z0-9_]+$"
	message:     string
	remediation: [...string]
	context:     #CliContext
	data?:       {...}

	if ok == false {
		message:     string & !=""
		remediation: list.MinItems[1]
	}
}

#ExitCode: 0 | 1 | 2
