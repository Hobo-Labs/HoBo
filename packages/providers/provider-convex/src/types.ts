import type {
	CapabilityPortKind,
	CloudProvider as CoreCloudProvider,
	ResourcePlan,
} from "@hobo/core";
import type { DriverProgram } from "./driver-program.js";

export type {
	Capability,
	CapabilityManifest,
	CostSignal,
	Match,
	Outputs,
	PortRequest,
	ProviderClient,
	ResourcePlan,
} from "@hobo/core";

export type PortKind = CapabilityPortKind;

export interface CloudProvider extends Omit<CoreCloudProvider, "realize"> {
	realize(plan: ResourcePlan): { driver: DriverProgram };
}
