export class ComponentHostError extends Error {
	readonly code: ComponentHostErrorCode;

	constructor(code: ComponentHostErrorCode, message: string) {
		super(`component_host.${code}: ${message}`);
		this.name = "ComponentHostError";
		this.code = code;
	}
}

export class ComponentTrapError extends Error {
	readonly componentId: string;
	readonly cause: Error;

	constructor(componentId: string, cause: Error) {
		super(`component_host.component_trapped: ${componentId}: ${cause.message}`);
		this.name = "ComponentTrapError";
		this.componentId = componentId;
		this.cause = cause;
	}
}

export type ComponentHostErrorCode =
	| "engine_required"
	| "provider_not_registered"
	| "import_not_declared"
	| "export_not_found"
	| "no_route"
	| "operation_not_found"
	| "http_handler_missing"
	| "component_not_loaded"
	| "invalid_interface_id"
	| "component_id_required"
	| "provider_id_required"
	| "wasmtime_version_floor";
