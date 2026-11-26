package meta_cloud_broker_artifact_contract

import "list"
import "strings"

#BrokerArtifactEnvelope: {
	kind:       "contract-manifest" | "broker-environment" | "mapping-contract" | "broker-catalog-snapshot" | "resolution-receipt" | "resolution-rejection"
	schema:     string & =~"^hobo\\.meta-cloud-broker\\."
	version:    string & =~"^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
	owner:      string & strings.MinRunes(1)
	provenance: #BrokerArtifactProvenance
}

#BrokerArtifactProvenance: {
	source:     #BrokerArtifactSource
	proofMode:  "schema-test" | "contract-test" | "negative-test" | "policy-fixture"
	signature:  #BrokerSignature
}

#BrokerArtifactSource: {
	issue: "HOBO-522"
	refs:  [...string] & list.MinItems(1)
}

#BrokerSignature: {
	issuer:    string & strings.MinRunes(1)
	algorithm: "ed25519"
	digest:    string & =~"^sha256:[a-zA-Z0-9._:-]+$"
}

#ContractManifestArtifact: {
	manifestDigest:         string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	manifestSchema:         "hobo.manifest/v1"
	requestedCapabilities:  [...string] & list.MinItems(1)
	declaredFacts:          [...#ContractFact]
}

#ContractFact: {
	ref:    string & strings.MinRunes(1)
	edge:   string & strings.MinRunes(1)
	digest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
}

#BrokerEnvironmentArtifact: {
	environmentDigest:    string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	approvedBy:           string & strings.MinRunes(1)
	catalogSnapshotDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	allowedProviderIds:   [...string] & list.MinItems(1)
}

#MappingContractArtifact: {
	mappingDigest:        string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	environmentDigest:    string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	allowedProviders:     [...#MappingProvider] & list.MinItems(1)
	unilateralSelection:   false
}

#MappingProvider: {
	providerId:     string & strings.MinRunes(1)
	catalogDigest:  string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	priority:       int & >=0
}

#BrokerCatalogSnapshotArtifact: {
	snapshotDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	catalogVersion: string & strings.MinRunes(1)
	capabilities:   [...#CatalogCapability] & list.MinItems(1)
}

#CatalogCapability: {
	providerId:     string & strings.MinRunes(1)
	port:           string & strings.MinRunes(1)
	"interface":   string & strings.MinRunes(1)
	version:        string & strings.MinRunes(1)
}

#ResolutionReceiptArtifact: {
	receiptId:                 string & =~"^rr_[a-zA-Z0-9]+$"
	manifestDigest:            string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	environmentDigest:         string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	mappingDigest:             string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	noHostedBrokerReResolve:   true
}

#ResolutionRejectionArtifact: {
	rejectionId:        string & =~"^rej_[a-zA-Z0-9]+$"
	manifestDigest:    string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	environmentDigest: string & =~"^sha256:[a-zA-Z0-9._:-]+$"
	reasonCode:        "stale-catalog-snapshot" | "incompatible-mapping" | "ambiguous-mapping" | "unsupported-capability"
	reasonMessage:     string & strings.MinRunes(1)
}
