package hobo

// CUE constraints for S3-02 @hobo/identity draft POC records.

#PrincipalRef: {
  kind: "user" | "agent" | "service" | "workload"
  id: string & != ""
}

#CodeVersion: {
  digest: =~"^sha256:[a-f0-9]{64}$"
  version: string & != ""
}

#ScopeEntry: {
  port: string & != ""
  resource: string & != ""
  verbs: [...string] & != []
}

#AttestationBinding: {
  runId: string & != ""
  tenant: string & != ""
  parentPrincipal: #PrincipalRef
  codeVersion: #CodeVersion
  componentImageDigest: =~"^sha256:[a-f0-9]{64}$"
}

#JwtSvidRecord: {
  identityId: string & != ""
  subject: =~"^spiffe://yard/"
  svidRef: =~"^tokenref://identity/svid/"
  scope: [...#ScopeEntry] & != []
  expiresAt: string & != ""
  signerKid: string & != ""
}

#IdentityIssuedEventData: {
  identityId: string & != ""
  subject: =~"^spiffe://yard/"
  svidRef: =~"^tokenref://identity/svid/"
  scope: [...#ScopeEntry] & != []
  expiresAt: string & != ""
}

#IdentityRotatedEventData: {
  identityId: string & != ""
  previousIdentityId: string & != ""
  subject: =~"^spiffe://yard/"
  svidRef: =~"^tokenref://identity/svid/"
  expiresAt: string & != ""
}

#IdentityServiceEvidence: {
  issue: string & != ""
  summary: string & != ""
  eventFamilies: [...string] & != []
}

// Token-broker constraints (S2-04).

#TokenScope: {
  port: string & != ""
  resource: string & != ""
  action: string & != ""
}

#VaultedCredentialRef: {
  reference: =~"^tokenref://"
}

#TokenGrantRecord: {
  grantId: string & != ""
  svidSubject: =~"^spiffe://yard/"
  svidIdentityId: string & != ""
  scope: #TokenScope
  deployId: string & != ""
  audience: string & != ""
  issuedAt: string & != ""
  expiresAt: string & != ""
  tokenRef: =~"^tokenref://broker/grant/"
  vaultReference: =~"^tokenref://"
  credentialSource: "oidc-federation" | "vault-static-key"
  providerTokenRef?: =~"^tokenref://provider/"
}

// S3-03 keyless token exchange constraints (one per new protobuf message).

#OidcFederationAssertion: {
  issuer: string & != ""
  subject: =~"^spiffe://yard/"
  audience: string & != ""
  scope: #TokenScope
  issuedAt: string & != ""
  expiresAt: string & != ""
}

#ProviderStsExchangeRequest: {
  oidcToken: =~"^hobo-oidc\\."
  audience: string & != ""
  subject: =~"^spiffe://yard/"
  scope: #TokenScope
  now: string & != ""
}

#ExchangedProviderCredential: {
  tokenRef: =~"^tokenref://provider/"
  flow: "oidc-federation"
  provider: string & != ""
  audience: string & != ""
  scope: #TokenScope
  issuedAt: string & != ""
  expiresAt: string & != ""
  expiresInSeconds: uint & >0
  narrowed: true
}

#TokenGrantedEventData: {
  grantId: string & != ""
  svidSubject: =~"^spiffe://yard/"
  svidIdentityId: string & != ""
  tokenRef: =~"^tokenref://broker/grant/"
  scope: #TokenScope
  expiresAt: string & != ""
}

#TokenUsedEventData: {
  grantId: string & != ""
  svidSubject: =~"^spiffe://yard/"
  tokenRef: =~"^tokenref://broker/grant/"
  scope: #TokenScope
}

#TokenRevokedEventData: {
  grantId: string & != ""
  svidSubject: =~"^spiffe://yard/"
  tokenRef: =~"^tokenref://broker/grant/"
  reason: string & != ""
}

// First-class Connection aggregate (broker-owned). credential_ref is opaque.
#ConnectionRecord: {
  schemaVersion: string & != ""
  id: string & != ""
  alias: string & != ""
  provider: string & != ""
  flow: "oidc-federation" | "oauth2-xaa" | "oauth2-obo" | "device-code" | "api-key" | "app-install"
  status: "pending" | "active" | "needs-reauth" | "revoked" | "expired"
  subject: #PrincipalRef
  installationId?: string
  grantedScopes: [...string]
  requestedScopes: [...string]
  credentialRef: =~"^tokenref://|^secref://|^vault://" | ""
  tenant: string & != ""
  createdAt: string & != ""
  updatedAt: string & != ""
  seq: uint
}

#ConnectionCreatedEventData: {
  connectionId: string & != ""
  alias: string & != ""
  provider: string & != ""
  flow: string & != ""
  subject: #PrincipalRef
  createdBy: #PrincipalRef
  requestedScopes: [...string]
  status: string & != ""
}

#ConnectionAuthorizedEventData: {
  connectionId: string & != ""
  grantedScopes: [...string]
  installationId?: string
  subject: #PrincipalRef
  credentialRef: string & != ""
  status: string & != ""
}

#ConnectionTokenIssuedEventData: {
  connectionId: string & != ""
  grantId: string & != ""
  tokenRef: =~"^tokenref://"
  scopes: [...string]
  expiresAt: string & != ""
}

// ADR-0027 secretless-first audit + schema shapes (refs only).
#ConfigResolvedEventData: {
  name: string & != ""
  source: "bound-resource" | "provider-federation" | "camp-value" | "static-escape"
  valueRef?: string
  subject?: string
  redacted: true
}

