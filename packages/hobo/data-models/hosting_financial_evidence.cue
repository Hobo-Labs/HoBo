package hobo

#HostingFinancialResourceBinding: {
	artifactId:     =~"^sha256:[a-f0-9]{64}$"
	resourceName:   string & !=""
	productId:      string & !=""
	resourceId:     string & !=""
	physicalId?:    string
	artifactDigest: =~"^sha256:[a-f0-9]{64}$"
}
#HostingFinancialLifecycleEvidence: {
	binding:         #HostingFinancialResourceBinding
	observationJson: string & !=""
}
#HostingFinancialLiabilityEvidence: {
	binding:       #HostingFinancialResourceBinding
	liabilityJson: string & !=""
	finalized?:    bool
}
#HostingFinancialEvidenceClaims: {
	schemaVersion:     "hobo.hosting-financial-evidence/v1"
	proofId:           string & !=""
	issuerId:          string & !=""
	keyId:             string & !=""
	tenantId:          string & !=""
	providerId:        string & !=""
	providerAccountId: string & !=""
	currency:          =~"^[A-Z]{3}$"
	operationId:       string & !=""
	operationDigest:   =~"^sha256:[a-f0-9]{64}$"
	planDigest:        =~"^sha256:[a-f0-9]{64}$"
	issuedAtMs:        int & >=0 & <=9007199254740991
	expiresAtMs:       int & >issuedAtMs & <=9007199254740991
	lifecycles?: [...#HostingFinancialLifecycleEvidence]
	liabilities?: [...#HostingFinancialLiabilityEvidence]
}
#HostingFinancialEvidenceAttestation: {
	claims:    #HostingFinancialEvidenceClaims
	signature: =~"^ed25519:[A-Za-z0-9_-]{86}$"
}
#HostingFinancialEvidenceUse: {
	proofDigest:  =~"^sha256:[a-f0-9]{64}$"
	attestation:  #HostingFinancialEvidenceAttestation
	acceptedAtMs: int & >=0 & <=9007199254740991
}
HostingFinancialResourceBinding:     #HostingFinancialResourceBinding
HostingFinancialLifecycleEvidence:   #HostingFinancialLifecycleEvidence
HostingFinancialLiabilityEvidence:   #HostingFinancialLiabilityEvidence
HostingFinancialEvidenceClaims:      #HostingFinancialEvidenceClaims
HostingFinancialEvidenceAttestation: #HostingFinancialEvidenceAttestation
HostingFinancialEvidenceUse:         #HostingFinancialEvidenceUse
