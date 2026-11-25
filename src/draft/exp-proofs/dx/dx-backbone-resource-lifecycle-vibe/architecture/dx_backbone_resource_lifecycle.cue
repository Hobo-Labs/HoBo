package dx_backbone_resource_lifecycle

#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#Phase: "M1" | "M2"

#DesignAnchor: {
	source: =~"^docs/design/[a-z0-9-]+\\.md#plan-[0-9]+$"
	reason: string & != ""
}

#ChildSlice: {
	issue: =~"^HOBO-[0-9]+$"
	title: string & != ""
	phase: #Phase
	targetPackage: =~"^src/draft/exp-proofs/(dx|ux|cx|ax|api)/[a-z0-9-]+$"
	proofNote: =~"^docs/design/proofs/[a-z0-9-]+/README.md$"
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
	proofNote: "docs/design/proofs/dx-backbone-resource-lifecycle-vibe/README.md"
	designAnchors: [
		#DesignAnchor & {source: "docs/design/developer-experience.md#plan-07"},
		#DesignAnchor & {source: "docs/design/sdk-api.md#plan-02"},
		#DesignAnchor & {source: "docs/design/control-plane.md#plan-04"},
		#DesignAnchor & {source: "docs/design/platform-engineering.md#plan-25"},
		#DesignAnchor & {source: "docs/design/data-plane.md#plan-11"},
	]
	proofModes: ["live", "simulated", "reference fixture", "scope-out"]
	childSlices: [...#ChildSlice]
	downstreamGates: [...#DownstreamConsumerGate]
	scopeOut: [...string]
}