#SecretAccessedEventData: {
  name: string & != ""
  source: "bound-resource" | "provider-federation" | "camp-value" | "static-escape"
  valueRef: string & != ""
  versionId?: string
  subject?: string
  grantId?: string
  redacted: true
  plaintextPresent: false
}

#ConfigFieldRecord: {
  name: string & != ""
  type: "string" | "boolean" | "int" | "json"
  required: bool
  sensitive: bool
  source: "bound-resource" | "provider-federation" | "camp-value" | "static-escape"
  ttl?: =~"^[1-7]d$"
  rotation?: "required" | "optional"
}

// Continuous Identity Migration Plane (PrincipalRef continuity; dual-path).
#MappingSpecRecord: {
  schemaVersion: string & != ""
  id: string & != ""
  version: string & != ""
  contentHash: =~"^sha256:[a-f0-9]+$"
  sourceAdapter: string & != ""
  targetAdapter: string & != ""
  principalSubjectClaim: string & != ""
  allowNonCriticalDrift: bool
}

#IdentityMigrationRecord: {
  schemaVersion: string & != ""
  id: string & != ""
  tenant: string & != ""
  state: "idle" | "dual-active" | "shadow" | "ramping" | "quiescent" | "cutover" | "compensated" | "failed" | "aborted"
  reason: "adapter-change" | "residency" | "spectrum" | "policy" | "schema" | "yard-move"
  mode: "jit" | "shadow" | "background"
  sourceAdapter: string & != ""
  targetAdapter: string & != ""
  mappingSpecHash: string & != ""
  matchDecisionId?: string
  cohortFlagId: string & != ""
  rampPercent: uint & <= 100
  linkedPrincipals: uint
  failedChecks: uint
  createdAt: string & != ""
  updatedAt: string & != ""
  seq: uint
  outcomeReason?: string
}

#MigrationStartedEventData: {
  migrationId: string & != ""
  sourceAdapter: string & != ""
  targetAdapter: string & != ""
  reason: string & != ""
  mappingSpecHash: string & != ""
  mode: "jit" | "shadow" | "background"
  matchDecisionId?: string
}

#DualLinkedEventData: {
  migrationId: string & != ""
  principalRef: string & != ""
  sourceSubjectRef: string & != ""
  targetSubjectRef: string & != ""
}

#DualConsistencyCheckedEventData: {
  migrationId: string & != ""
  ok: bool
  checked: uint
  failed: uint
}

#MigratedEventData: {
  migrationId: string & != ""
  principalRef: string & != ""
  targetAdapter: string & != ""
}

#MigrationCutoverEventData: {
  migrationId: string & != ""
  linkedPrincipals: uint
}

#MigrationAbortedEventData: {
  migrationId: string & != ""
  reason: string & != ""
  code: string & != ""
}

#MigrationCompensatedEventData: {
  migrationId: string & != ""
  reason: string & != ""
  restoredAdapter: string & != ""
}

#CanMigrateResult: {
  schemaVersion: string & != ""
  ok: bool
  dimension: "can-migrate"
  summary: string & != ""
  mode: "jit" | "shadow" | "background"
  continuousDefault: true
  dryRun: true
  rollbackPosture: "compensate-to-source"
}

// Harness records (ADR-0044 / ADR-0083)
#FlagDefinitionRecord: {
	key:                         string
	default_value:               bool
	percentage:                  uint & >=0 & <=100
	enabled:                     bool
	state:                       "ENABLED" | "DISABLED"
	default_variant:             string
	kill_switch:                 bool
	migration_id?:               string
	auto_abort_on_dual_failure:  bool
	seq:                         uint
	updated_at:                  string
}

#FlagEvaluationRecord: {
	flag_key:        string
	variant:         string
	reason:          string
	ruleset_seq:     uint
	context_digest:  string
}

#RolloutTargetGroupRecord: {
	name:          string
	targets:       [...string] & [_, ...]
	concurrency?:  uint & >=1
	max_failures?: uint
	approval?:     bool
}

#RolloutResumePointRecord: {
	stage_index: uint
	group_index: uint
}

#RolloutPendingApprovalRecord: {
	stage_index: uint
	group_index: uint
	scope:       "stage" | "group"
}

#RolloutStageRecord: {
	percent:   uint & >=0 & <=100
	duration?: string
	// Staged extensions (append-only; absent = degenerate percent-only stage).
	groups?:             [...#RolloutTargetGroupRecord]
	concurrency?:        uint & >=1
	max_failures?:       uint
	approval?:           bool
	maintenance_window?: string
}

#RolloutPolicyRecord: {
	name:          string
	flag:          string
	stages:        [...#RolloutStageRecord]
	traffic:       "flag-only" | "gateway-weighted"
	auto_rollback: bool
}

#RolloutStateRecord: {
	id:                     string
	status:                 "running" | "promoted" | "rolled_back" | "failed" | "awaiting_approval" | "halted"
	stage_index:            uint
	percent:                uint & >=0 & <=100
	gateway_weight_percent: uint & >=0 & <=100
	// Staged extensions (append-only).
	group_index?:       uint
	completed_targets?: [...string]
	failed_targets?:    [...string]
	resume_from?:       #RolloutResumePointRecord
	pending_approval?:  #RolloutPendingApprovalRecord
}

#ExperimentDefinitionRecord: {
	name:     string
	flag:     string
	variants: [...string]
}

#ExperimentAssignmentRecord: {
	experiment:       string
	flag:             string
	variant:          string
	subject_key_hash: string
	assigned_at:      string
}
