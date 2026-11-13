// CUE constraints for every protobuf type in provider_npm.proto, over the
// JSON (camelCase) spellings the realizer actually exchanges.
//
// The invariants written down here are the ones the realizer's correctness
// rests on: a version npm will publish under exactly the string desired (no
// build metadata), a dist-tag that cannot be read as a semver range, artifacts
// addressed by digest only, and outputs that claim readiness only when the
// dist-tag was observed pointing at the version.

package provider_npm

import "strings"

#NpmRegistryKind: "npmjs" | "github-packages" | "verdaccio"

#NpmAuthMode: "token" | "oidc-trusted-publishing"

#NpmConflictReason: "npm-version-integrity-mismatch" | "npm-version-previously-unpublished"

#Sha256Digest: =~"^sha256:[0-9a-f]{64}$"

#NpmPackageName: =~"^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$"

#NpmVersion: =~"^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$"

#NpmDistTag: =~"^[A-Za-z][A-Za-z0-9._-]{0,63}$" & !~"^v[0-9]"

#NpmRegistryBase: =~"^https://[^/@?#]+(/[^?#]*[^/?#])?$"

#NpmPackageVersionDesired: {
	registry:            #NpmRegistryBase
	packageName:         #NpmPackageName
	version:             #NpmVersion
	distTag:             #NpmDistTag
	artifactDigest:      #Sha256Digest
	artifactCoordinate?: =~"^store://[a-z0-9-]+/sha256:[0-9a-f]{64}$"
	provenanceDigest?:   #Sha256Digest
	access?:             "public" | "restricted"
	deprecationMessage?: string & =~"\\S" & strings.MaxRunes(1024)
}

#NpmPackageVersionOutputs: {
	registry:           #NpmRegistryBase
	packageName:        #NpmPackageName
	version:            #NpmVersion
	distTag:            #NpmDistTag
	distTagVersion:     #NpmVersion | null
	integrity:          =~"^sha(256|384|512)-"
	shasum:             =~"^[0-9a-f]{40}$"
	tarballUrl?:        =~"^https://"
	artifactDigest:     #Sha256Digest
	provenanceObserved: bool
	deprecated:         bool
	ready:              bool
	operationConfirmed: ready
	operationTerminal:  ready
	absenceConfirmed:   false
	lifecycleStatus:    "pending" | "ready"
	if ready {
		lifecycleStatus: "ready"
		distTagVersion:  version
	}
	if !ready {
		lifecycleStatus: "pending"
	}
}
