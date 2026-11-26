package broker_environment_publication

import "list"
import "strings"

#Digest: string & =~"^sha256:[a-f0-9]{64}$"

#ProviderCapabilityPublication: {
	providerId:        string & strings.MinRunes(1)
	manifestDigest:    #Digest
	conformanceDigest: #Digest
	capabilities: [...#Capability] & list.MinItems(1)
}

#Capability: {
	type:     string & strings.MinRunes(1)
	features: [...string] & list.MinItems(1)
}

#BrokerCatalogPublication: {
	catalogVersion: string & strings.MinRunes(1)
	snapshotDigest: #Digest
	issuedAt:       string & strings.MinRunes(1)
	staleAfter:     string & strings.MinRunes(1)
}

#MappingPublication: {
	mappingId:              string & strings.MinRunes(1)
	mappingDigest:          #Digest
	providerId:             string & strings.MinRunes(1)
	resourceType:           string & strings.MinRunes(1)
	providerResourceClass:  string & strings.MinRunes(1)
	requires:              [...string] & list.MinItems(1)
	compatibility:         "compatible"
}

#ApprovalEvidence: {
	approvalId:     string & strings.MinRunes(1)
	approvedBy:     string & strings.MinRunes(1)
	decision:       "approved"
	approvedAt:     string & strings.MinRunes(1)
	evidenceDigest: #Digest
}

#PublicationProvenance: {
	sourceIssue: "HOBO-526"
	sourceRefs: [...string] & list.MinItems(1)
	digest:     #Digest
}

#ProviderDefaultInput: {
	definitionId:   string & strings.MinRunes(1)
	providerId:     string & strings.MinRunes(1)
	type:           string & strings.MinRunes(1)
	resourceClass:  string & strings.MinRunes(1)
	role:           "broker-validation-input"
}

#BrokerEnvironmentSnapshot: {
	snapshotId:       string & =~"^bes_[a-f0-9]+$"
	schema:           "hobo.broker-environment-snapshot/v1"
	provider:         #ProviderCapabilityPublication
	catalog:          #BrokerCatalogPublication
	mapping:          #MappingPublication
	approval:         #ApprovalEvidence
	provenance:       #PublicationProvenance
	providerDefaults: [...#ProviderDefaultInput] & list.MinItems(1)
}
