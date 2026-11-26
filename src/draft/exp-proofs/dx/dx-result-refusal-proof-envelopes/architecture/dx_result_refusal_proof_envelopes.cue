package dx_result_refusal_proof_envelopes

#ProofMode: "live" | "simulated" | "reference-fixture" | "scope-out"
#RedactionClass: "public-safe" | "tenant-safe" | "support-redacted" | "internal-only"
#Outcome: "success" | "warning" | "refusal" | "handoff"
#EnvelopeKind: "success" | "plan-warning" | "gatekeeper-denial" | "approval-required" |
  "contract-incompatibility" | "stale-projection" | "unknown-evidence" |
  "non-reactive-sink" | "migration-blocked" | "rollback-available" | "support-handoff"

#Audience: {
  personas: [...=~"^.+$"] & [_, ...]
  accessibility_needs: [...=~"^.+$"] & [_, ...]
  success_criteria: [...=~"^.+$"] & [_, ...]
}

#DxResultEnvelope: {
  kind: #EnvelopeKind
  outcome: #Outcome
  human_copy: =~"^.+$"
  code: =~"^hobo\\.dx\\.[a-z0-9-]+$"
  remediation: =~"^.+$"
  proof_mode: #ProofMode
  fixture_id: =~"^fixture:dx-result:.+$"
  trace_id: =~"^trace-dx-.+$"
  correlation_id: =~"^corr-dx-.+$"
  redaction_class: #RedactionClass
  accessibility_notes: [...=~"^.+$"] & [_, ...]
  copy_notes: [...=~"^.+$"] & [_, ...]
}

#DxResultRefusalProof: {
  issue: "HOBO-571"
  phase: "M1"
  audience: #Audience
  mocked_boundaries: [...=~"^.+$"] & [_, ...]
  references: [...=~"^docs/design/.+\\.md$"] & [_, ...]
  envelopes: [...#DxResultEnvelope]
}

#SurfaceExample: {
  surface: "sdk" | "cli-json" | "mcp-tool-result"
  kind: #EnvelopeKind
  code: =~"^hobo\\.dx\\.[a-z0-9-]+$"
  proof_mode: #ProofMode
  fixture_id: =~"^fixture:dx-result:.+$"
  trace_id: =~"^trace-dx-.+$"
  correlation_id: =~"^corr-dx-.+$"
  redaction_class: #RedactionClass
}

#DeterministicFixtureSet: {
  schema: "hobo.dx-result-refusal-proof-envelopes/fixture-set/v1"
  issue: "HOBO-571"
  happy_paths: [...#FixtureRecord]
  fail_closed_paths: [...#FixtureRecord]
  stable_digest: =~"^[a-f0-9]{64}$"
}

#FixtureRecord: {
  kind: #EnvelopeKind
  code: =~"^hobo\\.dx\\.[a-z0-9-]+$"
  proof_mode: #ProofMode
  fixture_id: =~"^fixture:dx-result:.+$"
  trace_id: =~"^trace-dx-.+$"
  correlation_id: =~"^corr-dx-.+$"
  redaction_class: #RedactionClass
}

#ClaimClassification: {
  allowed: bool
  reason: =~"^.+$"
  route: "dx-result-refusal-proof-envelopes"
}
