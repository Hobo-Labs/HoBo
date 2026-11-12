package data_models

import (
	"list"
	"strconv"
	"strings"
)

// Constraints on every record of fleet.proto (design §7.2). One definition per
// message and enum, and a root #Fleet that is their disjunction; the fixture
// gate (`packages/schema-tools/src/cue.ts`) vets every fixture against #Fleet.
//
// Values are protobuf JSON as `toJson` writes it: lowerCamelCase field names,
// enums by name, 64-bit integers as decimal strings, bytes as base64. A field
// that holds its default value (empty string, zero, false, UNSPECIFIED, empty
// list or map) is absent, so every field is optional here and "set" means
// present. A field the record cannot do without is checked by a hidden
// `_need*` list: `cue vet` without `-c` accepts a missing plain field, but not
// a false presence test. `_x: [if x != _|_ {x}, <default>][0]` reads a field
// with its protobuf default, so a rule on a default-valued field is concrete.
//
// Closed definitions are the "no secret field" rule: a field that is not in
// fleet.proto (a private key, a seed, a password) makes a record invalid.

// ── Scalars ─────────────────────────────────────────────────────────────────

#U32: int & >=0 & <=4294967295
#U64: string & =~"^(0|[1-9][0-9]{0,19})$"
#Bytes: string & =~"^[A-Za-z0-9+/_-]*={0,2}$"
#Timestamp: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
#Sha256: string & =~"^sha256:[0-9a-f]{64}$"
#Hex64: string & =~"^[0-9a-f]{64}$"
#Base64Url32: string & =~"^[A-Za-z0-9_-]{43}$"
#Jwk: string & =~"^\\{.*\\}$"
#Text: string & =~"^\\S(.*\\S)?$"
#PrincipalRef: string & =~"^[a-z][a-z0-9-]*:\\S+$"
#Url: string & =~"^https://[^\\s/]+(/\\S*)?$"
#LoopbackUri: string & =~"^http://(127\\.0\\.0\\.1|\\[::1\\]):[0-9]{1,5}/"
#UserCode: string & =~"^[BCDFGHJKLMNPQRSTVWXZ]{8}$"
#DnsName: string & =~"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#Label: string & =~"^.{1,80}$"
#Transport: "p2p" | "overlay" | "bus-relay"

// ── Identifiers (§7.2) ──────────────────────────────────────────────────────

#MemberId: string & =~"^(dev|bkd|tgt)_[0-9a-f]{32}$"
#FleetId: string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"
#MemberName: string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"
// The core TenantId (`parseTenantId`): non-empty, stored trimmed.
#Tenant: string & =~"^\\S(.*\\S)?$"
#KeyId: string & =~"^((dev|bkd|tgt)_[0-9a-f]{32}#(identity|sign|seal|transport)|authority#[0-9]+|witness#[0-9]+)$"
#WorkDigest: string & =~"^[0-9a-f]{32}$"
#OrderId: string & =~"^[0-9a-f]{32}$"

// §7.4: the only contexts an envelope may carry.
#Context: "hobo-fleet/trust-record/v1" |
	"hobo-fleet/key-bundle/v1" |
	"hobo-fleet/rotation/v1" |
	"hobo-fleet/member-record/v1" |
	"hobo-fleet/fleet-record/v1" |
	"hobo-fleet/fleet-view/v1" |
	"hobo-fleet/session-ticket/v1" |
	"hobo-fleet/session-grant/v1" |
	"hobo-fleet/work-submission/v1" |
	"hobo-fleet/control/v1" |
	"hobo-fleet/audit-checkpoint/v1" |
	"hobo-fleet/nats-connect/v1" |
	"hobo-fleet/observation/v1" |
	"hobo-fleet/claim/v1" |
	"hobo-fleet/receipt/v1" |
	"hobo-fleet/log/v1" |
	"hobo-fleet/session-close/v1" |
	"hobo-fleet/offer/v1" |
	"hobo-fleet/order/v1" |
	"hobo-fleet/host-attestation/v1"

// §7.6: the closed error union.
#FleetErrorCode: "invalid-request" | "unauthenticated" | "proof-invalid" |
	"proof-replayed" | "forbidden" | "token-invalid" | "token-used" |
	"token-expired" | "fleet-unknown" | "member-unknown" | "work-unknown" |
	"fleet-policy" | "quota-exceeded" | "attestation-insufficient" |
	"key-known" | "approval-pending" | "member-suspended" | "member-locked" |
	"member-revoked" | "generation-mismatch" | "incarnation-stale" |
	"agent-outdated" | "conflict" | "residency-denied" | "evidence-invalid" |
	"sandbox-inadequate" | "order-invalid" | "assignment-mismatch" |
	"session-denied" | "no-majority" | "undecided" | "sign-in-pending" |
	"name-taken" | "unavailable"

// ── Enums ───────────────────────────────────────────────────────────────────

#KeyAlgorithm: "KEY_ALGORITHM_UNSPECIFIED" | "KEY_ALGORITHM_ES256" | "KEY_ALGORITHM_EDDSA"
#KeyPurpose: "KEY_PURPOSE_UNSPECIFIED" | "KEY_PURPOSE_IDENTITY" | "KEY_PURPOSE_SIGN" |
	"KEY_PURPOSE_SEAL" | "KEY_PURPOSE_TRANSPORT" | "KEY_PURPOSE_AUTHORITY" |
	"KEY_PURPOSE_WITNESS"
#MemberKind: "MEMBER_KIND_UNSPECIFIED" | "MEMBER_KIND_DEVICE" | "MEMBER_KIND_BACKEND" |
	"MEMBER_KIND_TARGET"
#MemberState: "MEMBER_STATE_UNSPECIFIED" | "MEMBER_STATE_PENDING" | "MEMBER_STATE_ACTIVE" |
	"MEMBER_STATE_SUSPENDED" | "MEMBER_STATE_LOCKED" | "MEMBER_STATE_REVOKED" |
	"MEMBER_STATE_REJECTED"
#DeviceClass: "DEVICE_CLASS_UNSPECIFIED" | "DEVICE_CLASS_PERSONAL" | "DEVICE_CLASS_DEDICATED" |
	"DEVICE_CLASS_EPHEMERAL"
#Role: "ROLE_UNSPECIFIED" | "ROLE_EXECUTOR" | "ROLE_DISPATCHER" | "ROLE_OBSERVER" |
	"ROLE_RECONCILER" | "ROLE_JUNCTION"
