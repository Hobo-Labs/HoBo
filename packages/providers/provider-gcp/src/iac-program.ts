import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

// Local, dependency-free mirror of the @hobo/iac-pulumi published IacProgram wire
// shape. The package boundary guard forbids adapter -> adapter runtime imports
// (providers may import only core ports), so realize() emits this plain typed
// object rather than importing @hobo/iac-pulumi. The real
// @hobo/iac-pulumi.validateIacProgram() is exercised test-only to prove the two
// packages compose.
// public-contract: the IacProgram schema version this provider emits.
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
// public-contract: the IacProgram kind discriminator.
export const IAC_PROGRAM_KIND = "iac-program";
// public-contract: the primary IaC lane realized programs target.
export const IAC_PROVIDER = "pulumi";
// public-contract: the provider token stamped on emitted resources/stacks.
export const GCP_IAC_PROVIDER = "gcp";

// domain-view: structural mirror of the iac-pulumi resource DTO; the generated
// wire types live in that adapter, this is the emit-side derived shape.
export interface IacResource {
	name: string;
	type: string;
	provider: string;
	inputs: JsonObject;
	outputs: string[];
}

// domain-view: structural mirror of the iac-pulumi program DTO validated by
// validateIacProgram(); kept local so this adapter has no adapter->adapter edge.
export interface IacProgram {
	apiVersion: typeof IAC_PROGRAM_API_VERSION;
	kind: typeof IAC_PROGRAM_KIND;
	provider: typeof IAC_PROVIDER;
	deploymentId: string;
	stack: string;
	resources: IacResource[];
	stackOutputs: Record<string, string>;
}

const OUTPUT_REF =
	/^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;

/**
 * Parse-don't-validate structural check used by tests as a LOCAL copy of the
 * iac-pulumi program shape. Mirrors @hobo/iac-pulumi.validateIacProgram so the
 * emit side can be asserted without a runtime dependency on that adapter. Returns
 * a frozen parsed derived program or throws.
 */
export function assertLocalIacProgram(program: IacProgram): IacProgram {
	if (program.apiVersion !== IAC_PROGRAM_API_VERSION) {
		throw new Error(`IacProgram apiVersion must be ${IAC_PROGRAM_API_VERSION}`);
	}
	if (program.kind !== IAC_PROGRAM_KIND) {
		throw new Error("IacProgram kind must be iac-program");
	}
	if (program.provider !== IAC_PROVIDER) {
		throw new Error("IacProgram provider must be pulumi");
	}
	if (!Array.isArray(program.resources) || program.resources.length === 0) {
		throw new Error("IacProgram must include at least one resource");
	}

	const names = new Map<string, IacResource>();
	for (const resource of program.resources) {
		if (!resource.name) {
			throw new Error("IacProgram resource missing name");
		}
		if (names.has(resource.name)) {
			throw new Error(
				`IacProgram includes duplicate resource ${resource.name}`,
			);
		}
		names.set(resource.name, resource);
	}

	for (const value of collectValues(
		parseJsonValue(JSON.stringify(program.resources)),
	)) {
		assertOutputReference(value, names);
	}
	for (const value of Object.values(program.stackOutputs)) {
		assertOutputReference(value, names);
	}

	return program;
}

function assertOutputReference(
	value: JsonValue,
	resources: Map<string, IacResource>,
): void {
	if (!isJsonString(value) || !value.startsWith("${resources.")) {
		return;
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
	const resource = resources.get(resourceName);
	if (resource === undefined || !resource.outputs.includes(outputName)) {
		throw new Error(
			`unresolved output reference resources.${resourceName}.outputs.${outputName}`,
		);
	}
}

function collectValues(value: JsonValue): JsonValue[] {
	if (isJsonArray(value)) {
		return value.flatMap((entry) => collectValues(entry));
	}
	if (isJsonObject(value)) {
		return Object.values(value).flatMap((child) =>
			collectValues(child ?? null),
		);
	}
	return [value];
}
