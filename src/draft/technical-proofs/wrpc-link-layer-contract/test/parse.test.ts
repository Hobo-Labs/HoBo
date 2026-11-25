import assert from "node:assert/strict";
import { test } from "vitest";

import { parseInterfaceId, parseWireVersion } from "../src/ports.js";

test("parseWireVersion accepts valid semver", () => {
  assert.deepEqual(parseWireVersion("1.2.3"), {
    raw: "1.2.3",
    major: 1,
    minor: 2,
    patch: 3,
  });
  assert.deepEqual(parseWireVersion("1.2.3-rc.1").raw, "1.2.3-rc.1");
});

test("parseWireVersion rejects malformed semver", () => {
  assert.throws(() => parseWireVersion("1.2"), /invalid_semver/);
  assert.throws(() => parseWireVersion("v1.2.3"), /invalid_semver/);
  assert.throws(() => parseWireVersion(""), /invalid_semver/);
});

test("parseInterfaceId accepts versioned WIT interface ids", () => {
  const id = parseInterfaceId("wasi:keyvalue/store@0.2.0");
  assert.equal(id, "wasi:keyvalue/store@0.2.0");
});

test("parseInterfaceId rejects malformed ids", () => {
  assert.throws(() => parseInterfaceId(""), /interface_id_required/);
  assert.throws(() => parseInterfaceId("not-an-interface"), /invalid_interface_id/);
});
