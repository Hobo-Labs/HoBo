// The canonical CloudProvider contract lives in @hobo/core (ADR-0156,
// packages/core/src/ports/cloud-provider.ts); this module re-exports it so
// existing `@hobo/provider-convex` imports keep working. Package-local
// narrowings (DriverProgram, PublishedManifestDocuments) stay in their own
// modules.
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

// Back-compat alias: the canonical name is @hobo/core's `CapabilityPortKind`
// (core's own `PortKind` is the structural port classification).
export type PortKind = CapabilityPortKind;

/**
 * Driver-program variant of core's CloudProvider port: identical contract
 * except `realize()` emits a deploy-driver program (ADR-0127 — the closed
 * BaaS exposes a deploy surface, not infrastructure state) instead of core's
 * `RealizedResources` IaC program.
 */
export interface CloudProvider extends Omit<CoreCloudProvider, "realize"> {
	realize(plan: ResourcePlan): { driver: DriverProgram };
}
