// CUE constraints for each HOBO-543 protobuf shape. The proof keeps plan
// annotations bounded to deterministic fixtures and fails closed on missing or
// unknown evidence.

package architecture_evidence

import "list"

#PlanAnnotationProofMode: "reference fixture" | "simulated" | "scope-out"

#PlanAnnotationFixture: {
	case:                    "policy denial" | "widened permission" | "cost estimate" | "capacity warning" | "stale SLO signal" | "missing approval"
	annotationInput:         string & !=""
	displayGroup:            "policy" | "cost" | "capacity" | "approval" | "readiness"
	severity:                "info" | "warning" | "blocked" | "critical"
	proofMode:               #PlanAnnotationProofMode
	evidenceState:           "happy" | "blocked" | "stale/unknown"
	missingEvidenceBehavior:  "not applicable" | "show as unavailable" | "show as stale/unknown"
	supportOwnerRoute:       string & !=""
	supportSafeWording:      string & !=""
	accessibilityNote:       string & !=""
	fixtureId:               =~"^fixture\\.plan\\.annotation\\."
}

#PlanAnnotationContractFixtures: {
	protobuf: "architecture/vibe_plan_annotation_pseudocode.proto"
	cue:      "architecture/vibe_plan_annotation_pseudocode.cue"
	pact:     "architecture/pacts/vibe_plan_annotation_pseudocode.pact.json"
}

#PlanAnnotationPseudocodeContract: {
	schema:              "hobo.vibe-plan-annotation-pseudocode/v1"
	issue:               "HOBO-543"
	phase:               "M1"
	targetPackagePath:   "src/draft/exp-proofs/ux/vibe-plan-annotation-pseudocode"
	proofNotePath:       "docs/design/proofs/vibe-plan-annotation-pseudocode/README.md"
	designRefs:          [...string] & list.MinItems(1)
	annotations:         [...#PlanAnnotationFixture] & list.MinItems(6)
	contractFixtures:    #PlanAnnotationContractFixtures
	scopeOut:            [...string] & list.MinItems(1)
}
