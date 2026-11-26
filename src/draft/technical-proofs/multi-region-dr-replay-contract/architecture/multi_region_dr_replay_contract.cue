// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#MultiRegionTopologyMode: "unspecified" | "active-passive-log" | "active-active-stateless"

#RestoreDrillStatus: "unspecified" | "passed" | "failed"

#MultiRegionDrReplayContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
