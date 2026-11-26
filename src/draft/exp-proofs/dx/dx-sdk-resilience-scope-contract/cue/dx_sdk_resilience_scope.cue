package dx_sdk_resilience_scope

Phase: "PHASE_M0" | "PHASE_M1" | "PHASE_M2" | "PHASE_M3" | "PHASE_M4"

DxSdkResilienceScope: {
	issue:       "HOBO-514"
	project:     "DX SDK Resilience Semantics"
	initiatives: [...string] & [_, _, ...]
	vocabulary:  [...string] & [_, _, _, _, _, _, _, _, _, ...]
	child_issues: [...ChildIssue] & [_, _, _, _, _, _, ...]
	adversarial_rules: [...AdversarialRule] & [_, _, _, _, ...]
}

ChildIssue: {
	id:                    =~"^HOBO-[0-9]+$"
	phase:                 Phase
	target_path:           string & != ""
	scope_in:              [...string] & [_, ...]
	scope_out:             [...string] & [_, ...]
	acceptance:            [...string] & [_, ...]
	adversarial_checks:    [...string] & [_, ...]
	verification_commands: [...string] & [_, ...]
}

AdversarialRule: {
	id:           string & != ""
	claim:        string & != ""
	failure_code: =~"^[a-z0-9-]+$"
}
