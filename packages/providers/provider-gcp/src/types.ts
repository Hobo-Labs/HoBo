// The canonical CloudProvider contract lives in @hobo/core (ADR-0156,
// packages/core/src/ports/cloud-provider.ts); this module re-exports it so
// existing `@hobo/provider-gcp` imports keep working. Package-local
// narrowings (IacProgram, BuildSpec, PublishedManifestDocuments,
// TypedOptionBlock) stay in their own modules.
import type { CapabilityPortKind } from "@hobo/core";

export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
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