#AttestationTier: "ATTESTATION_TIER_UNSPECIFIED" | "ATTESTATION_TIER_T0_SOFTWARE_KEY" |
	"ATTESTATION_TIER_T1_HELD_KEY" | "ATTESTATION_TIER_T2_ORG_CERTIFIED" |
	"ATTESTATION_TIER_T3_PLATFORM_IDENTITY"
#SandboxTier: "SANDBOX_TIER_UNSPECIFIED" | "SANDBOX_TIER_S1_CONTAINER" |
	"SANDBOX_TIER_S2_USER_KERNEL" | "SANDBOX_TIER_S3_MICROVM"
#TrustClass: "TRUST_CLASS_UNSPECIFIED" | "TRUST_CLASS_OWN" | "TRUST_CLASS_ORG" |
	"TRUST_CLASS_UNTRUSTED"
#CoordinationMode: "COORDINATION_MODE_UNSPECIFIED" | "COORDINATION_MODE_MANY_ACTIVE" |
	"COORDINATION_MODE_ONE_ACTIVE"
#ApprovalMode: "APPROVAL_MODE_UNSPECIFIED" | "APPROVAL_MODE_AUTO_OWNER" | "APPROVAL_MODE_SINGLE" |
	"APPROVAL_MODE_DUAL"
#SessionPurpose: "SESSION_PURPOSE_UNSPECIFIED" | "SESSION_PURPOSE_SHELL" |
	"SESSION_PURPOSE_FORWARD" | "SESSION_PURPOSE_BLOB"
#Health: "HEALTH_UNSPECIFIED" | "HEALTH_REACHABLE" | "HEALTH_DRAINING" | "HEALTH_PRESSURED" |
	"HEALTH_UNREACHABLE" | "HEALTH_QUOTA_EXHAUSTED" | "HEALTH_AUTH" | "HEALTH_UNKNOWN"
#Availability: "AVAILABILITY_UNSPECIFIED" | "AVAILABILITY_LIVE" | "AVAILABILITY_UNHEALTHY" |
	"AVAILABILITY_LOST"
#VerdictState: "VERDICT_STATE_UNSPECIFIED" | "VERDICT_STATE_OPEN" | "VERDICT_STATE_NO_MEMBER" |
	"VERDICT_STATE_NO_CAPACITY"
#WorkOrigin: "WORK_ORIGIN_UNSPECIFIED" | "WORK_ORIGIN_INTERNAL" | "WORK_ORIGIN_FORK" |
	"WORK_ORIGIN_UNKNOWN"
#ReceiptStatus: "RECEIPT_STATUS_UNSPECIFIED" | "RECEIPT_STATUS_STARTED" |
	"RECEIPT_STATUS_SUCCEEDED" | "RECEIPT_STATUS_FAILED" | "RECEIPT_STATUS_CANCELLED" |
	"RECEIPT_STATUS_ABANDONED" | "RECEIPT_STATUS_REFUSED"
#ControlKind: "CONTROL_KIND_UNSPECIFIED" | "CONTROL_KIND_DRAIN" | "CONTROL_KIND_REFRESH_NOW" |
	"CONTROL_KIND_REVOKED" | "CONTROL_KIND_UPDATE_REQUIRED"

// Sandbox tiers in order, for "at least this tier".
#SandboxRank: {
	"SANDBOX_TIER_UNSPECIFIED":    0
	"SANDBOX_TIER_S1_CONTAINER":   1
	"SANDBOX_TIER_S2_USER_KERNEL": 2
	"SANDBOX_TIER_S3_MICROVM":     3
}

// ── Keys and signatures ─────────────────────────────────────────────────────

#PublicKeyRef: {
	purpose?:   #KeyPurpose & !="KEY_PURPOSE_UNSPECIFIED"
	keyId?:     #KeyId
	algorithm?: #KeyAlgorithm
	value?:     string & !=""
	_need: [purpose != _|_, keyId != _|_, value != _|_] & [...true]
}

#SignedEnvelope: {
	context?:   #Context
	keyId?:     #KeyId
	algorithm?: #KeyAlgorithm & !="KEY_ALGORITHM_UNSPECIFIED"
	payload?:   #Bytes
	signature?: #Bytes
	_need: [context != _|_, keyId != _|_, algorithm != _|_, payload != _|_, signature != _|_] & [...true]
}

#WitnessedEnvelope: {
	authority?: #SignedEnvelope & {keyId?: =~"^authority#"}
	witness?:   #SignedEnvelope & {keyId?: =~"^witness#"}
	_need: [authority != _|_, witness != _|_] & [...true]
}

#KeyBundle: {
	memberId?: #MemberId
	sequence?: #U32
	keys?: [...#PublicKeyRef]
	issuedAt?: #Timestamp
	notAfter?: #Timestamp
	_need: [memberId != _|_, keys != _|_, issuedAt != _|_, notAfter != _|_] & [...true]

	// Exactly one SIGN and one SEAL; at most one TRANSPORT; nothing else.
	_keys: [if keys != _|_ {keys}, []][0]
	_sign: [for k in _keys if k.purpose == "KEY_PURPOSE_SIGN" {k}] & [_]
	_seal: [for k in _keys if k.purpose == "KEY_PURPOSE_SEAL" {k}] & [_]
	_transport: [for k in _keys if k.purpose == "KEY_PURPOSE_TRANSPORT" {k}] & list.MaxItems(1)
	keys?: [...{purpose?: "KEY_PURPOSE_SIGN" | "KEY_PURPOSE_SEAL" | "KEY_PURPOSE_TRANSPORT"}]
}

#SealedBox: {
	recipientKeyId?:     #KeyId
	ephemeralPublicKey?: #Base64Url32
	// 12 bytes.
	nonce?:      string & =~"^[A-Za-z0-9+/_-]{16}$"
	ciphertext?: #Bytes
	_need: [recipientKeyId != _|_, ephemeralPublicKey != _|_, nonce != _|_, ciphertext != _|_] & [...true]
}

// ── Members ─────────────────────────────────────────────────────────────────

#Platform: {
	os?:   string & =~"^[a-z0-9_]{1,32}$"
	arch?: string & =~"^[a-z0-9_]{1,32}$"
	_need: [os != _|_, arch != _|_] & [...true]
}

