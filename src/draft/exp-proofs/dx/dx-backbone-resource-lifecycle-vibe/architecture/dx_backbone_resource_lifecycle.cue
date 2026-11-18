package dx_backbone_resource_lifecycle

#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#Phase: "M1" | "M2"

#DesignAnchor: {
	source: =~"^urn:hobo:requirement:[a-z0-9-]+#plan-[0-9]+$"
	reason: string & != ""
}

#ChildSlice: {
	issue: =~"^HOBO-[0-9]+$"
	title: string & != ""
	phase: #Phase
	targetPackage: =~"^src/draft/exp-proofs/(dx|ux|cx|ax|api)/[a-z0-9-]+$"
	proofNote: =~"^urn:hobo:proof:[a-z0-9-]+$"
	coverage: [...string]
	dependsOn: [...=~"^HOBO-[0-9]+$"]
	scopeOut: [...string]
}

#DownstreamConsumerGate: {
	consumer: string & != ""
	mustConsume: [...=~"^HOBO-[0-9]+$"]
	sourceMaterial: string & != ""
	inventBehavior: false
}

#DxBackboneRecord: {
	issue: "HOBO-566"
	targetPackage: "src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe"
	proofNote: "urn:hobo:proof:dx-backbone-resource-lifecycle-vibe"
	designAnchors: [
		#DesignAnchor & {source: "urn:hobo:requirement:developer-experience#plan-07"},
		#DesignAnchor & {source: "urn:hobo:requirement:sdk-api#plan-02"},
		#DesignAnchor & {source: "urn:hobo:requirement:control-plane#plan-04"},
		#DesignAnchor & {source: "urn:hobo:requirement:platform-engineering#plan-25"},
		#DesignAnchor & {source: "urn:hobo:requirement:data-plane#plan-11"},
	]
	proofModes: ["live", "simulated", "reference fixture", "scope-out"]
	childSlices: [...#ChildSlice]
	downstreamGates: [...#DownstreamConsumerGate]
	scopeOut: [...string]
}
