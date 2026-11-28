
package architecture_evidence

#WebsocketStreamerFanoutContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WebsocketStreamerFanoutContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
