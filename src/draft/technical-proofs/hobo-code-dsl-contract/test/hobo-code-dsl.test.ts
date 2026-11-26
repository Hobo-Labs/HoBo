import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import { validateManifest } from "../../hobo-manifest-contract/src/manifest.js";
import {
  compareHoboCodeToTypescript,
  createHoboCodegenCommand,
  formatHoboCode,
  generateHoboCodeArtifacts,
  lowerHoboCode,
  lowerTypescriptBindle,
  parseHoboCode,
  withTempHoboCodeProject,
} from "../src/hobo-code-dsl.js";

const checkoutSource = `
bindle checkout in prod
camp prod in azure-yard
yard azure-yard provider azure region eastus
data db port hobo:data paradigm relational allow query
service api image oci://registry.example.com/checkout/api@sha256:abc123 bind db allow invoke
website storefront bind api allow serve
step sendTicketEmail input TicketEmailInput returns TicketEmailResult
workflow closeTicket input CloseTicketInput returns CloseTicketResult
`;

test("L1 Hobo Code lowers to the same manifest IR as an equivalent TypeScript Bindle", () => {
  const hoboCode = lowerHoboCode(checkoutSource);
  const typescript = lowerTypescriptBindle({
    bindle: "checkout",
    camp: "prod",
    yard: { name: "azure-yard", provider: "azure", region: "eastus" },
    resources: [
      { kind: "data", name: "db", port: "hobo:data", paradigm: "relational", allow: ["query"] },
      {
        kind: "service",
        name: "api",
        image: "oci://registry.example.com/checkout/api@sha256:abc123",
        bind: ["db"],
        allow: ["invoke"],
      },
      { kind: "website", name: "storefront", bind: ["api"], allow: ["serve"] },
    ],
    steps: [{ name: "sendTicketEmail", input: "TicketEmailInput", returns: "TicketEmailResult" }],
    workflows: [{ name: "closeTicket", input: "CloseTicketInput", returns: "CloseTicketResult" }],
  });

  assert.equal(hoboCode.manifestJson, typescript.manifestJson);
  assert.equal(hoboCode.manifestHash, typescript.manifestHash);
  assert.equal(validateManifest(hoboCode.manifest).valid, true);
  assert.deepEqual(compareHoboCodeToTypescript(hoboCode, typescript), {
    ok: true,
    manifestHash: hoboCode.manifestHash,
  });
});

test("L2 stub generation preserves allow scopes, stitched bindings, and drift check behavior", async () => {
  const ast = parseHoboCode(checkoutSource);
  const artifacts = generateHoboCodeArtifacts(ast);
  const stub = artifacts.find((entry) => entry.path === "src/_generated/hobo-code-stubs.ts");

  assert.ok(stub, "expected generated Hobo Code stub artifact");
  assert.match(stub.content, /data\("db"\)\.allow\("query"\)/);
  assert.match(
    stub.content,
    /service\("api", \{ bind: \{ db \} \}\)\.allow\("invoke"\)/,
  );
  assert.match(
    stub.content,
    /website\("storefront", \{ bind: \{ api \} \}\)\.allow\("serve"\)/,
  );
  assert.match(stub.content, /export declare function sendTicketEmail/);
  assert.doesNotMatch(stub.content, /\bany\b/);

  await withTempHoboCodeProject(async (projectRoot) => {
    const cli = createHoboCodegenCommand({ source: checkoutSource });
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);
    assert.equal((await cli.run(["codegen", "--check"], { cwd: projectRoot })).exitCode, 0);

    const stalePath = join(projectRoot, "src/_generated/hobo-code-stubs.ts");
    await writeFile(stalePath, "// stale stubs\n");
    const check = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });

    assert.equal(check.exitCode, 1);
    assert.deepEqual(JSON.parse(check.stdout).drift, [
      { status: "changed", path: "src/_generated/hobo-code-stubs.ts" },
    ]);
    assert.equal(await readFile(stalePath, "utf8"), "// stale stubs\n");
  });
});

test("canonical formatter is idempotent and sorts declarations into stable AST order", () => {
  const messy = `
service api bind db allow invoke image oci://registry.example.com/checkout/api@sha256:abc123
website storefront allow serve bind api
data db allow query paradigm relational port hobo:data
yard azure-yard region eastus provider azure
workflow closeTicket returns CloseTicketResult input CloseTicketInput
camp prod in azure-yard
bindle checkout in prod
step sendTicketEmail returns TicketEmailResult input TicketEmailInput
`;

  const once = formatHoboCode(messy);
  const twice = formatHoboCode(once);

  assert.equal(once, twice);
  assert.equal(once, `${checkoutSource.trim()}\n`);
});

test("front-end divergence is reported as a contract failure, not accepted silently", () => {
  const hoboCode = lowerHoboCode(checkoutSource);
  const divergentTs = lowerTypescriptBindle({
    bindle: "checkout",
    camp: "prod",
    yard: { name: "azure-yard", provider: "azure", region: "eastus" },
    resources: [
      { kind: "data", name: "db", port: "hobo:data", paradigm: "relational", allow: ["query"] },
      {
        kind: "service",
        name: "api",
        image: "oci://registry.example.com/checkout/api@sha256:abc123",
        bind: ["db"],
        allow: ["invoke", "admin"],
      },
    ],
  });

  assert.throws(
    () => compareHoboCodeToTypescript(hoboCode, divergentTs, { throwOnMismatch: true }),
    /manifest IR divergence/,
  );
});

test("declaration-time side effects and host imports fail closed during parse", () => {
  assert.throws(
    () => parseHoboCode(`${checkoutSource}\nimport fs from "node:fs"\n`),
    /declaration-time side effect is forbidden/,
  );
  assert.throws(
    () => parseHoboCode(`${checkoutSource}\nexec npm install\n`),
    /declaration-time side effect is forbidden/,
  );
});

test("pure L1 no-code stack produces a valid deployable manifest without stub bodies", () => {
  const source = `
yard local-yard provider local region dev
camp preview in local-yard
bindle marketing in preview
data db port hobo:data allow query
service api bind db allow invoke
`;

  const lowered = lowerHoboCode(source);
  const api = lowered.manifest.resources.api;

  assert.equal(validateManifest(lowered.manifest).valid, true);
  assert.equal(api.image, undefined);
  assert.deepEqual(api.links, [{ import: "hobo:data", to: "db" }]);

  const stub = generateHoboCodeArtifacts(parseHoboCode(source)).find(
    (entry) => entry.path === "src/_generated/hobo-code-stubs.ts",
  );
  assert.ok(stub);
  assert.doesNotMatch(stub.content, /TODO|throw new Error|body/);
});
