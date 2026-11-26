import { create, fromJsonString } from "@bufbuild/protobuf";
import { type Readiness, ReadinessSchema } from "./_generated/readiness_pb.js";

/** HoBo CI Dagger implements the portable command pipeline on a bound engine. */
// public-contract: readiness consumers pins implemented SDK readiness without implying a hosted engine.
export const INTEGRATION_STATUS = "implemented";
export const EXECUTION_AVAILABLE = true;
// public-contract: identifies the upstream SDK this planned adapter targets.
export const TARGET_SDK = "@dagger.io/dagger";
// public-contract: canonical upstream documentation for the planned integration.
export const TARGET_DOCUMENTATION = "https://docs.dagger.io/";

/** These are implementation prerequisites, not runtime capability claims. */
export const PENDING_GATES = Object.freeze([
	"Bind a customer-owned engine and authoritative budget reservations before hosted execution.",
	"Verify provider shutdown acknowledgments and invoice reconciliation with PACT evidence.",
]);

/** A refinement of the generated message; no parallel handwritten wire DTO. */
export type DaggerReadiness = Readonly<
	Omit<Readiness, "status" | "executionAvailable" | "pendingGates">
> & {
	readonly status: "implemented";
	readonly executionAvailable: true;
	readonly pendingGates: readonly string[];
};

function planned(message: Readiness): DaggerReadiness {
	if (
		message.integration !== "dagger" ||
		message.status !== INTEGRATION_STATUS ||
		message.executionAvailable !== EXECUTION_AVAILABLE ||
		message.targetSdk !== TARGET_SDK ||
		message.targetDocumentation !== TARGET_DOCUMENTATION ||
		message.pendingGates.length === 0 ||
		message.pendingGates.some((gate) => gate.trim().length === 0)
	)
		throw new Error("invalid implemented Dagger readiness");
	return Object.freeze({
		...message,
		status: INTEGRATION_STATUS,
		executionAvailable: EXECUTION_AVAILABLE,
		pendingGates: Object.freeze([...message.pendingGates]),
	});
}

/** Parse the protobuf JSON boundary once, then return the constrained view. */
export function parseReadiness(json: string): DaggerReadiness {
	return planned(fromJsonString(ReadinessSchema, json));
}

/** Readiness discovery performs no engine, network, or execution side effects. */
export function getReadiness(): DaggerReadiness {
	return planned(
		create(ReadinessSchema, {
			integration: "dagger",
			status: INTEGRATION_STATUS,
			executionAvailable: EXECUTION_AVAILABLE,
			targetSdk: TARGET_SDK,
			targetDocumentation: TARGET_DOCUMENTATION,
			pendingGates: [...PENDING_GATES],
		}),
	);
}

export {
	createDaggerBackend,
	type DaggerBackendOptions,
	type DaggerClientPort,
	type DaggerConnection,
	type DaggerConnector,
	type DaggerContainerPort,
	daggerClientPort,
} from "./backend.js";
