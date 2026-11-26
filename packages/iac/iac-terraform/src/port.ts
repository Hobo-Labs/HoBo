import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";
import type { JsonValue } from "./json.js";

export const IAC_TERRAFORM_INTERFACE = "hobo:iac/provider";

// domain-view: the IaC provider port shape adapters satisfy — the same
export interface IacProvider {
	readonly id: string;
	readonly binary: string;
	readonly toolchainVersion: string;
	readonly stateBackend: JsonValue;
	preview(program: JsonValue): Promise<JsonValue>;
	apply(program: JsonValue): Promise<JsonValue>;
	refresh(program: JsonValue): Promise<JsonValue>;
	destroy(program: JsonValue): Promise<JsonValue>;
}

const terraformPortDescriptor = createPortDescriptor({
	kind: "provider",
	name: "iac-terraform",
	interface: IAC_TERRAFORM_INTERFACE,
	stability: "preview",
});
if (terraformPortDescriptor.kind !== "provider") {
	throw new Error("iac-terraform port must be a provider port");
}
export const IAC_TERRAFORM_PORT: ProviderPort =
	terraformPortDescriptor as ProviderPort;
