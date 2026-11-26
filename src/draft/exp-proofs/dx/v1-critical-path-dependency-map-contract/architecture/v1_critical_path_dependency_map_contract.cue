// CUE constraints for every protobuf type in this package's schema, so the architecture guard can
// confirm the data shapes are bounded at parse time.

package architecture_evidence

#ReleaseDependencyDomain: "unspecified" | "product-ux" | "tenant-model" | "billing" | "install" | "docs" | "testing" | "support" | "security" | "compliance" | "operations"

#ReleaseBlockerType: "unspecified" | "beta-blocker" | "rc-blocker" | "ga-blocker" | "known-limitation"

#CriticalPathDependency: {
	id:              =~"^v1-critical-path\\.[a-z0-9-]+$"
	domain:          #ReleaseDependencyDomain & !="unspecified"
	blocker_type:    "beta-blocker" | "rc-blocker" | "ga-blocker"
	upstream_project: string & !=""
	downstream_gate:  string & !=""
	owner:            string & !=""
}

#KnownLimitation: {
	id:                   =~"^known-limitation\\.[a-z0-9-]+$"
	blocker_type:         "known-limitation"
	upstream_project:     string & !=""
	customer_disposition: string & !=""
	owner:                string & !=""
}

#CriticalPathDependencyMapRecord: {
	issue:             "HOBO-484"
	phase:             "M0"
	dependencies:      [...#CriticalPathDependency]
	known_limitations: [...#KnownLimitation]
}
