import {
	componentizeHelloBindle,
	type RealComponentize,
	validateWasmComponentArtifact,
	type WasmOciDescriptor,
} from "@hobo/componentize";

import type { BuildArtifact } from "./parse.js";

export type ComponentizeInput = {
	readonly sourceRoot: string;
	readonly sourceDateEpoch: string;
};

export type ComponentizeOutput = {
	readonly component: {
		readonly path: string;
		readonly mediaType: string;
		readonly digest: string;
		readonly bytes: Buffer;
		readonly witWorld: string;
	};
	readonly oci?: WasmOciDescriptor;
};

export type ComponentizeFn = (
	input: ComponentizeInput,
) => Promise<ComponentizeOutput>;

export const defaultComponentize: ComponentizeFn = async (input) => {
	const result = await componentizeHelloBindle({
		sourceRoot: input.sourceRoot,
		sourceDateEpoch: input.sourceDateEpoch,
	});
	validateWasmComponentArtifact(result.component);
	return {
		component: {
			path: result.component.path,
			mediaType: result.component.mediaType,
			digest: result.component.digest,
			bytes: Buffer.from(result.component.bytes),
			witWorld: result.component.witWorld,
		},
	};
};

export function adaptRealComponentize(real: RealComponentize): ComponentizeFn {
	return async (input) => {
		const result = await real.componentize({
			sourceRoot: input.sourceRoot,
			sourceDateEpoch: input.sourceDateEpoch,
		});
		return {
			component: {
				path: result.component.path,
				mediaType: result.component.mediaType,
				digest: result.component.digest,
				bytes: Buffer.from(result.component.bytes),
				witWorld: result.component.witWorld,
			},
			oci: result.oci,
		};
	};
}

export function toWasmBuildArtifact(
	serviceName: string,
	entrypoint: string,
	component: ComponentizeOutput["component"],
	artifactPath: string,
): BuildArtifact {
	return {
		service: serviceName,
		kind: "wasm-component",
		path: artifactPath,
		mediaType: component.mediaType,
		digest: component.digest,
		runtime: "wasm-component",
		witWorld: component.witWorld,
		source: entrypoint,
	};
}
