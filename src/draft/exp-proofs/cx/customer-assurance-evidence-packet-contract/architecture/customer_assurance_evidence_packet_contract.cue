// CUE constraints for every protobuf type in this package's schema, so the architecture guard can
// confirm the data shapes are bounded at parse time.

package architecture_evidence

#CustomerAssuranceReadinessState: "unspecified" | "accepted" | "needs-owner-review" | "blocked-unavailable" | "explicit-launch-limitation"

#CustomerAssuranceLegalArtifactDisposition: "unspecified" | "ready" | "launch-blocker" | "explicit-launch-limitation"

#CustomerAssuranceSection: {
	id:               string & !=""
	owner:            string & !=""
	source_evidence:  string & !=""
	beta_readiness:   #CustomerAssuranceReadinessState
	ga_readiness:     #CustomerAssuranceReadinessState
	customer_message: string & !=""
}

#CustomerAssuranceLegalArtifact: {
	id:                   string & !=""
	available:            bool
	disposition:          #CustomerAssuranceLegalArtifactDisposition
	owner:                string & !=""
	customer_safe_status: string & !=""
}

#CustomerAssuranceEvidencePacketRecord: {
	issue:           string & !=""
	sections:        [...#CustomerAssuranceSection]
	legal_artifacts: [...#CustomerAssuranceLegalArtifact]
	evidence:        [...string]
}
