package hobo

// CUE constraints for the Kubernetes-substrate IaC adapter wire records. One
// constraint per protobuf message/enum in iac_crossplane.proto.

#IacChangeOp: "IAC_CHANGE_OP_UNSPECIFIED" | "IAC_CHANGE_OP_CREATE" | "IAC_CHANGE_OP_UPDATE" | "IAC_CHANGE_OP_DELETE"

#CompositionSelector: {
	matchLabels: {[string]: string}
}

#IacResourceSpec: {
	name:                string & !=""
	type:                string & !=""
	provider:            string
	compositionSelector: #CompositionSelector
	outputs: [...string]
}

#IacProgramSpec: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "crossplane"
	deploymentId: string
	stack:        string
	resources: [...#IacResourceSpec] & !=[]
}

#CompositeResourceClaimSpec: {
	apiVersion:     "hobo.iac-crossplane/v1"
	kind:           "CompositeResourceClaim"
	compositionRef: string & !=""
	resourceType:   string & !=""
}

#ClaimStatus: {
	phase: "Ready" | "Pending"
	outputs: {[string]: string}
}

#CompositeResourceClaimRecord: {
	id:       string & !=""
	name:     string & !=""
	spec:     #CompositeResourceClaimSpec
	specHash: string & !=""
	status:   #ClaimStatus
	appliedOutputs?: {[string]: string}
}

#IacChange: {
	op:       "create" | "update" | "delete"
	resource: string & !=""
	reason:   string & !=""
}

#IacDiff: {
	kind:     "diff"
	provider: "crossplane"
	model:    "composite-resource-claim"
	changes: [...#IacChange]
	dirty: bool
}

#IacDriftedResource: {
	name:    string & !=""
	reason:  string & !=""
	output?: string & !=""
}

#IacDriftReport: {
	kind:     "drift-report"
	provider: "crossplane"
	model:    "composite-resource-claim"
	drifted:  bool
	resources: [...#IacDriftedResource]
}

#IacResourceOutputs: {
	id:     string & !=""
	status: "provisioned" | "pending" | "destroyed"
	outputs: {[string]: string}
}

#IacOutputs: {
	kind:     "outputs"
	provider: "crossplane"
	model:    "composite-resource-claim"
	resources: {[string]: #IacResourceOutputs}
	stackOutputs: {[string]: string}
	bindings: {[string]: string}
}
