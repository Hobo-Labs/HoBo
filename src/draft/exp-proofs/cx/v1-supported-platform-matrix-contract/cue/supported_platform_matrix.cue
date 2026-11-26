// CUE constraints for every protobuf type in proto/supported_platform_matrix.proto.
// These constrain the customer-facing shape of v1 support records at M0; they are
// validation constraints only and do not implement a browser grid or device lab.
package supported_platform_matrix

import (
	"list"
	"strings"
)

// Customer-facing support level.
#SupportLevel: "supported" | "limited" | "unsupported"

// Allowed evidence sources for any support claim or matrix row.
#EvidenceSource: "e2e-tests" | "accessibility-checks" | "bootstrap-smoke" | "docs" | "support-guidance" | "known-limitation"

#DesktopBrowserSupport: {
	name:          string & strings.MinRunes(1)
	versionPolicy: string & strings.MinRunes(1)
	beta:          #SupportLevel
	ga:            #SupportLevel
	evidenceSources: [...#EvidenceSource] & list.MinItems(1)
}

#PlatformSupport: {
	os: string & strings.MinRunes(1)
	architectures: [...string] & list.MinItems(1)
	beta: #SupportLevel
	ga:   #SupportLevel
	evidenceSources: [...#EvidenceSource] & list.MinItems(1)
}

#SupportClaim: {
	id:    string & =~"^[a-z][a-z0-9-]*$"
	claim: string & strings.MinRunes(1)
	owner: string & strings.MinRunes(1)
	evidenceSources: [...#EvidenceSource] & list.MinItems(1)
}

#UnsupportedReportRoute: {
	destination: "support-debug" | "release-notes" | "known-limitations-register"
	owner:       string & strings.MinRunes(1)
	handles:     string & strings.MinRunes(1)
}

#CompatibilityMatrixPublished: {
	issue: "HOBO-511"
	browsers: [...#DesktopBrowserSupport] & list.MinItems(1)
	platforms: [...#PlatformSupport] & list.MinItems(1)
}

#UnsupportedEnvironmentClassified: {
	browser:       string
	os:            string
	viewportWidth: int & >=0
	supportLevel:  #SupportLevel
	route:         #UnsupportedReportRoute.destination
}
