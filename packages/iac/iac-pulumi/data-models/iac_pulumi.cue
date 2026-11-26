// CUE constraints for every protobuf type in iac_pulumi.proto.

package data_models

#IacChangeOp: "create" | "update" | "delete"

#IacResourceSpec: {
	name:     string & !=""
	type:     string & !=""
	provider: string & !=""
	outputs:  [...string]
}

#IacProgramSpec: {
	api_version:    "hobo.iac-program/v1"
	kind:           "iac-program"
	provider:       "pulumi"
	deployment_id?: string & !=""
	stack:          string & !=""
	resources:      [#IacResourceSpec, ...#IacResourceSpec]
	stack_outputs?: {[string]: string}
}

#IacResourceChange: {
	op:        #IacChangeOp
	resource:  string & !=""
	stack_key: string & !=""
	reason:    string & !=""
}

#IacPreviewDiff: {
	kind:     "diff"
	provider: "pulumi"
	model:    "per-resource-stack"
	changes:  [...#IacResourceChange]
	dirty:    bool
}

#IacDriftResource: {
	name:      string & !=""
	stack_key: string & !=""
	reason:    string & !=""
}

#IacDriftReport: {
	kind:      "drift-report"
	provider:  "pulumi"
	model:     "per-resource-stack"
	drifted:   bool
	resources: [...#IacDriftResource]
}

#IacResourceOutput: {
	id:        string & !=""
	stack_key: string & !=""
	status:    "provisioned" | "destroyed"
	outputs:   {[string]: string}
}

#IacApplyOutputs: {
	kind:          "outputs"
	provider:      "pulumi"
	model:         "per-resource-stack"
	resources:     {[string]: #IacResourceOutput}
	stack_outputs: {[string]: string}
	bindings:      {[string]: string}
}

#IacStateBackendConfig: {
	kind:        "memory" | "local-file"
	lock_holder: string | null
}
