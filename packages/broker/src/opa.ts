// The OPA/Rego gate-plane adapter moved to `@hobo/provider-opa`.
// This shim keeps the broker's historical import
// surface: the provider package's structural port types are assignable to
// the broker's GatePlane/GateDecision, so consumers notice nothing.
export {
	buildOpaInput,
	createOpaGatePlane,
	OPA_DECISION_PATH,
	OPA_ENGINE_ID,
	type OpaGatePlaneOptions,
} from "@hobo/provider-opa";
