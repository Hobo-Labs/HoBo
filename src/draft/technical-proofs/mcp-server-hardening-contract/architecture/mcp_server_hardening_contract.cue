
package architecture_evidence

#McpServerHardeningContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#McpServerHardeningContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
