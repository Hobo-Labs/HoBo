// CUE constraints for pod_resolver.proto (plan 0024 WP13).
package provider_webernetes

#PodDigest: =~"^sha256:[a-f0-9]{64}$"

#WebernetesPodOutputs: {
	stationId:        =~"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
	stationUrl?:      =~"^https?://"
	locality?:        "loopback" | "private-network" | "overlay"
	servingEndpoint?: =~"^(https://|http://(127\\.0\\.0\\.1|localhost|\\[::1\\])[:/])"
	artifactDigest?:  #PodDigest
	probeStatus?:     int & >=0 & <=599
	ready:            bool
	operationConfirmed:   bool
	operationTerminal:    bool
	absenceConfirmed:     bool
	retirementConfirmed?: bool
	lifecycleStatus:      "ready" | "pending" | "absent"
	// Never ready without a successful probe.
	if ready {
		probeStatus:     >=200 & <300
		lifecycleStatus: "ready"
	}
	if absenceConfirmed {
		ready:           false
		lifecycleStatus: "absent"
	}
}

#WebernetesStationRecord: {
	state: "running" | "released"
	if state == "running" {
		stationUrl: =~"^https?://"
		claimUrl:   =~"^https?://"
	}
	artifactDigest?: #PodDigest
}
