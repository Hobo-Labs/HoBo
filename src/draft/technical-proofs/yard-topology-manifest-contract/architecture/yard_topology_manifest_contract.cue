
package architecture_evidence

#YardTopologyManifestContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#YardTopologyManifestContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
