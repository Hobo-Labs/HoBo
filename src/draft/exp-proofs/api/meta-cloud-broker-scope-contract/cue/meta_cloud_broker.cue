// CUE constraints for every protobuf type in proto/meta_cloud_broker.proto.
// These are M0 data-shape constraints only; no live hosted broker runtime,
// Yard planner, provider adapter, admin UI, or Gatekeeper behavior is provided.
package meta_cloud_broker

import (
	"list"
	"strings"
)

#BrokerDecisionState: "accepted" | "rejected"

#ContractManifest: {
	manifestDigest:        string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	requestedCapabilities: [...string] & list.MinItems(1)
	proofMode:             "schema-test" | "contract-test" | "negative-test" | "policy-fixture"
	source:                string & strings.MinRunes(1)
}

#BrokerEnvironment: {
	environmentDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	approvedBy:        string & strings.MinRunes(1)
	catalogSnapshot:   string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	versionPin:         string & strings.MinRunes(1)
}

#MappingContract: {
	mappingDigest:       string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	environmentDigest:  string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	providerConstraints: [...string] & list.MinItems(1)
	owner:              string & strings.MinRunes(1)
}

#BrokerCatalogSnapshot: {
	snapshotDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	catalogVersion: string & strings.MinRunes(1)
	issuedAt:       string & strings.MinRunes(1)
	staleAfter:      string & strings.MinRunes(1)
}

#ResolutionReceipt: {
	receiptId:         string & =~"^rr_[a-zA-Z0-9]+$"
	manifestDigest:    string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	environmentDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	decision:          #BrokerDecisionState & "accepted"
	source:            string & strings.MinRunes(1)
}

#ResolutionRejection: {
	rejectionId:       string & =~"^rej_[a-zA-Z0-9]+$"
	manifestDigest:    string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	environmentDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	decision:          #BrokerDecisionState & "rejected"
	reason:            "stale-catalog-snapshot" | "incompatible-mapping" | "ambiguous-mapping" | "unsupported-capability"
	source:            string & strings.MinRunes(1)
}
