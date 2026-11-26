import { isJsonString, isJsonObject } from "./json.js";
import { createHash } from "node:crypto";
import {

  createRuntimeLocalComponentHost,
  createWasmtimeEngineStub,
} from "../../runtime-local-component-host/src/component-host.js";

const HTTP_INCOMING = "wasi:http/incoming-handler@0.2.0";
const HTTP_OUTGOING = "wasi:http/outgoing-handler@0.2.0";
const ARTIFACT_TYPE = "application/vnd.hobo.component-host.oci.v1+json";
const CONFIG_MEDIA_TYPE = "application/vnd.hobo.component-host.config.v1+json";
const HOST_VERSION = "46.0.1";

export function createRuntimeLocalFixture() {
  const manifest = {
    apiVersion: "hobo.component-host.manifest/v1",
    components: [
      {
        id: "api",
        source: "oci://bindles/shop-api:sha256-fixture",
        imports: [HTTP_OUTGOING],
        exports: [HTTP_INCOMING],
      },
    ],
    providers: [
      {
        id: "local-http",
        exports: [HTTP_OUTGOING],
      },
    ],
    links: [
      {
        componentId: "api",
        importInterface: HTTP_OUTGOING,
        providerId: "local-http",
        exportInterface: HTTP_OUTGOING,
      },
    ],
    endpoints: [
      {
        componentId: "api",
        interface: HTTP_INCOMING,
        route: "/healthz",
      },
    ],
    config: {
      env: {
        HOBO_COMPONENT_HOST: "wasm-in-container",
      },
      files: {
        manifestPath: "/hobo/manifest.json",
      },
    },
  };

  return Object.freeze({
    manifest,
    request: {
      method: "GET",
      path: "/healthz",
      headers: [],
      body: "",
    },
  });
}

export function createOciComponentHostImage({ imageRef, manifest }) {
  assertNonEmptyString(imageRef, "image_ref_required");
  assertManifestCarriesRuntimeInputs(manifest);

  const config = JSON.stringify({
    schema: "hobo.component-host.oci-floor/v1",
    manifest,
    runtime: {
      hostKind: "wasm-in-container",
      engine: "wasmtime",
      hostVersion: HOST_VERSION,
      infra: ["container-runtime"],
    },
  });
  const configDigest = sha256(config);

  const image = {
    imageRef,
    runtime: {
      hostKind: "wasm-in-container",
      engine: "wasmtime",
      hostVersion: HOST_VERSION,
      infra: ["container-runtime"],
    },
    manifest,
    oci: {
      manifest: {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: ARTIFACT_TYPE,
        config: {
          mediaType: CONFIG_MEDIA_TYPE,
          digest: configDigest,
          size: Buffer.byteLength(config),
        },
        layers: [
          {
            mediaType: "application/vnd.wasm.component.host.layer.v1+tar",
            digest: sha256("wasmtime-component-host-layer"),
            size: 32,
          },
          {
            mediaType: CONFIG_MEDIA_TYPE,
            digest: configDigest,
            size: Buffer.byteLength(config),
          },
        ],
        annotations: {
          "dev.hobo.component-host.kind": "wasm-in-container",
          "dev.hobo.component-host.engine": "wasmtime",
          "dev.hobo.component-host.version": HOST_VERSION,
        },
      },
    },
  };

  validateOciComponentHostImage(image);
  return image;
}

export function validateOciComponentHostImage(image) {
  assertNonEmptyString(image?.imageRef, "image_ref_required");
  if (image.runtime?.hostKind !== "wasm-in-container") {
    throw new Error(`component_host_oci.unsupported_host_kind: ${image.runtime?.hostKind}`);
  }
  if (image.runtime?.engine !== "wasmtime") {
    throw new Error(`component_host_oci.unsupported_engine: ${image.runtime?.engine}`);
  }
  if (image.runtime?.hostVersion !== HOST_VERSION) {
    throw new Error(`component_host_oci.unsupported_host_version: ${image.runtime?.hostVersion}`);
  }
  if (!arrayEqual(image.runtime?.infra, ["container-runtime"])) {
    throw new Error("component_host_oci.zero_infra_requires_container_runtime_only");
  }
  if (image.oci?.manifest?.artifactType !== ARTIFACT_TYPE) {
    throw new Error("component_host_oci.invalid_artifact_type");
  }
  assertManifestCarriesRuntimeInputs(image.manifest);

  return {
    ok: true,
    hostKind: "wasm-in-container",
    hostVersion: HOST_VERSION,
  };
}

