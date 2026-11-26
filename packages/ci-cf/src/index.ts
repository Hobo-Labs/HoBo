import { create, fromJsonString } from "@bufbuild/protobuf";
import { type Readiness, ReadinessSchema } from "./_generated/readiness_pb.js";

/** HoBo CI Cf targets Cloudflare's CI SDK; implements the native Workflow/Sandbox pipeline backend. */
// public-contract: readiness consumers distinguish implemented adapters from unimplemented scaffolds.
export const INTEGRATION_STATUS = "implemented";
export const EXECUTION_AVAILABLE = true;
// public-contract: identifies the upstream SDK this planned adapter targets.
export const TARGET_SDK = "@cloudflare/ci";
// public-contract: canonical upstream documentation for the planned integration.
export const TARGET_DOCUMENTATION = "https://github.com/cloudflare/ci";

/** These gates must be evidenced before registering an execution provider. */
export const PENDING_GATES = Object.freeze([
	"Deployment-specific binding of source, Workflow termination, and account-scoped budget reservations.",
	"Live provider acceptance is outside local PACT validation.",
]);

/** A refinement of the generated message; no parallel handwritten wire DTO. */
export type IntegrationReadiness = Readonly<
	Omit<Readiness, "status" | "executionAvailable" | "pendingGates">
> & {
	readonly status: "implemented";
	readonly executionAvailable: true;
	readonly pendingGates: readonly string[];
};

function implemented(message: Readiness): IntegrationReadiness {
	if (
		message.integration !== "cf" ||
		message.status !== INTEGRATION_STATUS ||
		message.executionAvailable !== EXECUTION_AVAILABLE ||
		message.targetSdk !== TARGET_SDK ||
		message.targetDocumentation !== TARGET_DOCUMENTATION ||
		message.pendingGates.length === 0 ||
		message.pendingGates.some((gate) => gate.trim().length === 0)
	)
		throw new Error("invalid implemented Cloudflare CI readiness");
	return Object.freeze({
		...message,
		status: INTEGRATION_STATUS,
		executionAvailable: EXECUTION_AVAILABLE,
		pendingGates: Object.freeze([...message.pendingGates]),
	});
}

/** Parse the protobuf JSON boundary once, then return the constrained view. */
export function parseReadiness(json: string): IntegrationReadiness {
	return implemented(fromJsonString(ReadinessSchema, json));
}

/** Readiness discovery performs no Cloudflare, network, or execution side effects. */
export function getReadiness(): IntegrationReadiness {
	return implemented(
		create(ReadinessSchema, {
			integration: "cf",
			status: INTEGRATION_STATUS,
			executionAvailable: EXECUTION_AVAILABLE,
			targetSdk: TARGET_SDK,
			targetDocumentation: TARGET_DOCUMENTATION,
			pendingGates: [...PENDING_GATES],
		}),
	);
}

export {
	type CloudflareBackendOptions,
	cloudflareCommand,
	createCloudflareBackend,
} from "./backend.js";
