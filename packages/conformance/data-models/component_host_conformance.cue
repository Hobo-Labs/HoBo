package conformance

#CertifiedHostPin: {
	kind: string & !=""
	version: string & !=""
}

#ComponentHostManifestSection: {
	suite: string & !=""
	suite_version: string & !=""
	certified_hosts: [#CertifiedHostPin, ...]
}

#ComponentHostManifest: {
	schema: string & !=""
	component_host: #ComponentHostManifestSection
}

#HostReport: {
	kind: string & !=""
	version: string & !=""
	boundary_mode: string & !=""
	status: "pass" | "fail"
}

#CrossHostAssertion: {
	name: string & !=""
	status: "pass" | "fail"
}

#ComponentHostConformanceReport: {
	schema: "@hobo/conformance/component-host/v1"
	status: "pass" | "fail"
	non_covered_divergences: [
		"wall-clock scheduling jitter",
		"host-specific partial-failure timing",
	]
}