#Membership: {
	fleet?: #FleetId
	name?:  #MemberName
	roles?: [...#Role & !="ROLE_UNSPECIFIED"] & list.UniqueItems()
	joinedAt?: #Timestamp
	_need: [fleet != _|_, name != _|_, joinedAt != _|_] & [...true]
}

#MemberRecord: {
	memberId?:    #MemberId
	tenant?:      #Tenant
	kind?:        #MemberKind & !="MEMBER_KIND_UNSPECIFIED"
	displayName?: string
	state?:       #MemberState & !="MEMBER_STATE_UNSPECIFIED"
	memberships?: [...#Membership]
	deviceClass?:        #DeviceClass
	attestationTier?:    #AttestationTier
	attestationDigest?:  #Sha256
	identityJwk?:        #Jwk
	identityThumbprint?: #Base64Url32
	retiredThumbprints?: [...#Base64Url32]
	keyBundle?: #SignedEnvelope & {context?: "hobo-fleet/key-bundle/v1"}
	platform?:     #Platform
	region?:       string
	agentVersion?: string
	owner?:        #PrincipalRef
	ownerAliases?: [...#PrincipalRef]
	sponsor?:              #Text
	credentialRef?:        #Text
	endpointDigest?:       #Sha256
	invitedBy?:            string
	keyApprovedBy?:        string
	acceptedBy?:           string
	enrolledAt?:           #Timestamp
	stateChangedAt?:       #Timestamp
	stateReason?:          string
	recordSequence?:       #U32
	authorityIncarnation?: #U32
	issuedAt?:             #Timestamp
	notAfter?:             #Timestamp
	_need: [memberId != _|_, tenant != _|_, kind != _|_, state != _|_, issuedAt != _|_, notAfter != _|_] & [...true]

	_kind: [if kind != _|_ {kind}, "MEMBER_KIND_UNSPECIFIED"][0]
	_state: [if state != _|_ {state}, "MEMBER_STATE_UNSPECIFIED"][0]
	_memberships: [if memberships != _|_ {memberships}, []][0]

	if _kind == "MEMBER_KIND_DEVICE" {
		memberId?:    =~"^dev_"
		deviceClass?: !="DEVICE_CLASS_UNSPECIFIED"
		sponsor?:     _|_
		_needDevice: [identityJwk != _|_, keyBundle != _|_, deviceClass != _|_] & [...true]
	}
	if _kind == "MEMBER_KIND_BACKEND" {
		memberId?: =~"^bkd_"
	}
	if _kind == "MEMBER_KIND_TARGET" {
		memberId?: =~"^tgt_"
	}
	if _kind == "MEMBER_KIND_BACKEND" || _kind == "MEMBER_KIND_TARGET" {
		identityJwk?:        _|_
		identityThumbprint?: _|_
		keyBundle?:          _|_
		state?:              !="MEMBER_STATE_LOCKED"
		memberships?: [...{roles?: _|_}]
		_needSponsored: [sponsor != _|_, credentialRef != _|_] & [...true]
	}
	if _state == "MEMBER_STATE_ACTIVE" {
		_activeMemberships: _memberships & list.MinItems(1)
	}
	// No two memberships name the same fleet.
	_fleets: [for m in _memberships {m.fleet}] & list.UniqueItems()
}

// ── Fleets ──────────────────────────────────────────────────────────────────

#RepositoryRule: {
	repository?: string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
	refs?: [...string & =~"^refs/\\S+$"]
	workflowDigests?: [...#Sha256]
	_need: [repository != _|_] & [...true]
}

#OidcTrustRule: {
	issuer?: #Url
	// Anchored at both ends.
	subjectPattern?: string & =~"^\\^.*\\$$"
	requiredClaims?: {[string]: string}
	roles?: [...#Role & !="ROLE_UNSPECIFIED"]
	sponsor?: bool
	_need: [issuer != _|_, subjectPattern != _|_] & [...true]
}

#ResidencyRule: {
	classifications?: [...#Text]
	allowedJurisdictions?: [...#Text]
	deniedJurisdictions?: [...#Text]
}

#FleetPolicy: {
	approval?: #ApprovalMode & !="APPROVAL_MODE_UNSPECIFIED"
	allowedKinds?: [...#MemberKind & !="MEMBER_KIND_UNSPECIFIED"] & list.UniqueItems()
	allowedRoles?: [...#Role & !="ROLE_UNSPECIFIED"] & list.UniqueItems()
	allowedClasses?: [...#DeviceClass & !="DEVICE_CLASS_UNSPECIFIED"] & list.UniqueItems()
	minAttestationTier?: #AttestationTier
	orgMinSandbox?:      #SandboxTier
	workKinds?: [...string & =~"^[a-z0-9][a-z0-9._-]{0,62}$"]
	repositories?: [...#RepositoryRule]
	oidcTrust?: [...#OidcTrustRule]
	deviceCaRootsPem?: [...string & =~"^-----BEGIN CERTIFICATE-----"]
	egressAllow?: [...#DnsName]
	memberQuotaPerPrincipal?: #U32
	minAgentVersion?:         string
	residency?:               #ResidencyRule
	allowHostDocker?:         bool
	sessionPurposes?: [...#SessionPurpose & !="SESSION_PURPOSE_UNSPECIFIED"]
	labels?: [...#Label]
	keyBundleHours?:   #U32 & <=720
	failoverAfterMs?:  #U32
	recoveryPointMs?:  #U32
	membershipEpochs?: bool
	_need: [approval != _|_] & [...true]

	// Host docker only on a fleet of dedicated devices alone.
	_allowHostDocker: [if allowHostDocker != _|_ {allowHostDocker}, false][0]
	if _allowHostDocker {
		allowedClasses?: ["DEVICE_CLASS_DEDICATED"]
		_needClasses: [allowedClasses != _|_] & [...true]
	}
	// A floor below S3 only for named repositories (S3 when unspecified).
	_orgMinSandbox: [if orgMinSandbox != _|_ {orgMinSandbox}, "SANDBOX_TIER_UNSPECIFIED"][0]
	if _orgMinSandbox == "SANDBOX_TIER_S1_CONTAINER" || _orgMinSandbox == "SANDBOX_TIER_S2_USER_KERNEL" {
		repositories?: list.MinItems(1)
		_needRepositories: [repositories != _|_] & [...true]
	}
}

#FleetRecord: {
	fleetId?:      #FleetId
	tenant?:       #Tenant
	owner?:        #PrincipalRef
	coordination?: #CoordinationMode & !="COORDINATION_MODE_UNSPECIFIED"
	policy?:       #FleetPolicy
	revision?:     #U32
	updatedAt?:    #Timestamp
	updatedBy?:    string
	issuedAt?:     #Timestamp
	notAfter?:     #Timestamp
	_need: [fleetId != _|_, tenant != _|_, coordination != _|_, policy != _|_, issuedAt != _|_, notAfter != _|_] & [...true]

	_coordination: [if coordination != _|_ {coordination}, "COORDINATION_MODE_UNSPECIFIED"][0]
	if _coordination == "COORDINATION_MODE_ONE_ACTIVE" {
		policy?: failoverAfterMs?: >0
		_kinds: [if policy.allowedKinds != _|_ {policy.allowedKinds}, []][0]
		_needOneActive: [policy.failoverAfterMs != _|_, list.Contains(_kinds, "MEMBER_KIND_BACKEND")] & [...true]
	}
	if _coordination != "COORDINATION_MODE_ONE_ACTIVE" {
		policy?: {
			membershipEpochs?: false
			recoveryPointMs?:  _|_
		}
	}
}

// ── Trust and discovery ─────────────────────────────────────────────────────

#TrustRecord: {
	tenant?:   #Tenant
	sequence?: #U32
	authorityKeys?: [...#PublicKeyRef & {purpose?: "KEY_PURPOSE_AUTHORITY", keyId?: =~"^authority#"}] & list.MinItems(1)
	witnessKeys?: [...#PublicKeyRef & {purpose?: "KEY_PURPOSE_WITNESS", keyId?: =~"^witness#"}] & list.MinItems(1)
	authorityIncarnation?: #U32
	issuer?:               #Url
	jwksUri?:              #Url
	issuedAt?:             #Timestamp
	_need: [tenant != _|_, authorityKeys != _|_, witnessKeys != _|_, issuer != _|_, issuedAt != _|_] & [...true]
}

#AuthorityDiscovery: {
	issuer?:  #Url
	jwksUri?: #Url
	signInProviders?: [...string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"]
	_need: [issuer != _|_, jwksUri != _|_] & [...true]
}

#Discovery: {
	tenant?: #Tenant
	issuer?: #Url
	natsUrls?: [...string & =~"^(nats|tls|ws|wss)://\\S+$"]
	natsSentinelCredentials?: string
	relayUrls?: [...#Url]
	trust?: #WitnessedEnvelope & {authority?: context?: "hobo-fleet/trust-record/v1", witness?: context?: "hobo-fleet/trust-record/v1"}
	minAgentVersion?: string
	_need: [tenant != _|_, issuer != _|_, trust != _|_] & [...true]
}

// ── People ──────────────────────────────────────────────────────────────────

#SignInStart: {
	provider?:       string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"
	tenant?:         #Tenant
	redirectUri?:    #LoopbackUri
	codeChallenge?:  #Base64Url32
	dpopThumbprint?: #Base64Url32
	deviceFlow?:     bool
	hostName?:       string
	deviceName?:     string
	platform?:       #Platform
	_need: [provider != _|_, codeChallenge != _|_, dpopThumbprint != _|_] & [...true]

	// redirect_uri empty exactly when device_flow.
	_deviceFlow: [if deviceFlow != _|_ {deviceFlow}, false][0]
	if _deviceFlow {
		redirectUri?: _|_
	}
	if !_deviceFlow {
		_needRedirect: [redirectUri != _|_] & [...true]
	}
}

#SignInChallenge: {
	state?:           #Text
	authorizeUrl?:    #Url
	userCode?:        #UserCode
	verificationUrl?: #Url
	expiresAt?:       #Timestamp
	intervalSeconds?: #U32
	_need: [state != _|_, expiresAt != _|_] & [...true]
}

#SignInComplete: {
	state?:        #Text
	code?:         #Text
	codeVerifier?: string & =~"^[A-Za-z0-9._~-]{43,128}$"
	_need: [state != _|_, code != _|_, codeVerifier != _|_] & [...true]
}

#PersonCredential: {
	token?:        #Text
	expiresAt?:    #Timestamp
	refreshUntil?: #Timestamp
	principal?:    #PrincipalRef
	tenant?:       #Tenant
	tags?: [...#Text]
	_need: [token != _|_, expiresAt != _|_, principal != _|_, tenant != _|_] & [...true]
}

#SignInCallback: {
	state?: #Text
	code?:  #Text
	error?: #Text
	_need: [state != _|_] & [...true]
	// The provider answers with a code or an error, not both.
	_outcome: [if code != _|_ {code}, if error != _|_ {error}] & [_]
}

#SignInDeviceCode: {
	userCode?: #UserCode
	_need: [userCode != _|_] & [...true]
}

#ApprovalView: {
	state?:     #Text
	principal?: #PrincipalRef
	hostName?:  string
	deviceName?: string
	platform?:  #Platform
	fingerprintWords?: [...string & =~"^[a-z]{1,16}$"]
	deviceFlow?: bool
	expiresAt?:  #Timestamp
	_need: [state != _|_, principal != _|_, fingerprintWords != _|_, expiresAt != _|_] & [...true]
	_words: [if fingerprintWords != _|_ {fingerprintWords}, []][0] & [_, _, _, _]
}

#ApprovalDecision: {
	state?:   #Text
	approve?: bool
	_need: [state != _|_] & [...true]
}

#ApprovalResult: {
	redirectUri?: #LoopbackUri
}

#SignInPoll: {
	state?: #Text
	_need: [state != _|_] & [...true]
}

#SignInRefresh: {}

// ── Enrollment and credentials ──────────────────────────────────────────────

#TokenCreateRequest: {
	fleet?:       #FleetId
	name?:        #MemberName
	displayName?: string
	deviceClass?: #DeviceClass & !="DEVICE_CLASS_UNSPECIFIED"
	roles?: [...#Role & !="ROLE_UNSPECIFIED"] & list.UniqueItems()
	ttlSeconds?: #U32 & >=600 & <=1800
	_need: [fleet != _|_, name != _|_, ttlSeconds != _|_] & [...true]
}

#TokenCreateResponse: {
	token?:     string & =~"^hft_[A-Za-z0-9_-]{43}$"
	tokenHash?: #Hex64
	expiresAt?: #Timestamp
	_need: [token != _|_, tokenHash != _|_, expiresAt != _|_] & [...true]
}

#BootstrapTokenRecord: {
	tokenHash?:   #Hex64
	fleet?:       #FleetId
	name?:        #MemberName
	deviceClass?: #DeviceClass
	roles?: [...#Role & !="ROLE_UNSPECIFIED"]
	issuedBy?:   #PrincipalRef
	expiresAt?:  #Timestamp
	consumedBy?: #MemberId
	_need: [tokenHash != _|_, fleet != _|_, name != _|_, issuedBy != _|_, expiresAt != _|_] & [...true]
}

#TokenList: {
	tokens?: [...#BootstrapTokenRecord]
}

#EnrollmentRequest: {
	tenant?:       #Tenant
	fleet?:        #FleetId
	name?:         #MemberName
	displayName?:  string
	identityJwk?:  #Jwk
	keyBundle?:    #SignedEnvelope & {context?: "hobo-fleet/key-bundle/v1"}
	platform?:     #Platform
	region?:       string
	agentVersion?: string
	deviceClass?:  #DeviceClass & !="DEVICE_CLASS_UNSPECIFIED"
	requestedRoles?: [...#Role & !="ROLE_UNSPECIFIED"] & list.UniqueItems()
	bootstrapToken?: string & =~"^hft_[A-Za-z0-9_-]{43}$"
	oidcAssertion?:  string & =~"^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$"
	personToken?:    #Text
	certificateChainPem?: [...string & =~"^-----BEGIN CERTIFICATE-----"]
	heldKey?: bool
	_need: [tenant != _|_, fleet != _|_, name != _|_, identityJwk != _|_, keyBundle != _|_, deviceClass != _|_] & [...true]
	// The `proof` oneof: exactly one.
	_proof: [if bootstrapToken != _|_ {1}, if oidcAssertion != _|_ {1}, if personToken != _|_ {1}] & [_]
}

#DeclareRequest: {
	tenant?:         #Tenant
	fleet?:          #FleetId
	kind?:           "MEMBER_KIND_BACKEND" | "MEMBER_KIND_TARGET"
	name?:           #MemberName
	displayName?:    string
	credentialRef?:  #Text
	endpointDigest?: #Sha256
	region?:         string
	_need: [tenant != _|_, fleet != _|_, kind != _|_, name != _|_, credentialRef != _|_] & [...true]
}

