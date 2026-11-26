import {
	CapabilityDeniedError,
	type CapabilityGrant,
	type CapabilityGrantDeniedEvent,
	type CapabilityLinkTableEvent,
	type ComponentExport,
	type LinkCalledEvent,
	type LinkEstablishedEvent,
} from "@hobo/core";
import { isJsonString, type JsonValue } from "../json.js";

export interface CapabilityHandle {
	componentId: string;
	importInterface: string;
	token: string;
}

export interface CapabilityLinkTable {
	registerComponent(input: { id: string; imports: readonly string[] }): void;
	registerProvider(input: {
		id: string;
		exports: Record<string, Record<string, ComponentExport>>;
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

interface StoredComponent {
	id: string;
	imports: Set<string>;
}

interface StoredProvider {
	id: string;
	exports: Record<string, Record<string, ComponentExport>>;
}

interface StoredGrant {
	resource: string;
	operations: Set<string>;
}

interface StoredLink {
	componentId: string;
	importInterface: string;
	providerId: string;
	exportInterface: string;
	transport: "in-process";
	grantSource: "usage-inferred";
}

interface HandleInfo {
	componentId: string;
	importInterface: string;
	grant: StoredGrant;
}

export function createCapabilityLinkTable({
	grants = [],
	eventSink,
}: {
	grants?: readonly CapabilityGrant[];
	eventSink?: (event: CapabilityLinkTableEvent) => void;
} = {}): CapabilityLinkTable {
	const components = new Map<string, StoredComponent>();
	const providers = new Map<string, StoredProvider>();
	const links = new Map<string, StoredLink>();
	const grantMap = new Map<string, StoredGrant>();
	const handles = new WeakMap<object, HandleInfo>();
	const events: CapabilityLinkTableEvent[] = [];
	let nextHandleId = 0;

	for (const grant of grants) {
		grantMap.set(grantKey(grant.componentId, grant.importInterface), {
			resource: grant.resource,
			operations: new Set(grant.operations),
		});
	}

	function append(event: CapabilityLinkTableEvent): void {
		events.push(event);
		eventSink?.(event);
	}

	function deny(
		code: CapabilityGrantDeniedEvent["reason"],
		details: Omit<CapabilityGrantDeniedEvent, "type" | "reason"> = {},
	): never {
		append({
			type: "capability.GrantDenied",
			reason: code,
			...details,
		});
		throw new CapabilityDeniedError(code, details);
	}

	return {
		registerComponent({ id, imports }) {
			assertId(id, "component");
			components.set(id, {
				id,
				imports: new Set(imports),
			});
		},

		registerProvider({ id, exports }) {
			assertId(id, "provider");
			providers.set(id, { id, exports });
		},

		link({ componentId, importInterface, providerId, exportInterface }) {
			const component = components.get(componentId);
			if (!component) {
				deny("capability.component-not-registered", { componentId });
			}
			if (!component.imports.has(importInterface)) {
				deny("capability.import-not-declared", {
					componentId,
					importInterface,
				});
			}

			const provider = providers.get(providerId);
			if (!provider) {
				deny("capability.provider-not-registered", {
					providerId,
					componentId,
					importInterface,
				});
			}
			if (!provider.exports[exportInterface]) {
				deny("capability.export-not-found", {
					componentId,
					importInterface,
					providerId,
					exportInterface,
				});
			}

			const linkRecord: StoredLink = {
				componentId,
				importInterface,
				providerId,
				exportInterface,
				transport: "in-process",
				grantSource: "usage-inferred",
			};
			links.set(grantKey(componentId, importInterface), linkRecord);

			const event: LinkEstablishedEvent = Object.freeze({
				type: "link.Established",
				componentId,
				importInterface,
				providerId,
				exportInterface,
				transport: "in-process",
				grantSource: "usage-inferred",
			});
			append(event);
			return event;
		},

		issueHandle({ componentId, importInterface }) {
			if (!components.has(componentId)) {
				deny("capability.component-not-registered", {
					componentId,
					importInterface,
				});
			}
			const grant = grantMap.get(grantKey(componentId, importInterface));
			if (!grant) {
				deny("capability.no-inferred-grant", { componentId, importInterface });
			}

			const handle = Object.freeze({
				componentId,
				importInterface,
				token: `cap-${++nextHandleId}`,
			});
			handles.set(handle, { componentId, importInterface, grant });
			return handle;
		},

		async callWithHandle(handle, operation, payload = {}) {
			const info = handles.get(handle);
			if (!info) {
				deny("capability.fabricated-handle", {});
			}

			const { componentId, importInterface, grant } = info;
			if (!grant.operations.has(operation)) {
				deny("capability.operation-not-granted", {
					componentId,
					importInterface,
					operation,
					resource: grant.resource,
				});
			}

			const link = links.get(grantKey(componentId, importInterface));
			if (!link) {
				deny("capability.no-linked-route", {
					componentId,
					importInterface,
					operation,
					resource: grant.resource,
				});
			}

			const provider = providers.get(link.providerId);
			if (!provider) {
				deny("capability.provider-not-registered", {
					providerId: link.providerId,
					componentId,
					importInterface,
				});
			}

			const implementation =
				provider.exports[link.exportInterface]?.[operation];
			if (!(implementation instanceof Function)) {
				deny("capability.operation-not-found", {
					componentId,
					importInterface,
					operation,
					providerId: link.providerId,
					exportInterface: link.exportInterface,
				});
			}

			const result = await implementation(structuredClone(payload), {
				componentId,
				importInterface,
				operation,
				resource: grant.resource,
			});

			const called: LinkCalledEvent = {
				type: "link.Called",
				componentId,
				importInterface,
				providerId: link.providerId,
				exportInterface: link.exportInterface,
				operation,
				resource: grant.resource,
				grantSource: link.grantSource,
				transport: link.transport,
			};
			append(called);
			return structuredClone(result);
		},

		events() {
			return Object.freeze([...events]);
		},
	};
}

function grantKey(componentId: string, importInterface: string): string {
	return `${componentId}\0${importInterface}`;
}

function assertId(id: string, kind: "component" | "provider"): void {
	if (!isJsonString(id) || id.length === 0) {
		throw new Error(`capability.${kind}-id-required`);
	}
}
