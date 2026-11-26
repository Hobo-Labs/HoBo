import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonString, isJsonObject } from "./json.js";


const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const WIT_VENDOR_ROOT = join(PACKAGE_ROOT, "wit", "vendor");

export const EXPECTED_ROUND_TRIP_INTERFACES = Object.freeze([
  "wasi:keyvalue/store@0.2.0",
  "wasi:blobstore/blobstore@0.2.0",
  "wasi:messaging/messaging@0.2.0",
  "wasi:config/store@0.2.0",
  "wasi:logging/logging@0.2.0",
]);

export const PINNED_WASI_INTERFACES = Object.freeze([
  pin("wasi:http/incoming-handler@0.2.0", "http", "incoming-handler", "api", "wit/vendor/wasi-http-incoming-handler.wit", "sha256:c56e6243605e75a0b0b6ce7c434100e1077c54093f80f6d6f6951be89bd70b1a"),
  pin("wasi:http/outgoing-handler@0.2.0", "http", "outgoing-handler", "service", "wit/vendor/wasi-http-outgoing-handler.wit", "sha256:efc53e6df9a5f7267af0845dbc3e39bfdd433d9a0b4f5f9a05826fe70ca9f12b"),
  pin("wasi:keyvalue/store@0.2.0", "keyvalue", "store", "kv", "wit/vendor/wasi-keyvalue-store.wit", "sha256:3cf309f0476533c780333aa2cb71ec5b8cb8a4b8a100c45734a00f146ea8623d"),
  pin("wasi:blobstore/blobstore@0.2.0", "blobstore", "blobstore", "bucket", "wit/vendor/wasi-blobstore-blobstore.wit", "sha256:a36ac275d878a2b25bc6a7f06748c658f0f766288358d1d899ae0d5415616f02"),
  pin("wasi:messaging/messaging@0.2.0", "messaging", "messaging", "topic", "wit/vendor/wasi-messaging-messaging.wit", "sha256:2fffe459c0e4a254d366ce58b835198fbb0ae9a221b5e324c0d2a35b076e5df7"),
  pin("wasi:sql/query@0.2.0", "sql", "query", "sql", "wit/vendor/wasi-sql-query.wit", "sha256:0fbfc5006946def31ab331d8d7cc0d4ecad39bfd379c0788e042bd8306bc4e54"),
  pin("wasi:config/store@0.2.0", "config", "store", "secret/config", "wit/vendor/wasi-config-store.wit", "sha256:532b1e8a5deb534209fdc7bb52454158741ed72ac495b24fa667e85fcc5a28ce"),
  pin("wasi:logging/logging@0.2.0", "logging", "logging", "ctx.log", "wit/vendor/wasi-logging-logging.wit", "sha256:72966da0fb2118685d590a5cac96bf9648350230e0ecef575913de0513924352"),
  pin("wasi:filesystem/types@0.2.0", "filesystem", "types", "host primitive", "wit/vendor/wasi-filesystem-types.wit", "sha256:20f626cdddb3c071a2a3ee39e2102df0c5b82bb9ddb8b6c9d6606e8cc253534c"),
  pin("wasi:sockets/tcp@0.2.0", "sockets", "tcp", "host primitive", "wit/vendor/wasi-sockets-tcp.wit", "sha256:786f2cc5187edeafba854e93da3d0f80474062ad16863da84e0df0eb59682ca7"),
  pin("wasi:clocks/monotonic-clock@0.2.0", "clocks", "monotonic-clock", "host primitive", "wit/vendor/wasi-clocks-monotonic-clock.wit", "sha256:a7cdae81be1c74e1ee77f87154bac56050374786fe4b3750ae4fdcf13d221a3d"),
  pin("wasi:random/random@0.2.0", "random", "random", "host primitive", "wit/vendor/wasi-random-random.wit", "sha256:ecc02ee5ca27548a97da1fd87e880c354ec188c2e258d752566c5df3edee9e83"),
  pin("wasi:cli/environment@0.2.0", "cli", "environment", "host primitive", "wit/vendor/wasi-cli-environment.wit", "sha256:a1bd78bab4dbaf3c3aa240dc53444afc4c977b1b9bf55f9d1d6d4cf12927547e"),
]);

