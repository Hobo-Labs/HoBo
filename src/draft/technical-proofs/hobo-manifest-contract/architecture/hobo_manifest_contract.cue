
package architecture_evidence

#HoboManifestContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboManifestContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
