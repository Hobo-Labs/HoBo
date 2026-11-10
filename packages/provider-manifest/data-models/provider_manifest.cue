package data_models

// CUE constraints for hobo.providermanifest.v1 (provider_manifest.proto), over
// the protobuf JSON form — which is also the YAML/JSON authoring format.
// src/parse.ts enforces the same rules at runtime, plus the cross-references
// (a charge names a declared billable, a mapping names a declared product).

#Slug:               string & =~"^[a-z0-9][a-z0-9._-]*$"
#HttpsUrl:           string & =~"^https://"
#Currency:           string & =~"^[A-Z]{3}$"
#Date:               string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
#UtcTimestamp:       string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#NonNegativeDecimal: string & =~"^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
#PositiveDecimal:    string & =~"^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$"
#ExtensionName:      string & =~"^x-[a-z0-9][a-z0-9-]*$"
#StringMap: {[string]: string}

#ProviderIdentity: {
	id:           #Slug
	displayName:  string & !=""
	homepage?:    #HttpsUrl
	description?: string
}

#SourceRef: {
	url:       #HttpsUrl
	checkedAt: #Date
	note?:     string
}

// ---------------------------------------------------------------- auth

#AuthScope: {
	name:         string & =~"^[A-Za-z0-9:._/-]+$"
	description?: string
}

#OAuth2Flow: {
	grant:                        "authorization-code" | "client-credentials" | "device-code" | "token-exchange" | "jwt-bearer"
	authorizationEndpoint?:       #HttpsUrl
	tokenEndpoint?:               #HttpsUrl
	deviceAuthorizationEndpoint?: #HttpsUrl
	metadataUrl?:                 #HttpsUrl
	pkce?:                        "S256"
	audience?:                    string
	clientRegistration?:          "static" | "dynamic" | "client-id-metadata-document"
	registrationEndpoint?:        #HttpsUrl
	_reachable:                   true & ((tokenEndpoint != _|_) | (metadataUrl != _|_))
	if grant != "authorization-code" {pkce?: _|_}
}

#AuthMdFlow: {
	resource:               #HttpsUrl
	documentUrl?:           #HttpsUrl
	anonymousRegistration?: bool
	humanClaim?:            bool
}

#OidcFederationFlow: {
	audience:  string & !=""
	exchange?: string
}

#ApiKeyFlow: {
	header:    string & =~"^[A-Za-z0-9-]+$"
	prefix?:   string
	rotation?: "manual" | "automatic"
}

#ExtensionAuthFlow: {
	type:    #ExtensionName
	params?: #StringMap
}

#AuthFlow: {
	id:              #Slug
	description?:    string
	scopes?: [...#AuthScope]
	oauth2?:         #OAuth2Flow
	authMd?:         #AuthMdFlow
	oidcFederation?: #OidcFederationFlow
	apiKey?:         #ApiKeyFlow
	extension?:      #ExtensionAuthFlow
	_hasVariant: true & ((oauth2 != _|_) | (authMd != _|_) | (oidcFederation != _|_) | (apiKey != _|_) | (extension != _|_))
	if oauth2 != _|_ {
		authMd?: _|_
		oidcFederation?: _|_
		apiKey?: _|_
		extension?: _|_
	}
	if authMd != _|_ {
		oauth2?: _|_
		oidcFederation?: _|_
		apiKey?: _|_
		extension?: _|_
	}
	if oidcFederation != _|_ {
		oauth2?: _|_
		authMd?: _|_
		apiKey?: _|_
		extension?: _|_
	}
	if apiKey != _|_ {
		oauth2?: _|_
		authMd?: _|_
		oidcFederation?: _|_
		extension?: _|_
	}
	if extension != _|_ {
		oauth2?: _|_
		authMd?: _|_
		oidcFederation?: _|_
		apiKey?: _|_
	}
}

#AuthSection: {
	issuer: #HttpsUrl
	flows: [...#AuthFlow] & [_, ...]
	resourceIndicators?: [...string & !=""]
	tokenLifetimeSec?: int & >0 & <=86400
}

// ---------------------------------------------------------------- capabilities

