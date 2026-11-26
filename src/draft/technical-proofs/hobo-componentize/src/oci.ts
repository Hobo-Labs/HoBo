import { createHash } from "node:crypto";

import { COMPONENT_MEDIA_TYPE, type OciDescriptor, type WasmComponentArtifact } from "./types.js";
import { stableStringify } from "./json.js";


export function buildOciDescriptor(
  artifact: WasmComponentArtifact,
  title: string,
): OciDescriptor {
  const configPayload = stableStringify({
    schema: "hobo.componentize.config/v1",
    witWorld: artifact.witWorld,
    componentDigest: artifact.digest,
  });
  const configDigest = sha256Text(configPayload);
  const manifest = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json" as const,
    artifactType: COMPONENT_MEDIA_TYPE,
    config: {
      mediaType: "application/vnd.hobo.componentize.config.v1+json" as const,
      digest: configDigest,
      size: Buffer.byteLength(configPayload),
    },
    layers: [
      {
        mediaType: COMPONENT_MEDIA_TYPE,
        digest: artifact.digest,
        size: artifact.bytes.byteLength,
      },
    ],
    annotations: {
      "org.opencontainers.image.title": title,
      "dev.hobo.wit.world": artifact.witWorld,
    },
  };

  const manifestJson = stableStringify(manifest);
  return Object.freeze({
    artifactType: COMPONENT_MEDIA_TYPE,
    manifest: Object.freeze({
      ...manifest,
      annotations: Object.freeze({ ...manifest.annotations }),
      config: Object.freeze({ ...manifest.config }),
      layers: Object.freeze(manifest.layers.map((layer) => Object.freeze({ ...layer }))),
    }),
    manifestDigest: sha256Text(manifestJson),
  });
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