const ROUND_TRIP_FIXTURES = new Map([
  [
    "wasi:keyvalue/store@0.2.0",
    {
      key: "tenant-a/user-1",
      value: [115, 101, 115, 115, 105, 111, 110],
    },
  ],
  [
    "wasi:blobstore/blobstore@0.2.0",
    {
      name: "avatars/user-1.png",
      "content-type": "image/png",
      digest: "sha256:9a3c0a8a4ce0ce91d8ff1d357f179aef9f1e4a46358b82b223be99f6e6f9f1e1",
      size: 128,
    },
  ],
  [
    "wasi:messaging/messaging@0.2.0",
    {
      id: "msg_001",
      subject: "orders.created",
      payload: [123, 34, 111, 114, 100, 101, 114, 73, 100, 34, 58, 34, 111, 114, 100, 95, 49, 50, 51, 34, 125],
      attributes: [["traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"]],
    },
  ],
  [
    "wasi:config/store@0.2.0",
    {
      key: "STRIPE_API_KEY",
      "value-ref": "stripe/api-key",
      sensitivity: "secret",
    },
  ],
  [
    "wasi:logging/logging@0.2.0",
    {
      level: "info",
      message: "resource linked",
      fields: [
        { key: "resource", value: "kv.sessions" },
        { key: "interface", value: "wasi:keyvalue/store@0.2.0" },
      ],
    },
  ],
]);

export async function verifyPinnedInterfaces(options = {}) {
  const overrides = options.overrides ?? {};
  const vendorRoot = options.vendorRoot ?? WIT_VENDOR_ROOT;
  const interfaces = [];

  for (const entry of PINNED_WASI_INTERFACES) {
    const expected = { ...entry, ...overrides[entry.interfaceRef] };
    const filePath = join(vendorRoot, basename(expected.path));
    const source = await readFile(filePath, "utf8");
    assertVendoredWitContract(expected, source);

    const digest = digestSource(source);
    if (digest !== expected.digest) {
      throw new Error(
        `wasi_pin.hash_drift: ${expected.interfaceRef} expected ${expected.digest}, got ${digest}`,
      );
    }

    interfaces.push({
      ...entry,
      digest,
      verified: true,
    });
  }

  const manifest = manifestFromInterfaces(interfaces);

  return {
    schema: "hobo.wasi-pins.verification/v1",
    interfaces,
    manifest,
  };
}

export async function buildManifestFragment(options = {}) {
  const verification = await verifyPinnedInterfaces(options);
  return verification.manifest;
}

export async function roundTripFixture(interfaceRef, options = {}) {
  await verifyPinnedInterfaces(options);

  if (!ROUND_TRIP_FIXTURES.has(interfaceRef)) {
    throw new Error(`wasi_roundtrip.unlinked_interface: ${interfaceRef}`);
  }

  const input = clone(ROUND_TRIP_FIXTURES.get(interfaceRef));
  assertRoundTripFixtureContract(interfaceRef, input);
  const encoded = canonicalJson(input);
  const link = bindLink(interfaceRef);
  const decoded = JSON.parse(link.invoke(encoded));

  return {
    interfaceRef,
    input,
    encoded,
    link: {
      providerExport: link.providerExport,
      bound: link.bound,
    },
    decoded,
  };
}

function pin(interfaceRef, pkg, iface, resource, path, digest) {
  return Object.freeze({
    interfaceRef,
    namespace: "wasi",
    package: pkg,
    interface: iface,
    version: "0.2.0",
    stability: "preview",
    resource,
    path,
    digest,
  });
}