#CapabilityMapping: {
	id:              string & =~"^[a-z0-9][A-Za-z0-9._/-]*$"
	port:            string & =~"^[A-Za-z][A-Za-z0-9-]*$"
	resourceClass?:  string
	providerService: string & !=""
	features?: [...string & !=""]
	regions?: [...string & !=""]
	stability?: "stable" | "preview" | "experimental"
	version?:   string
	profiles?: [...string & =~"^[a-zA-Z]+(\\.[a-z0-9-]+)+/v[0-9]+$"]
	products?: [...#Slug]
}

#CapabilitySection: {
	regions?: [...string & !=""]
	mappings: [...#CapabilityMapping] & [_, ...]
}

// ---------------------------------------------------------------- billing

#BillableDefinition: {
	id:           #Slug
	category:     #Slug
	unit:         string & !=""
	aggregation?: "sum" | "max" | "latest" | "unique-count"
	increment?:   #PositiveDecimal
	description?: string
	attributes?:  #StringMap
}

#RecurringCharge: {
	interval: "once" | "daily" | "weekly" | "monthly" | "yearly"
	amount:   #NonNegativeDecimal
	timing?:  "advance" | "arrears"
	per?:     #Slug
}

#RateTier: {
	upTo?:     #PositiveDecimal
	unitPrice: #NonNegativeDecimal
	flatFee?:  #NonNegativeDecimal
}

#TierList: {
	tiers: [...#RateTier] & [_, ...]
}

#PackageRate: {
	per:    #PositiveDecimal
	amount: #NonNegativeDecimal
	whole?: bool
}

#MeteredCharge: {
	billable:   #Slug
	timing?:    "advance" | "arrears"
	unitPrice?: #NonNegativeDecimal
	package?:   #PackageRate
	graduated?: #TierList
	volume?:    #TierList
	_hasRate: true & ((unitPrice != _|_) | (package != _|_) | (graduated != _|_) | (volume != _|_))
	if unitPrice != _|_ {
		package?: _|_
		graduated?: _|_
		volume?: _|_
	}
	if package != _|_ {
		unitPrice?: _|_
		graduated?: _|_
		volume?: _|_
	}
	if graduated != _|_ {
		unitPrice?: _|_
		package?: _|_
		volume?: _|_
	}
	if volume != _|_ {
		unitPrice?: _|_
		package?: _|_
		graduated?: _|_
	}
}

#ExternalCharge: {
	model:   #ExtensionName
	params?: #StringMap
}

#Charge: {
	id:           #Slug
	description?: string
	when?:        #StringMap
	recurring?:   #RecurringCharge
	metered?:     #MeteredCharge
	external?:    #ExternalCharge
	_hasModel: true & ((recurring != _|_) | (metered != _|_) | (external != _|_))
	if recurring != _|_ {
		metered?: _|_
		external?: _|_
	}
	if metered != _|_ {
		recurring?: _|_
		external?: _|_
	}
	if external != _|_ {
		recurring?: _|_
		metered?: _|_
	}
}

#IncludedUsage: {
	billable: #Slug
	quantity: #NonNegativeDecimal
	reset?:   "none" | "daily" | "weekly" | "monthly" | "yearly"
}

#BillingPlan: {
	id:           #Slug
	displayName?: string
	charges: [...#Charge] & [_, ...]
	included?: [...#IncludedUsage]
}

#BillingProduct: {
	id:           #Slug
	displayName?: string
	kind:         #Slug
	billables?: [...#Slug]
	plans: [...#BillingPlan] & [_, ...]
	attributes?: #StringMap
}

#BillingSection: {
	currency:        #Currency
	version:         string & !=""
	effectiveFrom:   #UtcTimestamp
	effectiveUntil?: #UtcTimestamp
	source:          #SourceRef
	billables: [...#BillableDefinition]
	products: [...#BillingProduct] & [_, ...]
}

#ProviderManifest: {
	schema:        "hobo.provider-manifest/v1"
	provider:      #ProviderIdentity
	auth?:         #AuthSection
	capabilities?: #CapabilitySection
	billing?:      #BillingSection
	// "At least one section" is enforced by src/parse.ts only. Written here as
	// a hidden constraint on the root definition, `cue vet -d` reported it
	// false for every document, valid fixtures included.
}
