package conformance

// Invariants for the anonymous/claimable conformance dimension.
//
// These encode the rules that stop conformance evidence from flattering the
// product it describes: an unknown outcome is never a pass, a report cannot
// call itself ok while carrying a non-passing check, evidence always expires,
// and the credential a live run was handed appears only in redacted form.

#AnonymousCheckOutcome: "pass" | "fail" | "unknown"

#AnonymousDimension: "bootstrap" | "claim" | "binding" | "migration"

#AnonymousFailureCode: "executor.threw" | "executor.unparseable-outcome" |
	"expectation.unmet" | "case.not-executed" | "check.unsupported"

#Sha256Digest: =~"^sha256:[0-9a-f]{64}$"

#IsoDate: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

// A locator, never material. Full paths are elided before an artifact is
// written, so only the scheme, authority, and first segment may appear.
#RedactedSecretRef: =~"^[a-z-]+://[^/]+/[^/]*(/…)?(#…)?$"

#AnonymousSuiteDescriptorRecord: {
	suite_id:  string & !=""
	dimension: #AnonymousDimension
	checks: [...string & !=""] & [_, ...]
	case_ids: [...string & !=""] & [_, ...]
}

#AnonymousCaseRecord: {
	id:    string & !=""
	check: string & !=""
	title: string & !=""
	request_json?:     _
	expectation_json?: _
}

#AnonymousCaseResultRecord: {
	case_id: string & !=""
	check:   string & !=""
	outcome: #AnonymousCheckOutcome
	detail:  string & !=""
	failure_code?: #AnonymousFailureCode
	// A case that passed has nothing to explain; a case that did not pass must
	// say which way it went wrong.
	_failureCodeMatchesOutcome: true & (outcome != "pass" | failure_code == _|_)
}

#AnonymousCheckOutcomeRecord: {
	check:   string & !=""
	outcome: #AnonymousCheckOutcome
}

#AnonymousConformanceReportRecord: {
	schema:     "hobo.conformance.anonymous-claimable/v1"
	suite_id:   string & !=""
	dimension:  #AnonymousDimension
	subject_id: string & !=""
	cases: [...#AnonymousCaseResultRecord] & [_, ...]
	checks: [...#AnonymousCheckOutcomeRecord] & [_, ...]
	ok: bool
	// `ok` is a derived fact, not an independent one: it holds only when every
	// recorded check passed. An unknown check keeps the report not-ok.
	_okRequiresAllChecksPass: true & (!ok | len([for entry in checks if entry.outcome != "pass" {entry}]) == 0)
}

#LiveRunGrantRecord: {
	provider_id:              =~"^[a-z0-9]+(-[a-z0-9]+)*$"
	redacted_credential_ref:  #RedactedSecretRef
	maximum_resources:        uint & >=1 & <=16
	provider_docs_checked_at: #IsoDate
	run_tag?:                 =~"^[a-z0-9][a-z0-9-]{2,40}$"
}

#LiveResourceHandleRecord: {
	id:      string & !=""
	kind:    string & !=""
	run_tag: =~"^[a-z0-9][a-z0-9-]{2,40}$"
}

#LiveCleanupOutcomeRecord: {
	attempted: [...string & !=""]
	destroyed: [...string & !=""]
	leaked:    [...string & !=""]
	detail:    string & !=""
	// Cleanup cannot report destroying more resources than it attempted.
	_destroyedWithinAttempted: true & (len(destroyed) <= len(attempted))
}

#EvidenceProvenanceRecord: {
	adapter_version:           string & !=""
	product_definition_digest: #Sha256Digest
	provider_docs_checked_at:  #IsoDate
	run_tag:                   =~"^[a-z0-9][a-z0-9-]{2,40}$"
	signer_id:                 string & !=""
	suite_ids: [...string & !=""] & [_, ...]
}

#TrustEvidenceSummaryRecord: {
	schema_version:        "hobo.trust-evidence/v1"
	provider_id:           =~"^[a-z0-9]+(-[a-z0-9]+)*$"
	product_definition_id: string & !=""
	adapter_version:       string & !=""
	provider_class:        "established" | "verified-emerging" | "experimental"
	tested_at:             int
	expires_at:            int
	checks: [...#AnonymousCheckOutcomeRecord] & [_, ...]
	creator_authority_after_claim: "absent" | "reauthorization-required" | "rotatable" | "retained" | "unknown"
	claim_action_count:            uint & <=32
	evidence_digest:               #Sha256Digest
	signature:                     string & !=""
	// Evidence that never expires is not evidence; freshness is what lets
	// selection fail closed without re-testing the provider.
	_expiryAfterTest: true & (expires_at > tested_at)
}

#AnonymousTrustEvidenceArtifactRecord: {
	schema:          "hobo.conformance.anonymous-trust-evidence/v1"
	provenance:      #EvidenceProvenanceRecord
	evidence:        #TrustEvidenceSummaryRecord
	artifact_digest: #Sha256Digest
	signature:       string & !=""
	// The artifact and the evidence it wraps must describe the same adapter.
	_adapterVersionAgrees: true & (provenance.adapter_version == evidence.adapter_version)
}

#LiveConformanceResultRecord: {
	schema:   "hobo.conformance.live-run/v1"
	grant:    #LiveRunGrantRecord
	run_tag:  =~"^[a-z0-9][a-z0-9-]{2,40}$"
	reports:  [...#AnonymousConformanceReportRecord] & [_, ...]
	cleanup:  #LiveCleanupOutcomeRecord
	artifact: #AnonymousTrustEvidenceArtifactRecord
	// The artifact must belong to the run that produced it.
	_artifactBelongsToRun: true & (artifact.provenance.run_tag == run_tag)
}
