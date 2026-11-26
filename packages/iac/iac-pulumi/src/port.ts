import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";
import type { JsonValue } from "./json.js";

export const IAC_PULUMI_INTERFACE = "hobo:iac/provider";

// domain-view: the IaC provider port shape adapters satisfy. Kept in this
// package (there is no IaC port in @hobo/core) so provisioning callers depend on
// this contract rather than the concrete Pulumi Automation engine. The frozen
// return values are validated structurally by runIacBackendConformance.
export interface IacProvider {
	readonly id: string;
	readonly pulumiVersion: string;
	readonly stateBackend: JsonValue;
	preview(program: JsonValue): Promise<JsonValue>;
	apply(program: JsonValue): Promise<JsonValue>;
	refresh(program: JsonValue): Promise<JsonValue>;
	destroy(program: JsonValue): Promise<JsonValue>;
}

// The provider-port descriptor for this boundary, built through @hobo/core so
// the adapter's only inward dependency is the shared port vocabulary.
const pulumiPortDescriptor = createPortDescriptor({
	kind: "provider",
	name: "iac-pulumi",
	interface: IAC_PULUMI_INTERFACE,
	stability: "preview",
});
if (pulumiPortDescriptor.kind !== "provider") {
	throw new Error("iac-pulumi port must be a provider port");
}
// SAFETY: the guard above establishes `kind === "provider"`. `PortDescriptor`
// is one interface rather than a discriminated union, so narrowing the property
// does not narrow the object -- this assertion is where the guard's result is
// recorded, and it cannot outlive the check that precedes it.
export const IAC_PULUMI_PORT: ProviderPort =
	pulumiPortDescriptor as ProviderPort;
