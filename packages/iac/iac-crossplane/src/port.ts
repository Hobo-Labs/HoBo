import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";
import type { JsonValue } from "./json.js";

// public-contract: the IaC provider port interface id this boundary serves.
export const IAC_CROSSPLANE_INTERFACE = "hobo:iac/provider";

// domain-view: the IaC provider port shape adapters satisfy — the same
// boundary contract the Pulumi and Terraform adapters declare, so provisioning
// callers depend on the port rather than a concrete cluster client.
export interface IacProvider {
	readonly id: string;
	readonly model: string;
	preview(program: JsonValue): Promise<JsonValue>;
	apply(program: JsonValue): Promise<JsonValue>;
	refresh(program: JsonValue): Promise<JsonValue>;
	destroy(program: JsonValue): Promise<JsonValue>;
}

// The provider-port descriptor for this boundary, built through @hobo/core so
// the adapter's only inward dependency is the shared port vocabulary.
const crossplanePortDescriptor = createPortDescriptor({
	kind: "provider",
	name: "iac-crossplane",
	interface: IAC_CROSSPLANE_INTERFACE,
	stability: "preview",
});
if (crossplanePortDescriptor.kind !== "provider") {
	throw new Error("iac-crossplane port must be a provider port");
}
// SAFETY: the guard above establishes `kind === "provider"`. `PortDescriptor`
// is one interface rather than a discriminated union, so narrowing the property
// does not narrow the object -- this assertion is where the guard's result is
// recorded, and it cannot outlive the check that precedes it.
export const IAC_CROSSPLANE_PORT: ProviderPort =
	crossplanePortDescriptor as ProviderPort;