#OverlayJoin: {
	provider?:   "tailscale" | "netbird"
	credential?: #Text
	expiresAt?:  #Timestamp
	tags?: [...#Text]
	_need: [provider != _|_, credential != _|_, expiresAt != _|_] & [...true]
}

#EnrollmentResponse: {
	memberRecord?: #SignedEnvelope & {context?: "hobo-fleet/member-record/v1"}
	overlayJoins?: [...#OverlayJoin]
	discovery?: #Discovery
	_need: [memberRecord != _|_] & [...true]
}

#LifecycleRequest: {
	reason?: string
	fleets?: [...#FleetId] & list.UniqueItems()
}

#MembershipRequest: {
	fleet?: #FleetId
	name?:  #MemberName
	roles?: [...#Role & !="ROLE_UNSPECIFIED"] & list.UniqueItems()
	_need: [fleet != _|_, name != _|_] & [...true]
}

#CredentialRequest: {
	generation?: #U32
	// 16 bytes.
	refreshNonce?: string & =~"^[A-Za-z0-9+/_-]{22}(==)?$"
	audiences?: [...#Text]
	keyBundle?:    #SignedEnvelope & {context?: "hobo-fleet/key-bundle/v1"}
	agentVersion?: string
	_need: [refreshNonce != _|_] & [...true]
}

