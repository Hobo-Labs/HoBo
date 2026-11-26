package hobo

#ComponentizeDeterminismFinding: {
  componentize_js_version: "0.21.0"
  inputs_digest: =~"^sha256:[a-f0-9]{64}$"
  component_digest: =~"^sha256:[a-f0-9]{64}$"
  smoke_stable: bool
  bytes_stable: bool
}

#ComponentizeStageGateDecision: {
  require_inputs_digest: true
  require_smoke_equivalence: true
  require_oci_manifest_determinism: true
  require_wasm_tools_validate: true
  require_byte_identical_wasm: false
}
