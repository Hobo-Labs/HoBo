import type {
	CapabilityLinkTableEvent,
	LinkEstablishedEvent,
} from "@hobo/core";
import type { JsonValue } from "../json.js";

/** Minimal capability-host surface exercised by the conformance suite. */
export interface CapabilityHandle {
	componentId: string;
	importInterface: string;
	token: string;
}

export interface CapabilityLinkTable {
	registerComponent(input: { id: string; imports: readonly string[] }): void;
	registerProvider(input: {
		id: string;
		exports: Record<
			string,
			Record<string, (...args: JsonValue[]) => JsonValue>
		>;
	}): void;
	link(input: {
		componentId: string;
		importInterface: string;
		providerId: string;
		exportInterface: string;
	}): Readonly<LinkEstablishedEvent>;
	issueHandle(input: {
		componentId: string;
		importInterface: string;
	}): CapabilityHandle;
	callWithHandle(
		handle: CapabilityHandle,
		operation: string,
		payload?: JsonValue,
	): Promise<JsonValue>;
	events(): readonly CapabilityLinkTableEvent[];
}