#SessionTicket: {
	ticketId?:             #Text
	memberId?:             #MemberId
	tenant?:               #Tenant
	issuedAt?:             #Timestamp
	expiresAt?:            #Timestamp
	authorityIncarnation?: #U32
	_need: [ticketId != _|_, memberId != _|_, tenant != _|_, issuedAt != _|_, expiresAt != _|_] & [...true]
}

#ConnectProof: {
	ticketId?: #Text
	nonce?:    #Bytes
	_need: [ticketId != _|_, nonce != _|_] & [...true]
}

#ConnectToken: {
	ticket?: #SignedEnvelope & {context?: "hobo-fleet/session-ticket/v1"}
	proof?:  #SignedEnvelope & {context?: "hobo-fleet/nats-connect/v1"}
	_need: [ticket != _|_, proof != _|_] & [...true]
}

#CredentialResponse: {
	svid?:          #Text
	svidExpiresAt?: #Timestamp
	sessionTicket?: #SignedEnvelope & {context?: "hobo-fleet/session-ticket/v1"}
	generation?:    #U32
	memberRecord?:  #SignedEnvelope & {context?: "hobo-fleet/member-record/v1"}
	trust?: #WitnessedEnvelope & {authority?: context?: "hobo-fleet/trust-record/v1", witness?: context?: "hobo-fleet/trust-record/v1"}
	_need: [svid != _|_, svidExpiresAt != _|_, sessionTicket != _|_] & [...true]
}

#RotationStatement: {
	memberId?:       #MemberId & =~"^dev_"
	newIdentityJwk?: #Jwk
	at?:             #Timestamp
	_need: [memberId != _|_, newIdentityJwk != _|_, at != _|_] & [...true]
}

#KeyRotationRequest: {
	keyBundle?: #SignedEnvelope & {context?: "hobo-fleet/key-bundle/v1"}
	rotation?:  #SignedEnvelope & {context?: "hobo-fleet/rotation/v1"}
	_need: [keyBundle != _|_] & [...true]
}

// ── Observations ────────────────────────────────────────────────────────────

#Capacity: {
	freeSlots?:    #U32
	totalSlots?:   #U32
	freeMemoryMb?: #U32 & <=16777216
	freeDiskMb?:   #U32 & <=1073741824
	if totalSlots != _|_ {
		freeSlots?: <=totalSlots
	}
}

#UsageMeasurement: {
	unit?: string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"
	used?: number & >=0
	_need: [unit != _|_] & [...true]
}

#ReliabilitySamples: {
	delivered?: number & >=0
	dropped?:   number & >=0
}

