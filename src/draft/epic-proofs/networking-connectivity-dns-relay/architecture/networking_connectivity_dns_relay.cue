
package architecture_evidence

#NetworkingConnectivityDnsRelayEvidenceKind: "unspecified" | "design-record" | "contract-test"

#NetworkingConnectivityDnsRelayRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
