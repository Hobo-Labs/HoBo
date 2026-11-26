import {
	componentizeHelloBindle,
	validateWasmComponentArtifact,
} from "../../../../../packages/componentize/src/index.js";

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
};

export type ComponentizeFn = (input: ComponentizeInput) => Promise<ComponentizeOutput>;

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