#Observation: {
	memberId?:   #MemberId
	observerId?: #MemberId
	fleets?: [...#FleetId] & list.UniqueItems()
	health?:         #Health & !="HEALTH_UNSPECIFIED"
	failingForMs?:   #U32
	probeLatencyMs?: #U32
	capacity?:       #Capacity
	ready?:          bool
	lagMs?:          #U32
	usage?: [...#UsageMeasurement]
	labels?: [...#Label] & list.MaxItems(32)
	platform?: #Platform
	sandboxTiers?: [...#SandboxTier & !="SANDBOX_TIER_UNSPECIFIED"] & list.UniqueItems()
	agentVersion?: string
	transports?: [...#Transport] & list.UniqueItems()
	region?:         string
	bundleSequence?: #U32
	since?:          #Timestamp
	issuedAt?:       #Timestamp
	validUntil?:     #Timestamp
	_need: [memberId != _|_, observerId != _|_, health != _|_, issuedAt != _|_, validUntil != _|_] & [...true]

	_health: [if health != _|_ {health}, "HEALTH_UNSPECIFIED"][0]
	if _health == "HEALTH_REACHABLE" {
		failingForMs?: 0
	}
}

#FleetMemberView: {
	memberId?:        #MemberId
	name?:            #MemberName
	displayName?:     string
	kind?:            #MemberKind & !="MEMBER_KIND_UNSPECIFIED"
	state?:           #MemberState & !="MEMBER_STATE_UNSPECIFIED"
	availability?:    #Availability
	health?:          #Health
	capacity?:        #Capacity
	platform?:        #Platform
	attestationTier?: #AttestationTier
	sandboxTiers?: [...#SandboxTier & !="SANDBOX_TIER_UNSPECIFIED"] & list.UniqueItems()
	reliability?:  number & >0 & <=1
	samples?:      #ReliabilitySamples
	since?:        #Timestamp
	lastSeen?:     #Timestamp
	agentVersion?: string
	labels?: [...#Label] & list.MaxItems(32)
	deviceClass?: #DeviceClass
	roles?: [...#Role & !="ROLE_UNSPECIFIED"] & list.UniqueItems()
	_need: [memberId != _|_, name != _|_, kind != _|_, state != _|_] & [...true]
}

#FleetCapacity: {
	live?:         #U32
	healthy?:      #U32
	totalSlots?:   #U32
	freeSlots?:    #U32
	freeMemoryMb?: #U32
	freeDiskMb?:   #U32
	maxMemoryMb?:  #U32
	_live: [if live != _|_ {live}, 0][0]
	_total: [if totalSlots != _|_ {totalSlots}, 0][0]
	healthy?:   <=_live
	freeSlots?: <=_total
}

#FleetView: {
	fleet?: #FleetId
	members?: [...#FleetMemberView] & list.MaxItems(256)
	capacity?:  #FleetCapacity
	truncated?: bool
	asOf?:      #Timestamp
	notAfter?:  #Timestamp
	_need: [fleet != _|_, asOf != _|_, notAfter != _|_] & [...true]
}

#FleetVerdict: {
	fleet?:     #FleetId
	label?:     #Label
	state?:     #VerdictState & !="VERDICT_STATE_UNSPECIFIED"
	members?:   #U32
	freeSlots?: #U32
	asOf?:      #Timestamp
	expiresAt?: #Timestamp
	_need: [fleet != _|_, state != _|_, asOf != _|_, expiresAt != _|_] & [...true]

	_state: [if state != _|_ {state}, "VERDICT_STATE_UNSPECIFIED"][0]
	if _state == "VERDICT_STATE_NO_MEMBER" {
		members?: 0
	}
	if _state == "VERDICT_STATE_NO_CAPACITY" {
		members?:   >0
		freeSlots?: 0
		_needMembers: [members != _|_] & [...true]
	}
}

// ── Many-active work ────────────────────────────────────────────────────────

#WorkNeeds: {
	memoryMb?: #U32
	diskMb?:   #U32
	platform?: #Platform
	labels?: [...#Label] & list.MaxItems(32)
	docker?:     bool
	minSandbox?: #SandboxTier
}

#WorkSubmission: {
	submissionId?: #Text
	tenant?:       #Tenant
	fleet?:        #FleetId
	author?:       #PrincipalRef
	image?:        #Text
	imageDigest?:  #Sha256
	argv?: [...string]
	env?: {[string]: string}
	needs?: #WorkNeeds
	egressAllow?: [...#DnsName]
	submittedAt?: #Timestamp
	expiresAt?:   #Timestamp
	_need: [submissionId != _|_, tenant != _|_, fleet != _|_, author != _|_, image != _|_, imageDigest != _|_, submittedAt != _|_, expiresAt != _|_] & [...true]
}

#WorkOffer: {
	workKey?:        #Text
	workDigest?:     #WorkDigest
	kind?:           string & =~"^[a-z0-9][a-z0-9._-]{0,62}$"
	fleet?:          #FleetId
	label?:          #Label
	needs?:          #WorkNeeds
	trustClass?:     "TRUST_CLASS_ORG" | "TRUST_CLASS_UNTRUSTED"
	author?:         #PrincipalRef
	origin?:         #WorkOrigin
	repository?:     string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
	ref?:            string & =~"^refs/\\S+$"
	workflowDigest?: #Sha256
	queuedAt?:       #Timestamp
	expiresAt?:      #Timestamp
	dispatcher?:     #MemberId & =~"^dev_"
	residency?:      #ResidencyRule
	submission?:     #SignedEnvelope & {context?: "hobo-fleet/work-submission/v1"}
	_need: [workKey != _|_, workDigest != _|_, kind != _|_, fleet != _|_, trustClass != _|_, expiresAt != _|_, dispatcher != _|_] & [...true]

	_origin: [if origin != _|_ {origin}, "WORK_ORIGIN_UNSPECIFIED"][0]
	if _origin != "WORK_ORIGIN_INTERNAL" {
		trustClass?: "TRUST_CLASS_UNTRUSTED"
	}
	_trustClass: [if trustClass != _|_ {trustClass}, "TRUST_CLASS_UNSPECIFIED"][0]
	if _trustClass == "TRUST_CLASS_UNTRUSTED" {
		needs?: minSandbox?: "SANDBOX_TIER_S3_MICROVM"
		_needMicroVm: [needs.minSandbox != _|_] & [...true]
	}
}

#Claim: {
	workDigest?:     #WorkDigest
	fleet?:          #FleetId
	memberId?:       #MemberId & =~"^dev_"
	dispatcher?:     #MemberId & =~"^dev_"
	offerExpiresAt?: #Timestamp
	rank?:           #U32
	sandboxTier?:    #SandboxTier
	claimedAt?:      #Timestamp
	_need: [workDigest != _|_, fleet != _|_, memberId != _|_, dispatcher != _|_, claimedAt != _|_] & [...true]
}

#WorkOrder: {
	orderId?:     #OrderId
	offer?:       #WorkOffer
	memberId?:    #MemberId & =~"^dev_"
	sandboxTier?: #SandboxTier
	egressAllow?: [...#DnsName]
	parameters?: {[string]: string}
	secret?:    #SealedBox
	issuedAt?:  #Timestamp
	expiresAt?: #Timestamp
	_need: [orderId != _|_, offer != _|_, memberId != _|_, issuedAt != _|_, expiresAt != _|_] & [...true]

	// The order's tier is at least what the offer needs.
	_tier: [if sandboxTier != _|_ {sandboxTier}, "SANDBOX_TIER_UNSPECIFIED"][0]
	_minTier: [if offer.needs.minSandbox != _|_ {offer.needs.minSandbox}, "SANDBOX_TIER_UNSPECIFIED"][0]
	_tierCovers: (#SandboxRank[_tier] >= #SandboxRank[_minTier]) & true
}

#WorkReceipt: {
	orderId?:         #OrderId
	workDigest?:      #WorkDigest
	memberId?:        #MemberId & =~"^dev_"
	status?:          #ReceiptStatus & !="RECEIPT_STATUS_UNSPECIFIED"
	reason?:          #FleetErrorCode
	at?:              #Timestamp
	sandboxTier?:     #SandboxTier
	trustClass?:      #TrustClass
	sandboxSeconds?:  #U32
	outputDigest?:    #Sha256
	observedWorkKey?: #Text
	_need: [orderId != _|_, workDigest != _|_, memberId != _|_, status != _|_, at != _|_] & [...true]
}

#WorkLogChunk: {
	orderId?:  #OrderId
	sequence?: #U32
	// At most 64 KiB.
	data?: #Bytes & strings.MaxRunes(87384)
	last?: bool
	_need: [orderId != _|_] & [...true]
}

#WorkSubmissionRequest: {
	fleet?:       #FleetId
	image?:       #Text
	imageDigest?: #Sha256
	argv?: [...string]
	env?: {[string]: string}
	needs?: #WorkNeeds
	egressAllow?: [...#DnsName]
	ttlSeconds?: #U32
	_need: [fleet != _|_, image != _|_, imageDigest != _|_] & [...true]
}

#WorkStatus: {
	submissionId?: #Text
	workDigest?:   #WorkDigest
	memberId?:     #MemberId
	status?:       #ReceiptStatus
	reason?:       #FleetErrorCode
	outputDigest?: #Sha256
	updatedAt?:    #Timestamp
	_need: [submissionId != _|_, updatedAt != _|_] & [...true]
}

