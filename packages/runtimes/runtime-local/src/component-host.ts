import type {
	ComponentHostEvent,
	ComponentHostPort,
	ComponentInstance,
	HttpRequest,
	HttpResponse,
	InterfaceId,
	LinkRecord,
	ParsedComponentDescriptor,
	ProviderDescriptor,
	WasmtimeEngine,
} from "@hobo/core";
import { createInProcessWasmtimeEngine } from "./engine/wasmtime.js";
import { ComponentHostError, ComponentTrapError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { ParsedLinkRequest, ParsedProviderDescriptor } from "./parse.js";
import { parseLinkRequest, parseProviderDescriptor } from "./parse.js";

export const HTTP_INCOMING_HANDLER =
	// SAFETY: assertion to `"wasi:http/incoming-handler@0.2.0" as InterfaceId` is required at this boundary.
	"wasi:http/incoming-handler@0.2.0" as InterfaceId;

export interface RuntimeLocalComponentHostOptions {
	engine?: WasmtimeEngine;
	appendEvent: (event: ComponentHostEvent) => void;
}

export function createRuntimeLocalComponentHost(
	options: RuntimeLocalComponentHostOptions,
): ComponentHostPort {
	return new RuntimeLocalComponentHost(
		options.engine ?? createInProcessWasmtimeEngine(),
		options.appendEvent,
	);
}

class RuntimeLocalComponentHost implements ComponentHostPort {
	#components = new Map<string, ComponentInstance>();
	#providers = new Map<string, ParsedProviderDescriptor>();
	#links = new Map<string, LinkRecord>();
	#leases = new Map<string, string[]>();
	#lifecycle = new Map<string, { id: string; state: "loaded" | "torn-down" }>();
	#eventMirror: ComponentHostEvent[] = [];

	readonly engine: WasmtimeEngine;

	constructor(
		engine: WasmtimeEngine,
		private readonly appendEvent: (event: ComponentHostEvent) => void,
	) {
		if (engine.kind !== "wasmtime") {
			throw new ComponentHostError("engine_required", "wasmtime");
		}
		this.engine = engine;
	}

	registerProvider(provider: ProviderDescriptor): void {
		const parsed = parseProviderDescriptor(provider);
		this.#providers.set(parsed.id, parsed);
	}

	loadComponent(component: ParsedComponentDescriptor): ComponentInstance {
		const instance = this.engine.instantiate(component);
		this.#components.set(component.id, instance);
		this.#lifecycle.set(component.id, { id: component.id, state: "loaded" });
		this.#leases.set(component.id, [...(component.leases ?? [])]);
		this.#append({
			type: "component.Loaded",
			componentId: component.id,
			engine: "wasmtime",
		});
		return instance;
	}

	link(
		request: ParsedLinkRequest | Parameters<typeof parseLinkRequest>[0],
	): LinkRecord {
		const parsed = "parsed" in request ? request : parseLinkRequest(request);
		const component = this.#requireLoaded(parsed.componentId);
		const provider = this.#providers.get(parsed.providerId);
		if (!provider) {
			throw new ComponentHostError(
				"provider_not_registered",
				parsed.providerId,
			);
		}
		if (!component.imports.includes(parsed.importInterface)) {
			throw new ComponentHostError(
				"import_not_declared",
				`${parsed.componentId}:${parsed.importInterface}`,
			);
		}
		if (!provider.exports[parsed.exportInterface]) {
			throw new ComponentHostError(
				"export_not_found",
				`${parsed.providerId}:${parsed.exportInterface}`,
			);
		}

		const link: LinkRecord = Object.freeze({
			componentId: parsed.componentId,
			importInterface: parsed.importInterface,
			providerId: parsed.providerId,
			exportInterface: parsed.exportInterface,
			boundaryMode: "live",
			transport: "in-process",
		});
		this.#links.set(linkKey(parsed.componentId, parsed.importInterface), link);
		this.#append({
			type: "link.Established",
			componentId: link.componentId,
			importInterface: link.importInterface,
			providerId: link.providerId,
			exportInterface: link.exportInterface,
			boundaryMode: link.boundaryMode,
			transport: link.transport,
		});
		return link;
	}

	async invokeLinkedImport(
		componentId: string,
		importInterface: InterfaceId,
		operation: string,
		payload?: JsonValue,
	) {
		this.#requireLoaded(componentId);
		const link = this.#links.get(linkKey(componentId, importInterface));
		if (!link) {
			throw new ComponentHostError(
				"no_route",
				`${componentId}:${importInterface}`,
			);
		}
		const provider = this.#providers.get(link.providerId);
		const implementation = provider?.exports[link.exportInterface]?.[operation];
		if (!(implementation instanceof Function)) {
			throw new ComponentHostError(
				"operation_not_found",
				`${link.exportInterface}.${operation}`,
			);
		}

		this.#append({
			type: "link.Called",
			componentId,
			importInterface,
			providerId: link.providerId,
			exportInterface: link.exportInterface,
			operation,
			boundaryMode: link.boundaryMode,
			transport: link.transport,
		});
		return implementation(payload ?? null);
	}

	async handleHttp(
		componentId: string,
		request: HttpRequest,
	): Promise<HttpResponse> {
		const component = this.#requireLoaded(componentId);
		const handler = component.exports[HTTP_INCOMING_HANDLER]?.handle;
		if (!(handler instanceof Function)) {
			throw new ComponentHostError("http_handler_missing", componentId);
		}

		try {
			type HttpIncomingHandler = (
				request: HttpRequest,
				context: {
					callImport: (
						importInterface: InterfaceId,
						operation: string,
						payload?: JsonValue,
					) => Promise<JsonValue>;
				},
			) => HttpResponse | Promise<HttpResponse>;
			// SAFETY: incoming-handler is host-shaped at this in-process boundary.
			const incoming: HttpIncomingHandler = handler as never;
			const response = await incoming(request, {
				callImport: (
					importInterface: InterfaceId,
					operation: string,
					payload?: JsonValue,
				) =>
					this.invokeLinkedImport(
						componentId,
						importInterface,
						operation,
						payload,
					),
			});
			this.#append({
				type: "component.Invoked",
				componentId,
				interface: HTTP_INCOMING_HANDLER,
				operation: "handle",
			});
			return response;
		} catch (error) {
			const trapped = error instanceof Error ? error : new Error(String(error));
			this.#append({
				type: "component.Trapped",
				componentId,
				interface: HTTP_INCOMING_HANDLER,
				message: trapped.message,
			});
			throw new ComponentTrapError(componentId, trapped);
		}
	}

	async teardownComponent(componentId: string): Promise<void> {
		this.#requireLoaded(componentId);
		for (const key of Array.from(this.#links.keys())) {
			if (key.startsWith(`${componentId}\0`)) {
				this.#links.delete(key);
			}
		}
		this.#leases.delete(componentId);
		this.#components.delete(componentId);
		this.#lifecycle.set(componentId, { id: componentId, state: "torn-down" });
		this.#append({ type: "component.TornDown", componentId });
	}

	lifecycle(componentId: string) {
		return (
			this.#lifecycle.get(componentId) ?? {
				id: componentId,
				state: "missing" as const,
			}
		);
	}

	activeLeases(): string[] {
		return [...this.#leases.values()].flat();
	}

	linkTable(): LinkRecord[] {
		return [...this.#links.values()];
	}

	report() {
		return {
			schema: "hobo.component-host.runtime-local/v1",
			hostKind: "runtime-local",
			engine: "wasmtime",
			supportedBoundaryModes: ["live"],
			supportedTransports: ["in-process"],
			scopeIn: [
				"component lifecycle",
				"static link table",
				"wasi:http incoming-handler demo",
				"trap isolation",
				"clean teardown",
			],
			scopeOut: [
				"cross-process lattice transport",
				"container packaging",
				"deny-by-default grant inference",
				"deterministic-clock replay",
			],
			followUps: ["fuel/epoch execution limits"],
		};
	}

	eventMirror(): readonly ComponentHostEvent[] {
		return this.#eventMirror;
	}

	#append(event: ComponentHostEvent): void {
		this.appendEvent(event);
		this.#eventMirror.push(event);
	}

	#requireLoaded(componentId: string): ComponentInstance {
		const component = this.#components.get(componentId);
		if (!component) {
			throw new ComponentHostError("component_not_loaded", componentId);
		}
		return component;
	}
}

function linkKey(componentId: string, importInterface: InterfaceId): string {
	return `${componentId}\0${importInterface}`;
}
