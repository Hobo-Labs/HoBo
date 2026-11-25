// Lowering target: the `hobo:runtime@0.1.0` primitives
// (packages/wit/wit/deps/hobo-runtime/hobo-runtime.wit). The authoring surface
// in this package lowers onto these generated jco bindings — the workflow /
// step / actor / agent interfaces — so a TS-authored durable app produces the
// same records a Component-Model guest would. Type-only re-export: this is the
// `runtime -> wit` type dependency (no runtime import is emitted).
export type {
	ActorKey as WitActorKey,
	AgentMessage as WitAgentMessage,
	Event as WitEvent,
	HookToken as WitHookToken,
	Message as WitMessage,
	RunHandle as WitRunHandle,
	RuntimeError as WitRuntimeError,
	StateEntry as WitStateEntry,
	StepOpts as WitStepOpts,
	TokenHandle as WitTokenHandle,
	TokenRequest as WitTokenRequest,
	ToolCall as WitToolCall,
} from "../node_modules/@hobo/wit/src/generated/runtime-primitives/interfaces/hobo-runtime-types.js";
