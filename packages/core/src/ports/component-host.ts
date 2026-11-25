import type { JsonObject, JsonValue } from "../json.js";

export type InterfaceId = string & { readonly __brand: "InterfaceId" };

const INTERFACE_ID_PATTERN =
	/^[a-z][a-z0-9-]*:[a-z0-9-]+\/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+$/;

export function parseInterfaceId(raw: string): InterfaceId {
	if (!INTERFACE_ID_PATTERN.test(raw)) {
		throw new Error(`component_host.invalid_interface_id: ${raw}`);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return raw as InterfaceId;
}

/**
 * A function in a component's or provider's export table.
 *
 * The promise arm is not an accommodation — it is what these already are. An
 * export that calls back into the host (`callImport`) cannot answer
 * synchronously, and the local runtime awaits every export it invokes. Naming
 * only the synchronous arm forced each of those exports to be cast on its way
 * into the table, which is how an `async` function ends up asserted to a
 * synchronous type: a cast the compiler rightly calls a probable mistake, and
 * which would have silently hidden a genuinely wrong signature.
 */
export type ComponentExport = (
	...args: JsonValue[]
) => JsonValue | Promise<JsonValue>;

export interface ComponentDescriptor {
	id: string;
	imports: InterfaceId[];
	exports: Record<string, Record<string, ComponentExport>>;
	leases?: string[];
}

export interface ProviderDescriptor {
	id: string;
	exports: Record<string, Record<string, ComponentExport>>;
}

export type BoundaryMode = "live";
export type LinkTransport = "in-process";

export interface LinkRecord {
	componentId: string;
	importInterface: InterfaceId;
	providerId: string;
	exportInterface: InterfaceId;
	boundaryMode: BoundaryMode;
	transport: LinkTransport;
}

export interface LinkRequest {
	componentId: string;
	importInterface: InterfaceId;
	providerId: string;
	exportInterface: InterfaceId;
}

export type ComponentHostEvent =
	| { type: "component.Loaded"; componentId: string; engine: "wasmtime" }
	| {
			type: "link.Established";
			componentId: string;
			importInterface: InterfaceId;
			providerId: string;
			exportInterface: InterfaceId;
			boundaryMode: BoundaryMode;
			transport: LinkTransport;
	  }
	| {
			type: "link.Called";
			componentId: string;
			importInterface: InterfaceId;
			providerId: string;
			exportInterface: InterfaceId;
			operation: string;
			boundaryMode: BoundaryMode;
			transport: LinkTransport;
	  }
	| {
			type: "component.Invoked";
			componentId: string;
			interface: InterfaceId;
			operation: string;
	  }
	| {
			type: "component.Trapped";
			componentId: string;
			interface: InterfaceId;
			message: string;
	  }
	| { type: "component.TornDown"; componentId: string };

export interface ComponentInstance {
	id: string;
	imports: InterfaceId[];
	exports: Record<string, Record<string, ComponentExport>>;
}

export interface ParsedComponentDescriptor extends ComponentDescriptor {
	readonly parsed: true;
}

export interface WasmtimeEngine {
	kind: "wasmtime";
	version: string;
	instantiate(component: ParsedComponentDescriptor): ComponentInstance;
}

export interface ComponentLifecycle {
	id: string;
	state: "loaded" | "torn-down" | "missing";
}

export interface HttpRequest {
	method: string;
	path: string;
	headers: [string, string][];
	body: string;
}

export interface HttpResponse {
	status: number;
	headers: [string, string][];
	body: string;
}

export interface ComponentHostPort {
	loadComponent(component: ParsedComponentDescriptor): ComponentInstance;
	registerProvider(provider: ProviderDescriptor): void;
	link(request: LinkRequest): LinkRecord;
	invokeLinkedImport(
		componentId: string,
		importInterface: InterfaceId,
		operation: string,
		payload?: JsonValue,
	): Promise<JsonValue>;
	handleHttp(componentId: string, request: HttpRequest): Promise<HttpResponse>;
	teardownComponent(componentId: string): Promise<void>;
	lifecycle(componentId: string): ComponentLifecycle;
	linkTable(): LinkRecord[];
	activeLeases(): string[];
	report(): JsonObject;
}
