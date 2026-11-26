package conformance

#ConformanceCheckResult: {
	check_id: string & !=""
	port: string & !=""
	tag: "local" | "camp"
	status: "pass" | "fail"
}

#ConformanceFailure: {
	check_id: string & !=""
	message: string & !=""
}

#LocalCoverage: {
	status: "pass" | "fail"
	passed: int & >=0
	failed: int & >=0
	total: int & >0
	// Every check is either a pass or a failure; a coverage row whose parts do
	// not sum to its total is under-reporting one of them.
	_coverageAccountsForEveryCheck: true & (passed + failed == total)
}

#RuntimePortConformanceReport: {
	contract: "hobo.runtime-port-conformance/v1"
	backend: string & !=""
	status: "pass" | "fail"
	checks: [...#ConformanceCheckResult]
	failures: [...#ConformanceFailure]
	local_coverage: #LocalCoverage

	// A failing report that names no failure is not actionable.
	if status == "fail" {
		failures: [_, ...]
	}
}

#CertifiedHostPin: {
	kind: string & !=""
	version: string & !=""
}

#ComponentHostManifest: {
	schema: string & !=""
	certified_hosts: [#CertifiedHostPin, ...]
}

#ComponentHostConformanceReport: {
	schema: "@hobo/conformance/component-host/v1"
	status: "pass" | "fail"
	non_covered_divergences: [
		"wall-clock scheduling jitter",
		"host-specific partial-failure timing",
	]
}
