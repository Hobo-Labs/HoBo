import type { JsonObject } from "./json.js";

export const DRIVER_PROGRAM_API_VERSION = "hobo.driver-program/v1";
export const DRIVER_PROGRAM_KIND = "driver-program";
export const CONVEX_DRIVER = "convex-deploy";

export interface DriverResource {
	name: string;
	type: string;
	provider: string;
	inputs: JsonObject;
	outputs: string[];
}

export interface DriverProgram {
	apiVersion: typeof DRIVER_PROGRAM_API_VERSION;
	kind: typeof DRIVER_PROGRAM_KIND;
	driver: typeof CONVEX_DRIVER;
	deploymentId: string;
	deployment: string;
	resources: DriverResource[];
	outputs: Record<string, string>;
}

const OUTPUT_REF =
	/^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;

export function assertDriverProgram(program: DriverProgram): DriverProgram {
	if (program.apiVersion !== DRIVER_PROGRAM_API_VERSION) {
		throw new Error(
			`DriverProgram apiVersion must be ${DRIVER_PROGRAM_API_VERSION}`,
		);
	}
	if (program.kind !== DRIVER_PROGRAM_KIND) {
		throw new Error("DriverProgram kind must be driver-program");
	}
	if (program.driver !== CONVEX_DRIVER) {
		throw new Error(`DriverProgram driver must be ${CONVEX_DRIVER}`);
	}
	if (!program.deployment) {
		throw new Error("DriverProgram must name a Convex deployment");
	}
	if (!Array.isArray(program.resources) || program.resources.length === 0) {
		throw new Error("DriverProgram must include at least one resource");
	}
	const names = new Map<string, DriverResource>();
	for (const resource of program.resources) {
		if (!resource.name) {
			throw new Error("DriverProgram resource missing name");
		}
		if (names.has(resource.name)) {
			throw new Error(
				`DriverProgram includes duplicate resource ${resource.name}`,
			);
		}
		names.set(resource.name, resource);
	}
	for (const value of Object.values(program.outputs)) {
		if (!value.startsWith("${resources.")) {
			continue;
		}
		const match = OUTPUT_REF.exec(value);
		if (!match) {
			throw new Error(`invalid output reference ${value}`);
		}
		const resourceName = match[1];
		const outputName = match[2];
		if (resourceName === undefined || outputName === undefined) {
			throw new Error(`invalid output reference ${value}`);
		}
		const resource = names.get(resourceName);
		if (!resource?.outputs.includes(outputName)) {
			throw new Error(`unresolved output reference ${value}`);
		}
	}
	return program;
}
