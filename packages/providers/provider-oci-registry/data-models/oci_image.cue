// CUE constraints for oci_image.proto (oci-registry.image/v1).
package provider_oci_registry

import "list"

#Host:       =~"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
#Repository: =~"^[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*)*$"
#Digest:     =~"^sha256:[a-f0-9]{64}$"
#Tag:        =~"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$" & !~"^sha256-[a-f0-9]{64}$"

#OciImageDesired: {
	registry:   #Host
	repository: #Repository
	digest:     #Digest
	tags?: [...#Tag] & list.UniqueItems() & list.MaxItems(64)
	sourceRegistry?:   #Host
	sourceRepository?: #Repository
	copyReferrers?:    bool
	if sourceRegistry != _|_ {sourceRepository: #Repository}
	if sourceRepository != _|_ {sourceRegistry: #Host}
}

#TagDigest: {
	tag:    #Tag
	digest: #Digest | "absent"
}

#OciImageOutputs: {
	registry:       #Host
	repository:     #Repository
	digest:         #Digest
	artifactDigest: digest
	reference:      "\(registry)/\(repository)@\(digest)"
	tagDigests: [...#TagDigest]
	manifestPresent:    bool
	tagsConverged:      bool
	ready:              manifestPresent && tagsConverged
	operationConfirmed: ready
	operationTerminal:  ready
	// A registry image is never reported absent by reconcile or read.
	absenceConfirmed: false
	lifecycleStatus:  "ready" | "pending"
	if ready {lifecycleStatus: "ready"}
	if !ready {lifecycleStatus: "pending"}
	referrers?: [...#Digest] & list.UniqueItems()
	referrersDiscoverable?: bool
}
