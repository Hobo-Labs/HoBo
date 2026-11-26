package stage_gate

import "strconv"

#DigestSha256: string & =~"^sha256:[a-f0-9]{64}$"
#IsoTimestamp: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"

// not_run: the check could not be carried out (ai-bdd exit 3, ADR-0172); a
// record with one and no failed check is not_run, never passed or failed.
#CheckStatus:  "passed" | "failed" | "skipped" | "not_run"
#RecordStatus: "passed" | "failed" | "skipped" | "not_run"

#CheckResult: {
	check_id!: string & !=""
	command!: [...string]
	// -1: never started (a required check did not pass); status is then skipped.
	exit_code!: int
	status!:    #CheckStatus
	evidence?: {[string]: string}
}

#ComponentArtifact: {
	digest_sha256!: #DigestSha256
	byte_length!: int & >=0
	media_type!: string & !=""
}

#SignatureEvidence: {
	verified!: bool
	signer_identity!: string
	provenance_tier!: string
	conformance_report_digest: #DigestSha256 | ""
}

// A field marked `!` must be present in the data. CUE fills an absent field
// with the value its constraints give it, so without the mark a record that
// leaves out `model_calls` would satisfy `model_calls: "0"`, and one that
// leaves out a check's `status` would satisfy the `status: "passed"` a passed
// record asks for. Every field parseStageGateRecord requires is marked.
#StageGateRecord: {
	gate_id!: "s0" | "release"
	status!: #RecordStatus
	repo_commit!: string
	ci_run_url?: string & =~"^https://" | ""
	started_at!: #IsoTimestamp
	finished_at!: #IsoTimestamp
	checks!: [...#CheckResult]
	artifact!: #ComponentArtifact
	signature!: #SignatureEvidence

	// A field a conditional block gives a value is marked `!` there too: a
	// regular field unified with a required one satisfies the requirement.
	if status == "passed" {
		checks!: [...#CheckResult & {status!: "passed"}]
	}
	// S0 attests a built, signed component.
	if gate_id == "s0" && status == "passed" {
		signature!: verified!: true
		artifact!: digest_sha256!: #DigestSha256
	}
	// The release gate attests a replay (ADR-0172): its three checks in order;
	// the replay's evidence of a replay-only run that replayed a scenario; and
	// evidence-intact naming the same run and report the replay judged.
	if gate_id == "release" && status == "passed" {
		checks!: [
			{check_id!: "acceptance-plans-fresh"},
			{
				check_id!: "acceptance-replay"
				evidence!: {
					report_digest!:    #DigestSha256
					run_id!:           string & !=""
					model_calls!:      "0"
					frozen!:           "true"
					no_agent!:         "true"
					report_exit_code!: "0"
					scenarios_total!:  =~"^[0-9]+$"
					scenarios_passed!: =~"^[0-9]+$"
					scenarios_healed!: =~"^[0-9]+$"
				}
			},
			{
				check_id!: "acceptance-evidence-intact"
				evidence!: {
					report_digest!: checks[1].evidence.report_digest
					run_id!:        checks[1].evidence.run_id
				}
			},
		]
		// Each count is read as strconv.Atoi reads it, as record-constraints.ts
		// does: decimal digits (a leading zero allowed) within int64.
		_total: strconv.Atoi(checks[1].evidence.scenarios_total) & >0
		_replayed: strconv.Atoi(checks[1].evidence.scenarios_passed) + strconv.Atoi(checks[1].evidence.scenarios_healed)
		_replayed: >0
	}
	if finished_at != "" && started_at != "" {
		finished_at: string
	}
}
