import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";
import type { JsonValue } from "./json.js";

export const IAC_CROSSPLANE_INTERFACE = "hobo:iac/provider";

// domain-view: the IaC provider port shape adapters satisfy — the same
export interface IacProvider {
	readonly id: string;
	readonly model: string;
	preview(program: JsonValue): Promise<JsonValue>;
	apply(program: JsonValue): Promise<JsonValue>;
	refresh(program: JsonValue): Promise<JsonValue>;
	destroy(program: JsonValue): Promise<JsonValue>;
}

const crossplanePortDescriptor = createPortDescriptor({
	kind: "provider",
	name: "iac-crossplane",
	interface: IAC_CROSSPLANE_INTERFACE,
	stability: "preview",
});
if (crossplanePortDescriptor.kind !== "provider") {
	throw new Error("iac-crossplane port must be a provider port");
}
export const IAC_CROSSPLANE_PORT: ProviderPort =
	crossplanePortDescriptor as ProviderPort;
