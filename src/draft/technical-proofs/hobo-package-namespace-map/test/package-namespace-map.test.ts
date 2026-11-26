import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertNoForbiddenReexport,
  packageForSymbol,
  validateAgentImports,
  validateImportStatement
} from "../src/package-namespace-map.js";

describe("package namespace map", () => {
  it("keeps app authoring resources in @hobo/bindles", () => {
    for (const symbol of ["bindle", "database", "queue", "connector", "config", "secretRef"]) {
      assert.equal(packageForSymbol(symbol), "@hobo/bindles");
    }
  });

  it("keeps runtime primitives out of @hobo/bindles", () => {
    assert.equal(packageForSymbol("workflow"), "@hobo/runtime");
    assert.equal(packageForSymbol("step"), "@hobo/runtime");

    assert.deepEqual(validateImportStatement({
      from: "@hobo/bindles",
      symbols: ["bindle", "workflow", "step"]
    }), [
      "workflow must be imported from @hobo/runtime, not @hobo/bindles",
      "step must be imported from @hobo/runtime, not @hobo/bindles"
    ]);
  });

  it("keeps data-plane and event helpers in their own app packages", () => {
    assert.equal(packageForSymbol("command"), "@hobo/data");
    assert.equal(packageForSymbol("view"), "@hobo/data");
    assert.equal(packageForSymbol("repo"), "@hobo/data");
    assert.equal(packageForSymbol("emit"), "@hobo/events");
    assert.equal(packageForSymbol("saga"), "@hobo/events");
  });

  it("keeps topology factories in topology packages", () => {
    assert.equal(packageForSymbol("camp"), "@hobo/camps");
    assert.equal(packageForSymbol("yard"), "@hobo/yards");
    assert.equal(packageForSymbol("junction"), "@hobo/junctions");

    assert.deepEqual(assertNoForbiddenReexport("@hobo/bindles", ["bindle", "camp", "yard", "junction"]), [
      "camp",
      "yard",
      "junction"
    ]);
  });

  it("keeps npm @hobo/sdk unambiguously operator-owned", () => {
    for (const symbol of ["defineResource", "policyPack", "runbook", "dispatcher", "runner", "chaos"]) {
      assert.equal(packageForSymbol(symbol), "@hobo/sdk");
    }

    assert.deepEqual(validateImportStatement({
      from: "@hobo/sdk",
      symbols: ["defineResource", "bindle"]
    }), [
      "bindle must be imported from @hobo/bindles, not @hobo/sdk"
    ]);
  });

  it("separates secret resource declarations from secret references", () => {
    assert.equal(packageForSymbol("secret"), "@hobo/bindles");
    assert.equal(packageForSymbol("secretRef"), "@hobo/bindles");
    assert.notEqual("secret", "secretRef");
  });

  it("rejects public agent SDK imports", () => {
    assert.deepEqual(validateAgentImports([
      { from: "@hobo/runtime", imported: "agent" },
      { from: "@hobo/sdk", imported: "agent", alias: "crewAgent" }
    ]), [
      "agent is not a public SDK factory; use connector(..., { protocol }) instead of importing from @hobo/runtime",
      "agent is not a public SDK factory; use connector(..., { protocol }) instead of importing from @hobo/sdk"
    ]);

    assert.deepEqual(validateAgentImports([
      { from: "@hobo/bindles", imported: "connector" }
    ]), []);
  });
});
