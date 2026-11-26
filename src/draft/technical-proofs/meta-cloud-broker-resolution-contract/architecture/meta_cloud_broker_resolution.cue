// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#BrokerResolutionAction: "provision" | "deploy" | "bind"
#BrokerRejectionCode: "mapping.ambiguous" | "mapping.incompatible" | "mapping.unavailable"

#Digest: =~"^sha256:[a-f0-9A-Za-z._:-]+$"

#BrokerManifestResource: {
	resourceId:        string & !=""
	interface:         string & =~"^hobo:"
	requiredFeatures: [...string]
	action:           #BrokerResolutionAction
}

#BrokerContractManifest: {
	schema:         "hobo.contract-manifest/v1"
	manifestId:     string & !=""
	manifestDigest: #Digest
	resources:      [...#BrokerManifestResource] & len(_) > 0
}

#BrokerMappingContract: {
	mappingId:    string & !=""
	resourceId:   string & !=""
	capabilityId: string & !=""
	provider:     string & !=""
	approved:     bool
}

#BrokerCatalogCapability: {
	capabilityId:         string & !=""
	provider:             string & !=""
	interface:            string & =~"^hobo:"
	features:            [...string]
	approved:            bool
	compatible:          bool
	available:           bool
	defaultForInterface?: bool
}

#BrokerEnvironmentSnapshot: {
	schema:                "hobo.broker-environment/v1"
	snapshotId:            string & !=""
	environmentDigest:     #Digest
	catalogSnapshotDigest: #Digest
	mappings:              [...#BrokerMappingContract]
	catalog:               [...#BrokerCatalogCapability] & len(_) > 0
}

#BrokerResourcePlan: {
	resourceId:   string & !=""
	provider:     string & !=""
	capabilityId: string & !=""
	action:       #BrokerResolutionAction
}

#BrokerReplayInputs: {
	manifestDigest:        #Digest
	environmentDigest:     #Digest
	catalogSnapshotDigest: #Digest
}

#BrokerResolutionReceipt: {
	schema:                "hobo.resolution-receipt/v1"
	receiptId:             string & !=""
	resolutionAuthority:   "meta-cloud-broker"
	manifestId:            string & !=""
	environmentSnapshotId: string & !=""
	replayInputs:          #BrokerReplayInputs
	resourcePlans:         [...#BrokerResourcePlan] & len(_) > 0
	digest:                #Digest
	signature:             string & =~"^signed:meta-cloud-broker:sha256:"
}

#BrokerResolutionRejection: {
	schema:              "hobo.resolution-rejection/v1"
	rejectionId:         string & !=""
	resolutionAuthority: "meta-cloud-broker"
	replayInputs:        #BrokerReplayInputs
	code:                #BrokerRejectionCode
	message:             string & !=""
	details:             [...string]
	fallbackAttempted:   false
	digest:              #Digest
	signature:           string & =~"^signed:meta-cloud-broker:sha256:"
}