#WorkLogs: {
	chunks?: [...#WorkLogChunk]
	complete?: bool
}

#ViolationReport: {
	kind?:  "claim-not-entitled" | "claim-early"
	offer?: #SignedEnvelope & {context?: "hobo-fleet/offer/v1"}
	claims?: [...#SignedEnvelope & {context?: "hobo-fleet/claim/v1"}]
	_need: [kind != _|_, offer != _|_, claims != _|_] & [...true]

	_kind: [if kind != _|_ {kind}, ""][0]
	_claims: [if claims != _|_ {claims}, []][0]
	if _kind == "claim-not-entitled" {
		_oneClaim: _claims & [_]
	}
	if _kind == "claim-early" {
		_threeClaims: _claims & [_, _, _]
	}
}

// ── One-active assignment ───────────────────────────────────────────────────

// Fields 1-8 keep the patterns of hobo.backend_fleet.v1.FleetAssignment.
#Assignment: {
	epoch?:        #U64 & =~"^[1-9]"
	active?:       #MemberName
	sealed?:       bool
	target?:       #MemberName
	reason?:       string & =~"^[a-z0-9][a-z0-9:._ -]{0,199}$"
	lossWindowMs?: #U64
	decidedAtMs?:  #U64
	decidedBy?:    string & =~"^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$"
	members?: [...#MemberName] & list.MinItems(1) & list.UniqueItems() & list.IsSorted(list.Ascending)
	_need: [epoch != _|_, reason != _|_, decidedBy != _|_] & [...true]

	// `sealed` exactly when `target` is set, and never to where it already is.
	_sealed: [if sealed != _|_ {sealed}, false][0]
	if _sealed {
		_needTarget: [target != _|_] & [...true]
		if active != _|_ {
			target?: !=active
		}
	}
	if !_sealed {
		target?: _|_
	}
	// A membership change names the set that decides the next epoch.
	_reason: [if reason != _|_ {reason}, ""][0]
	if _reason =~ "^(admit|remove):" {
		_needMembers: [members != _|_] & [...true]
	}
}

#AssignmentLog: {
	format?: 1 | 2
	entries?: [...#Assignment]
	_need: [format != _|_] & [...true]

	_entries: [if entries != _|_ {entries}, []][0]
	_format: [if format != _|_ {format}, 0][0]
	if _format == 1 {
		entries?: [...{members?: _|_}]
	}
	// Ascending by epoch with no gap.
	_epochs: [for e in _entries {strconv.ParseUint(e.epoch, 10, 64)}]
	_steps: [for i, n in _epochs if i > 0 {n - _epochs[i-1]}] & [...1]
}

// ── Transport ───────────────────────────────────────────────────────────────

#SessionParty: {
	memberId?:          #MemberId
	principal?:         #PrincipalRef
	transportIdentity?: #Text
	sealPublicKey?:     #Base64Url32
	_need: [transportIdentity != _|_, sealPublicKey != _|_] & [...true]
	// A member, or a person's CLI.
	_party: [if memberId != _|_ {1}, if principal != _|_ {1}] & list.MinItems(1)
}

