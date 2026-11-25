// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

import "list"

#ControlPlaneApiProofMode: "reference-fixture" | "contract-fixture" | "projection-snapshot" | "support-safe-evidence"

#ControlPlaneApiOperation: {
	id:                   string & !=""
	humanName:            string & !=""
	cliCommand:           string & !=""
	apiEndpoint:          =~"^/"
	mcpTool:              =~"^hobo_"
	requestShape:         [...string] & list.MinItems(1)
	responseShape:        [...string] & list.MinItems(1)
	domainTerms:          [...string] & list.MinItems(1)
	sharedResultEnvelope: true
	fixtureId:            string & !=""
}

#ControlPlaneApiRefusalEnvelope: {
	code:            "policy-denied" | "contract-incompatible" | "provider-capability-partial" | "provider-capability-none" | "stale-projection" | "unknown-evidence" | "non-reactive-sink" | "destructive-migration-blocked"
	trigger:         string & !=""
	remediation:     string & !=""
	proofMode:       #ControlPlaneApiProofMode
	fixtureId:       string & !=""
	redactionClass:  "public" | "tenant-safe" | "support-redacted"
}

#ControlPlaneApiContractFixtures: {
	protobuf: "architecture/control_plane_api_resource_lifecycle_shapes.proto"
	cue:      "architecture/control_plane_api_resource_lifecycle_shapes.cue"
	pact:     "architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json"
}

#ControlPlaneApiResourceLifecycleContract: {
	issue:              "HOBO-569"
	phase:              "M1"
	targetPackage:      "src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes"
	proofNote:          "docs/design/proofs/control-plane-api-resource-lifecycle-shapes/README.md"
	designRefs:         [...string] & list.MinItems(1)
	operations:         [...#ControlPlaneApiOperation] & list.MinItems(8)
	refusalEnvelopes:   [...#ControlPlaneApiRefusalEnvelope] & list.MinItems(8)
	contractFixtures:   #ControlPlaneApiContractFixtures
	scopeOut:           [...string] & list.MinItems(1)
}
