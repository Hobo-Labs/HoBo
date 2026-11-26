import { create, fromJsonString } from "@bufbuild/protobuf";
import { type Readiness, ReadinessSchema } from "./_generated/readiness_pb.js";

export const INTEGRATION_STATUS = "implemented";
export const EXECUTION_AVAILABLE = true;
export const TARGET_SDK = "@cloudflare/ci";
export const TARGET_DOCUMENTATION = "https://github.com/cloudflare/ci";

export const PENDING_GATES = Object.freeze([
	"Deployment-specific binding of source, Workflow termination, and account-scoped budget reservations.",
	"Live provider acceptance is outside local PACT validation.",
]);

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

export function parseReadiness(json: string): IntegrationReadiness {
	return implemented(fromJsonString(ReadinessSchema, json));
}

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
