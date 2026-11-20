package data_models

#ResourceScope: {
	resourceId:         string & !=""
	resourceType:       string & !=""
	providerId:         string & !=""
	providerAccountRef: string & !=""
	productId:          string & !=""
}

#Target: {
	targetId:             string & !=""
	tenantId:             string & !=""
	stackName:            string & !=""
	stage:                string & !=""
	programResourceId:    string & !=""
	sourceDigest:         string & =~"^sha256:[a-f0-9]{64}$"
	inventoryEvidenceRef: string & !=""
	resources: [#ResourceScope, ...#ResourceScope]
	_limit: true & (len(resources) <= 256)
	_unique: {
		for i, left in resources
		for j, right in resources
		if j > i {
			"\(i)/\(j)": true & (left.resourceId != right.resourceId)
		}
	}
}

#AlchemyIac: #Target
