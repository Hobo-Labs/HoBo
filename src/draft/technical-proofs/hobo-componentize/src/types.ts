export const PINNED_TOOLCHAIN = Object.freeze({
  jco: "1.24.3",
  componentizeJs: "0.21.0",
  wasmTools: "1.235.0",
  wasmtime: "46.0.1",
});

export type ToolchainPin = typeof PINNED_TOOLCHAIN;

export const COMPONENT_MEDIA_TYPE = "application/vnd.wasm.component.v1+wasm" as const;

export const DEFAULT_CI_MATRIX = Object.freeze({
  os: ["ubuntu-latest", "windows-latest"] as const,
  node: ["22.x"] as const,
  toolchain: PINNED_TOOLCHAIN,
});

export type ComponentizeSpec = Readonly<{
  name: string;
  sourceRoot: string;
  entrypoint: string;
  witDir: string;
  worldName: string;
  sourceDateEpoch: string;
  toolchain: ToolchainPin;
}>;

export type SourceFileDigest = Readonly<{
  path: string;
  digest: string;
}>;

export type WasmComponentArtifact = Readonly<{
  path: string;
  mediaType: typeof COMPONENT_MEDIA_TYPE;
  digest: string;
  bytes: Uint8Array;
  witWorld: string;
}>;

export type OciDescriptor = Readonly<{
  artifactType: typeof COMPONENT_MEDIA_TYPE;
  manifest: Readonly<{
    schemaVersion: 2;
    mediaType: "application/vnd.oci.image.manifest.v1+json";
    artifactType: typeof COMPONENT_MEDIA_TYPE;
    config: Readonly<{
      mediaType: "application/vnd.hobo.componentize.config.v1+json";
      digest: string;
      size: number;
    }>;
    layers: ReadonlyArray<
      Readonly<{
        mediaType: typeof COMPONENT_MEDIA_TYPE;
        digest: string;
        size: number;
      }>
    >;
    annotations: Readonly<Record<string, string>>;
  }>;
  manifestDigest: string;
}>;

export type ValidationReport = Readonly<{
  passed: true;
  command: string;
  format: string;
}>;

export type SmokeReport = Readonly<{
  exitCode: 0;
  stdout: string;
  command: string;
}>;

export type ComponentizeResult = Readonly<{
  component: WasmComponentArtifact;
  oci: OciDescriptor;
  reproducibility: Readonly<{
    controls: readonly string[];
    inputsDigest: string;
    sourceDigests: readonly SourceFileDigest[];
  }>;
  ciMatrix: typeof DEFAULT_CI_MATRIX;
}>;
