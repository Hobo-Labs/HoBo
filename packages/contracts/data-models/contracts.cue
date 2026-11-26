package hobo

// CUE constraints for the @hobo/contracts wire records (S2-07). One constraint
// definition per protobuf message/enum in contracts.proto.

#ContractMode: "declared" | "inferred" | "observed" | "promoted"

#GatekeeperEffect: "allow" | "allow-degraded" | "deny" | "require-approval"

#ContractEdge: {
  kind: "http" | "event" | "message" | "topic" | "resource-binding" |
        "capability-scope" | "runtime-slo" | "semantic-function" |
        "agent-tool" | "provider-interface" | "service" | "actor" | "workflow"
  producer:  string & != ""
  consumer:  string & != ""
  channel:   string & != ""
  operation: string & != ""
}

#RequiredShape: {
  format:         string & != ""
  requiredFields: [...string]
  providedFields: [...string]
}

#PurityLevel: "pure" | "varies" | "transacts" | "noRollback"

#CapabilityEffect: "decides" | "suspends" | "allocates" | "concurrent"

#DomainEffect: "network" | "storage" | "identity" | "policyEval" | "eventEmit" |
	"metering" | "overlayTunnel" | "iac" | "secretsResidual" | "clock" |
	"externalCall" | "agentTool"

#EffectSpec: {
  schemaVersion: "hobo.effect-spec/v1"
  purity:        #PurityLevel
  capabilities:  [...#CapabilityEffect]
  domains:       [...#DomainEffect]
}

#ResilienceStrategy: {
  kind: "retry" | "circuitBreaker" | "timeout" | "bulkhead" | "fallback" | "hedging"
  ...
}

#ResilienceProfile: {
  schemaVersion: "hobo.resilience-profile/v1"
  id:            string & != ""
  strategies:    [...#ResilienceStrategy]
  neverRetry:    [...("policy.Decided" | "terminal" | "cancellation")]
}

#EffectManifest: {
  schemaVersion:    "hobo.effect-manifest/v1"
  contractId:       string & != ""
  contractVersion:  string & != ""
  channel:          string & != ""
  effects:          #EffectSpec
  purityLabel:      #PurityLevel
  mayFail:          bool
  requiresNetwork:  bool
  isPure:           bool
  exportedAt:       string & != ""
}

#BoundaryContract: {
  schemaVersion: "hobo.contract-ir/v1"
  id:            string & != ""
  version:       =~"^[0-9]+\\.[0-9]+\\.[0-9]+"
  mode:          #ContractMode
  edge:          #ContractEdge
  requiredShape: #RequiredShape
  contractHash:  =~"^sha256:[a-f0-9]{64}$"
  effects?:      #EffectSpec
  resilience?:   #ResilienceProfile
}

#CompatibilityReason: {
  code:        string & != ""
  message:     string & != ""
  contractId:  string & != ""
  channel:     string & != ""
  prevVersion: string & != ""
  nextVersion: string & != ""
  fields:      [...string]
}

#DeployedContractState: {
  contracts: [...#BoundaryContract]
}

#CanDeployResult: {
  schemaVersion: "hobo.can-deploy/v1"
  ok:            bool
  target:        string & != ""
  reasons:       [...#CompatibilityReason]
  summary:       string & != ""
  suggestedFixes: [...string]
}

#MachineReadableReason: {
  gate:    "contracts" | "policy" | "obligations" | "cost" | "effects" | "resilience" | "residency"
  code:    string & != ""
  message: string & != ""
}

#ObligationRecord: {
  id:        string & != ""
  kind:      string & != ""
  satisfied: bool
  deadline?: string & != ""
}

#CostQuotaRecord: {
  quota:     string & != ""
  used:      number & >= 0
  requested: number & >= 0
  limit:     number & >= 0
  remaining: number
  ok:        bool
}

#GatekeeperDecision: {
  schemaVersion: "hobo.gatekeeper/v1"
  decision:      #GatekeeperEffect
  reasons:       [...#MachineReadableReason]
  obligations:   [...#ObligationRecord]
  canDeploy:     #CanDeployResult
  costQuota:     #CostQuotaRecord
}
