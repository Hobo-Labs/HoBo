package architecture_evidence

#AspireHostingTestingTrackerStatus:
	"unspecified" | "parity" | "deferred" | "planned" | "overclaimed"

#AspireHostingTestingTrackerEvaluation: {
	feature:                      string & !=""
	status:                       #AspireHostingTestingTrackerStatus
	has_whole_graph_harness_spec: bool
	ok:                           bool
	reason:                       string & !=""
}
