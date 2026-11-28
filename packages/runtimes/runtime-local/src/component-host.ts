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
	#loading = new Set<string>();
	#inFlight = new Map<string, number>();
	#sinkFailed = false;
	#emitting = false;
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
		this.#requireAvailable();
		const parsed = parseProviderDescriptor(provider);
		this.#providers.set(parsed.id, parsed);
	}

	loadComponent(component: ParsedComponentDescriptor): ComponentInstance {
		this.#requireAvailable();
		const id = component.id;
		if (this.#components.has(id) || this.#loading.has(id))
			throw new ComponentHostError("component_already_loaded", id);
		this.#loading.add(id);
		try {
			const leases = [...(component.leases ?? [])];
			const instance = this.engine.instantiate(component);
			if (instance.id !== id)
				throw new ComponentHostError("component_identity_mismatch", id);
			this.#components.set(id, instance);
			this.#lifecycle.set(id, { id, state: "loaded" });
			this.#leases.set(id, leases);
			this.#append({
				type: "component.Loaded",
				componentId: id,
				engine: "wasmtime",
			});
			return instance;
		} finally {
			this.#loading.delete(id);
		}
	}

	link(
		request: ParsedLinkRequest | Parameters<typeof parseLinkRequest>[0],
	): LinkRecord {
		this.#requireAvailable();
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
		this.#requireAvailable();
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

		const release = this.#beginInvocation(componentId);
		try {
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
			return await implementation(payload ?? null);
		} finally {
			release();
		}
	}

	async handleHttp(
		componentId: string,
		request: HttpRequest,
	): Promise<HttpResponse> {
		this.#requireAvailable();
		const component = this.#requireLoaded(componentId);
		const handler = component.exports[HTTP_INCOMING_HANDLER]?.handle;
		if (!(handler instanceof Function)) {
			throw new ComponentHostError("http_handler_missing", componentId);
		}

		const release = this.#beginInvocation(componentId);
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
			if (this.#sinkFailed)
				throw new ComponentHostError(
					"event_sink_uncertain",
					"host requires reconciliation",
				);
			const trapped = error instanceof Error ? error : new Error(String(error));
			this.#append({
				type: "component.Trapped",
				componentId,
				interface: HTTP_INCOMING_HANDLER,
				message: trapped.message,
			});
			throw new ComponentTrapError(componentId, trapped);
		} finally {
			release();
		}
	}

	async teardownComponent(componentId: string): Promise<void> {
		this.#requireAvailable();
		this.#requireLoaded(componentId);
		if ((this.#inFlight.get(componentId) ?? 0) > 0)
			throw new ComponentHostError("component_busy", componentId);
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
		const lifecycle = this.#lifecycle.get(componentId);
		return lifecycle
			? { ...lifecycle }
			: { id: componentId, state: "missing" as const };
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
		return this.#eventMirror.map((event) => ({ ...event }));
	}

	#append(event: ComponentHostEvent): void {
		this.#requireAvailable();
		const mirrorEvent = { ...event };
		this.#emitting = true;
		try {
			const result: unknown = this.appendEvent(event);
			const returned: { readonly then?: unknown } = Object(result);
			if (returned === result && returned.then instanceof Function) {
				void Promise.resolve(result).catch(() => undefined);
				throw new Error("event sink must be synchronous");
			}
		} catch {
			this.#sinkFailed = true;
			throw new ComponentHostError(
				"event_sink_uncertain",
				"event sink failed; host requires reconciliation",
			);
		} finally {
			this.#emitting = false;
		}
		this.#eventMirror.push(mirrorEvent);
	}

	#requireAvailable(): void {
		if (this.#sinkFailed)
			throw new ComponentHostError(
				"event_sink_uncertain",
				"host requires reconciliation",
			);
		if (this.#emitting)
			throw new ComponentHostError(
				"event_sink_reentrant",
				"event sink cannot call the host",
			);
	}

	#beginInvocation(componentId: string): () => void {
		this.#inFlight.set(componentId, (this.#inFlight.get(componentId) ?? 0) + 1);
		return () => {
			const count = this.#inFlight.get(componentId) ?? 0;
			if (count <= 1) this.#inFlight.delete(componentId);
			else this.#inFlight.set(componentId, count - 1);
		};
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
