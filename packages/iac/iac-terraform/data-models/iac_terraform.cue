package hobo

// CUE constraints for the HCL-lane IaC adapter wire records. One constraint
// per protobuf message/enum in iac_terraform.proto.

#IacChangeOp: "IAC_CHANGE_OP_UNSPECIFIED" | "IAC_CHANGE_OP_CREATE" | "IAC_CHANGE_OP_UPDATE" | "IAC_CHANGE_OP_DELETE"

#IacResourceSpec: {
	name:     string & !=""
	type:     string & !=""
	provider: string
	outputs: [...string]
}

#IacProgramSpec: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "terraform" | "opentofu"
	deploymentId: string
	stack:        string
	resources: [...#IacResourceSpec] & !=[]
}

#IacChange: {
	op:           "create" | "update" | "delete"
	resource:     string & !=""
	workspaceKey: string & !=""
	reason:       string & !=""
}

#IacDiff: {
	kind:     "diff"
	provider: "terraform"
	model:    "per-resource-workspace"
	changes: [...#IacChange]
	dirty: bool
}

#IacDriftedResource: {
	name:         string & !=""
	workspaceKey: string & !=""
	reason:       string & !=""
}

#IacDriftReport: {
	kind:     "drift-report"
	provider: "terraform"
	model:    "per-resource-workspace"
	drifted:  bool
	resources: [...#IacDriftedResource]
}

#IacResourceOutputs: {
	id:           string & !=""
	workspaceKey: string & !=""
	status:       "provisioned" | "destroyed"
	outputs: {[string]: string}
}

#IacOutputs: {
	kind:     "outputs"
	provider: "terraform"
	model:    "per-resource-workspace"
	resources: {[string]: #IacResourceOutputs}
	stackOutputs: {[string]: string}
	bindings: {[string]: string}
}

#StateBackendConfig: {
	kind:       "memory" | "local"
	lockHolder: string | null
}

#PlanChangeSummary: {
	create: uint
	update: uint
	delete: uint
}