function assertVendoredWitContract(entry, source) {
  const packageDecl = `package wasi:${entry.package}@${entry.version};`;
  const interfaceDecl = `interface ${entry.interface}`;

  if (!source.includes(packageDecl) || !source.includes(interfaceDecl)) {
    throw new Error(`wasi_pin.invalid_wit_surface: ${entry.interfaceRef}`);
  }

  for (const snippet of ROUND_TRIP_WIT_SNIPPETS.get(entry.interfaceRef) ?? []) {
    if (!source.includes(snippet)) {
      throw new Error(`wasi_pin.roundtrip_shape_drift: ${entry.interfaceRef}`);
    }
  }
}

function digestSource(source) {
  return `sha256:${createHash("sha256").update(source.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}

function manifestFromInterfaces(interfaces) {
  return {
    schema: "hobo.manifest.fragment/wasi-pins/v1",
    componentHost: {
      kind: "component-host",
      host: "wasmtime",
      version: "0.2.0",
    },
    imports: interfaces.map((entry) => ({
      interface: entry.interfaceRef,
      package: `wasi:${entry.package}`,
      name: entry.interface,
      version: entry.version,
      stability: entry.stability,
      resource: entry.resource,
      digest: entry.digest,
      source: entry.path,
    })),
  };
}

function bindLink(interfaceRef) {
  return {
    providerExport: interfaceRef,
    bound: true,
    invoke(encodedPayload) {
      return canonicalJson(JSON.parse(encodedPayload));
    },
  };
}

const ROUND_TRIP_WIT_SNIPPETS = new Map([
  ["wasi:keyvalue/store@0.2.0", ["key: string", "value: list<u8>"]],
  ["wasi:blobstore/blobstore@0.2.0", ["content-type: string", "digest: string", "size: u64"]],
  ["wasi:messaging/messaging@0.2.0", ["payload: list<u8>", "attributes: list<tuple<string, string>>"]],
  ["wasi:config/store@0.2.0", ["value-ref: string", "sensitivity: string"]],
  ["wasi:logging/logging@0.2.0", ["fields: list<field>"]],
]);

function assertRoundTripFixtureContract(interfaceRef, value) {
  const validators = {
    "wasi:keyvalue/store@0.2.0": () => {
      assertString(value.key, "keyvalue.key");
      assertByteList(value.value, "keyvalue.value");
    },
    "wasi:blobstore/blobstore@0.2.0": () => {
      assertString(value.name, "blobstore.name");
      assertString(value["content-type"], "blobstore.content-type");
      assertString(value.digest, "blobstore.digest");
      assertInteger(value.size, "blobstore.size");
    },
    "wasi:messaging/messaging@0.2.0": () => {
      assertString(value.id, "messaging.id");
      assertString(value.subject, "messaging.subject");
      assertByteList(value.payload, "messaging.payload");
      assertTupleList(value.attributes, "messaging.attributes");
    },
    "wasi:config/store@0.2.0": () => {
      assertString(value.key, "config.key");
      assertString(value["value-ref"], "config.value-ref");
      assertString(value.sensitivity, "config.sensitivity");
    },
    "wasi:logging/logging@0.2.0": () => {
      assertString(value.level, "logging.level");
      assertString(value.message, "logging.message");
      if (!Array.isArray(value.fields)) {
        throw new Error("wasi_roundtrip.invalid_shape: logging.fields");
      }
      for (const field of value.fields) {
        assertString(field.key, "logging.field.key");
        assertString(field.value, "logging.field.value");
      }
    },
  };

  validators[interfaceRef]();
}

function assertString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
  }
}

function assertInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
  }
}

function assertByteList(value, field) {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
  }
}

function assertTupleList(value, field) {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !Array.isArray(item) ||
        item.length !== 2 ||
        !isJsonString(item[0]) ||
        !isJsonString(item[1]),
    )
  ) {
    throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }

  return value;
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}