#SessionRequest: {
	peer?:    #MemberId
	purpose?: #SessionPurpose & !="SESSION_PURPOSE_UNSPECIFIED"
	orderId?: #OrderId
	port?:    #U32
	blobDigests?: [...#Sha256]
	initiator?:  #SessionParty
	ttlSeconds?: #U32 & <=3600
	_need: [peer != _|_, purpose != _|_] & [...true]

	_purpose: [if purpose != _|_ {purpose}, "SESSION_PURPOSE_UNSPECIFIED"][0]
	if _purpose == "SESSION_PURPOSE_FORWARD" {
		port?: >=1 & <=65535
		_needPort: [port != _|_] & [...true]
	}
	if _purpose == "SESSION_PURPOSE_BLOB" {
		blobDigests?: list.MinItems(1)
		_needBlobs: [blobDigests != _|_] & [...true]
	}
}

#SessionGrant: {
	sessionId?: #Text
	tenant?:    #Tenant
	initiator?: #SessionParty
	acceptor?:  #SessionParty
	purpose?:   #SessionPurpose & !="SESSION_PURPOSE_UNSPECIFIED"
	orderId?:   #OrderId
	port?:      #U32
	blobDigests?: [...#Sha256]
	issuedAt?:  #Timestamp
	expiresAt?: #Timestamp
	_need: [sessionId != _|_, tenant != _|_, initiator != _|_, acceptor != _|_, purpose != _|_, issuedAt != _|_, expiresAt != _|_] & [...true]

	_purpose: [if purpose != _|_ {purpose}, "SESSION_PURPOSE_UNSPECIFIED"][0]
	if _purpose == "SESSION_PURPOSE_FORWARD" {
		port?: >=1 & <=65535
		_needPort: [port != _|_] & [...true]
	}
	if _purpose == "SESSION_PURPOSE_BLOB" {
		blobDigests?: list.MinItems(1)
		_needBlobs: [blobDigests != _|_] & [...true]
	}
}

#SessionClose: {
	sessionId?:     #Text
	memberId?:      #MemberId
	transport?:     #Transport
	bytesSent?:     #U64
	bytesReceived?: #U64
	at?:            #Timestamp
	_need: [sessionId != _|_, memberId != _|_, at != _|_] & [...true]
}

// ── Control, audit, lists, errors ───────────────────────────────────────────

#MemberControl: {
	memberId?: #MemberId
	kind?:     #ControlKind & !="CONTROL_KIND_UNSPECIFIED"
	reason?:   string
	at?:       #Timestamp
	_need: [memberId != _|_, kind != _|_, at != _|_] & [...true]
}

#AuditEntry: {
	sequence?:        #U32
	previousHash?:    #Hex64
	eventType?:       string & =~"^(fleet|policy)\\.[A-Z][A-Za-z]+$"
	eventId?:         #Text
	subject?:         #Text
	actor?:           #Text
	at?:              #Timestamp
	dataDigest?:      #Hex64
	subjectSequence?: #U32
	_need: [previousHash != _|_, eventType != _|_, eventId != _|_, subject != _|_, actor != _|_, at != _|_, dataDigest != _|_] & [...true]
}

#AuditCheckpoint: {
	sequence?:             #U32
	entryHash?:            #Hex64
	at?:                   #Timestamp
	authorityIncarnation?: #U32
	_need: [entryHash != _|_, at != _|_] & [...true]
}

#AuditEntries: {
	entries?: [...#AuditEntry]
}

#AuditCheckpoints: {
	checkpoints?: [...#WitnessedEnvelope & {authority?: context?: "hobo-fleet/audit-checkpoint/v1", witness?: context?: "hobo-fleet/audit-checkpoint/v1"}]
}

#MemberList: {
	members?: [...#SignedEnvelope & {context?: "hobo-fleet/member-record/v1"}]
}

#FleetList: {
	fleets?: [...#SignedEnvelope & {context?: "hobo-fleet/fleet-record/v1"}]
}

#FleetError: {
	code?:    #FleetErrorCode
	message?: string
	detail?: {[string]: string}
	_need: [code != _|_] & [...true]
}

// ── Root ────────────────────────────────────────────────────────────────────

// Every message and enum. Two messages can share an encoding byte for byte
// (a refused ApprovalDecision is `{"state": …}`, the same as a SignInPoll;
// an empty Capacity is `{}`, the same as a SignInRefresh); the two marked
// defaults only break those ties, so `cue vet` can answer for such a value.
#Fleet: #PublicKeyRef | #SignedEnvelope | #WitnessedEnvelope | #KeyBundle | #SealedBox |
	#Platform | #Membership | #MemberRecord |
	#RepositoryRule | #OidcTrustRule | #ResidencyRule | #FleetPolicy | #FleetRecord |
	#TrustRecord | #AuthorityDiscovery | #Discovery |
	#SignInStart | #SignInChallenge | #SignInComplete | #PersonCredential | #SignInCallback |
	#SignInDeviceCode | #ApprovalView | #ApprovalDecision | #ApprovalResult | *#SignInPoll |
	#SignInRefresh |
	#TokenCreateRequest | #TokenCreateResponse | #BootstrapTokenRecord | #TokenList |
	#EnrollmentRequest | #DeclareRequest | #OverlayJoin | #EnrollmentResponse |
	#LifecycleRequest | #MembershipRequest | #CredentialRequest | #SessionTicket |
	#ConnectProof | #ConnectToken | #CredentialResponse | #RotationStatement |
	#KeyRotationRequest |
	*#Capacity | #UsageMeasurement | #ReliabilitySamples | #Observation | #FleetMemberView |
	#FleetCapacity | #FleetView | #FleetVerdict |
	#WorkNeeds | #WorkSubmission | #WorkOffer | #Claim | #WorkOrder | #WorkReceipt |
	#WorkLogChunk | #WorkSubmissionRequest | #WorkStatus | #WorkLogs | #ViolationReport |
	#Assignment | #AssignmentLog |
	#SessionParty | #SessionRequest | #SessionGrant | #SessionClose |
	#MemberControl | #AuditEntry | #AuditCheckpoint | #AuditEntries | #AuditCheckpoints |
	#MemberList | #FleetList | #FleetError |
	#KeyAlgorithm | #KeyPurpose | #MemberKind | #MemberState | #DeviceClass | #Role |
	#AttestationTier | #SandboxTier | #TrustClass | #CoordinationMode | #ApprovalMode |
	#SessionPurpose | #Health | #Availability | #VerdictState | #WorkOrigin |
	#ReceiptStatus | #ControlKind
