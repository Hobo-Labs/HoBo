import { describe, expect, it } from "vitest";

import { buildHelloBindle, componentizeRealBuildSkipReason } from "./helpers.js";

const realBuildIt = componentizeRealBuildSkipReason ? it.skip : it;

describe("componentize OCI descriptor", () => {
  realBuildIt("builds a canonical manifest with expected annotations", async () => {
    const result = await buildHelloBindle();

    expect(result.oci.artifactType).toBe("application/vnd.wasm.component.v1+wasm");
    expect(result.oci.manifest.artifactType).toBe("application/vnd.wasm.component.v1+wasm");
    expect(result.oci.manifest.mediaType).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(result.oci.manifest.layers[0]?.digest).toBe(result.component.digest);
    expect(result.oci.manifest.annotations["org.opencontainers.image.title"]).toBe("hello-bindle");
    expect(result.oci.manifest.annotations["dev.hobo.wit.world"]).toBe(
      "hobo:examples/hello-bindle@0.1.0",
    );
    expect(result.oci.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 180_000);
});
