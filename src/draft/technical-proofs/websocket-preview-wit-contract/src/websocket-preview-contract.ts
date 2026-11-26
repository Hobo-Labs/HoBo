import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

const WIT_FILES = Object.freeze({
  wasi: "wit/wasi-websocket.wit",
  hobo: "wit/hobo-websocket.wit"
});

const WIT_PACKAGES = Object.freeze([
  {
    id: "wasi:websocket@0.0.1-draft",
    name: "wasi:websocket",
    version: "0.0.1-draft",
    stability: "preview",
    witPath: WIT_FILES.wasi
  },
  {
    id: "hobo:websocket@0.1.0",
    name: "hobo:websocket",
    version: "0.1.0",
    stability: "stable",
    witPath: WIT_FILES.hobo
  }
]);

export async function assertPreviewWebsocketContract(root) {
  const [wasiSource, hoboSource] = await Promise.all([
    readFile(join(root, WIT_FILES.wasi), "utf8"),
    readFile(join(root, WIT_FILES.hobo), "utf8")
  ]);

  assertPackage(wasiSource, WIT_PACKAGES[0]);
  assertPackage(hoboSource, WIT_PACKAGES[1]);
  assertContains(hoboSource, "use wasi:websocket/types@0.0.1-draft.{message};");

  const wasi = {
    functions: {
      "incoming-handler": parseInterfaceFunctions(wasiSource, "incoming-handler"),
      outgoing: parseInterfaceFunctions(wasiSource, "outgoing")
    }
  };
  const hobo = {
    functions: {
      extension: parseInterfaceFunctions(hoboSource, "extension")
    }
  };

  assert.deepEqual(wasi.functions["incoming-handler"], ["handle"]);
  assert.deepEqual(wasi.functions.outgoing, ["connect"]);
  assert.deepEqual(hobo.functions.extension, ["principal", "send-to", "join", "leave", "broadcast"]);

  return {
    packages: WIT_PACKAGES.map((entry) => ({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      stability: entry.stability,
      witPath: entry.witPath
    })),
    wasi,
    hobo
  };
}

export async function buildManifestFragment(root) {
  const [wasiSource, hoboSource] = await Promise.all([
    readFile(join(root, WIT_FILES.wasi), "utf8"),
    readFile(join(root, WIT_FILES.hobo), "utf8")
  ]);

  return {
    schema: "hobo.manifest.fragment/websocket-preview/v1",
    imports: [
      {
        interface: "wasi:websocket/outgoing",
        version: WIT_PACKAGES[0].version,
        stability: WIT_PACKAGES[0].stability,
        digest: digest(wasiSource)
      },
      {
        interface: "hobo:websocket/extension",
        version: WIT_PACKAGES[1].version,
        stability: WIT_PACKAGES[1].stability,
        digest: digest(hoboSource)
      }
    ],
    exports: [
      {
        interface: "wasi:websocket/incoming-handler",
        version: WIT_PACKAGES[0].version,
        stability: WIT_PACKAGES[0].stability,
        digest: digest(wasiSource)
      }
    ]
  };
}

export function staticFeedbackForImports(imports) {
  return imports
    .filter((entry) => entry.stability === "preview")
    .map((entry) => ({
      code: "interface.preview.pinned",
      severity: "warning",
      interface: entry.interface,
      version: entry.version,
      message: `${entry.interface}@${entry.version} is preview: pinned, may change before ratification.`,
      remediation: "Keep the exact manifest pin and require an upcaster for any preview version bump."
    }));
}

export function validatePreviewUpgrade({ from, to, upcasters }) {
  const edge = `${from}->${to}`;
  const result = {
    from,
    to,
    hoboExtension: "hobo:websocket@0.1.0"
  };

  if (from === to || upcasters.includes(edge)) {
    return { ok: true, code: "upcaster-present", ...result };
  }

  return { ok: false, code: "upcaster-required", ...result };
}

function assertPackage(source, expected) {
  assertContains(source, `package ${expected.id};`);
  assertContains(source, `/// stability: ${expected.stability}`);
}

function parseInterfaceFunctions(source, interfaceName) {
  const body = extractBlock(source, `interface ${interfaceName}`);
  return [...body.matchAll(/^\s*([%a-zA-Z0-9-]+):\s*func\b/gm)].map((match) => match[1]);
}

function extractBlock(source, prefix) {
  const start = source.indexOf(`${prefix} {`);
  assertTruthy(start >= 0, `missing WIT block ${prefix}`);

  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }

  throw new Error(`unterminated WIT block ${prefix}`);
}

function digest(source) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function assertContains(source, expected) {
  assertTruthy(source.includes(expected), `missing ${expected}`);
}

function assertTruthy(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
