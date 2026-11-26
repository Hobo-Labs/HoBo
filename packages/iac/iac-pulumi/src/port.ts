import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";
import type { JsonValue } from "./json.js";

export const IAC_PULUMI_INTERFACE = "hobo:iac/provider";

// domain-view: the IaC provider port shape adapters satisfy. Kept in this
export interface IacProvider {
	readonly id: string;
	readonly pulumiVersion: string;
	readonly stateBackend: JsonValue;
	preview(program: JsonValue): Promise<JsonValue>;
	apply(program: JsonValue): Promise<JsonValue>;
	refresh(program: JsonValue): Promise<JsonValue>;
	destroy(program: JsonValue): Promise<JsonValue>;
}

const pulumiPortDescriptor = createPortDescriptor({
	kind: "provider",
	name: "iac-pulumi",
	interface: IAC_PULUMI_INTERFACE,
	stability: "preview",
});
if (pulumiPortDescriptor.kind !== "provider") {
	throw new Error("iac-pulumi port must be a provider port");
}
export const IAC_PULUMI_PORT: ProviderPort =
	pulumiPortDescriptor as ProviderPort;
