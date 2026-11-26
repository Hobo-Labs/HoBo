import type { JsonBag } from "../../json.js";

export class ComponentHostPlanningError extends Error {
	code: string;
	hostKind?: string;
	hostVersion?: string;
	expectedVersions?: string[];
	suite?: string;

	constructor(code: string, details: JsonBag = {}) {
		super(
			`${code}: ${String(details.hostKind ?? "unknown")}@${String(details.hostVersion ?? "unknown")}`,
		);
		this.name = "ComponentHostPlanningError";
		this.code = code;
		Object.assign(this, details);
	}
}

export class CapabilityIsolationError extends Error {
	code: string;
	componentId?: string;
	importInterface?: string;

	constructor(code: string, details: JsonBag = {}) {
		super(
			`${code}: ${String(details.componentId ?? "unknown")}:${String(details.importInterface ?? "unknown")}`,
		);
		this.name = "CapabilityIsolationError";
		this.code = code;
		Object.assign(this, details);
	}
}