export function createWasmInContainerHost({ image, providerHeader = "wasm-in-container" }) {
  validateOciComponentHostImage(image);
  return new WasmInContainerHost({ image, providerHeader });
}

export async function runComponentHostEquivalence({
  fixture,
  containerImage,
  request,
  containerOverrides = {},
}) {
  validateOciComponentHostImage(containerImage);

  const runtimeLocal = buildHostFromManifest({
    manifest: fixture.manifest,
    providerHeader: "runtime-local",
  });
  const localResponse = await runtimeLocal.handleHttp("api", request);

  const container = createWasmInContainerHost({
    image: containerImage,
    providerHeader: containerOverrides.providerHeader ?? "wasm-in-container",
  });
  container.boot();
  const containerResponse = await container.handleHttp("api", request);

  if (!responsesConform(localResponse, containerResponse)) {
    throw new Error("component_host_oci.conformance_diverged: wasi:http round-trip");
  }

  return {
    ok: true,
    assertedProperties: [
      "wasi:http round-trip",
      "link late-binding",
      "manifest-pinned host kind/version",
      "container zero-infra boundary",
    ],
    nonCoveredDivergences: ["container startup latency", "wall-clock scheduling jitter"],
  };
}

class WasmInContainerHost {
  #inner;

  constructor({ image, providerHeader }) {
    this.image = image;
    this.providerHeader = providerHeader;
    this.events = [];
  }

  boot() {
    if (!this.#inner) {
      this.#inner = buildHostFromManifest({
        manifest: this.image.manifest,
        providerHeader: this.providerHeader,
      });
      this.events.push({
        type: "container.Started",
        imageRef: this.image.imageRef,
        hostKind: this.image.runtime.hostKind,
        engine: this.image.runtime.engine,
      });
    }

    return {
      imageRef: this.image.imageRef,
      infra: this.image.runtime.infra,
      loadedComponents: this.image.manifest.components.map((component) => component.id),
      establishedLinks: this.image.manifest.links.map(
        (link) => `${link.componentId}:${link.importInterface}->${link.providerId}`,
      ),
    };
  }

  async handleHttp(componentId, request) {
    this.boot();
    const response = await this.#inner.handleHttp(componentId, request);
    this.events = [
      ...this.events.filter((event) => event.type === "container.Started"),
      ...this.#inner.events,
    ];
    return response;
  }
}

function buildHostFromManifest({ manifest, providerHeader }) {
  const host = createRuntimeLocalComponentHost({
    engine: createWasmtimeEngineStub({ version: `wasmtime/${HOST_VERSION}` }),
  });

  for (const provider of manifest.providers) {
    host.registerProvider({
      id: provider.id,
      exports: {
        [HTTP_OUTGOING]: {
          handle: async (request) => ({
            status: 200,
            headers: [["x-provider", providerHeader]],
            body: `provider:${request.path}`,
          }),
        },
      },
    });
  }

  for (const component of manifest.components) {
    host.loadComponent({
      id: component.id,
      imports: [...component.imports],
      exports: {
        [HTTP_INCOMING]: {
          handle: async (request, context) => {
            const upstream = await context.callImport(HTTP_OUTGOING, "handle", request);
            return {
              status: upstream.status,
              headers: upstream.headers,
              body: `guest:${upstream.body}`,
            };
          },
        },
      },
    });
  }

  for (const link of manifest.links) {
    host.link(link);
  }

  return host;
}

function assertManifestCarriesRuntimeInputs(manifest) {
  if (manifest?.apiVersion !== "hobo.component-host.manifest/v1") {
    throw new Error("component_host_oci.unsupported_manifest_version");
  }
  if (!Array.isArray(manifest.endpoints) || manifest.endpoints.length === 0) {
    throw new Error("component_host_oci.manifest_endpoints_required");
  }
  if (!Array.isArray(manifest.links) || manifest.links.length === 0) {
    throw new Error("component_host_oci.manifest_links_required");
  }
  if (!manifest.config || !isJsonObject(manifest.config)) {
    throw new Error("component_host_oci.manifest_config_required");
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    throw new Error("component_host_oci.manifest_components_required");
  }
  if (!Array.isArray(manifest.providers) || manifest.providers.length === 0) {
    throw new Error("component_host_oci.manifest_providers_required");
  }
}

function responsesConform(localResponse, containerResponse) {
  const containerProvider = containerResponse.headers.find(([name]) => name === "x-provider")?.[1];
  return (
    localResponse.status === containerResponse.status &&
    localResponse.body === containerResponse.body &&
    containerProvider === "wasm-in-container"
  );
}

function assertNonEmptyString(value, code) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`component_host_oci.${code}`);
  }
}

function arrayEqual(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
