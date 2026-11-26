import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  parseDriftResource,
  parseDriftResources,
  parseGetDriftRequest,
  parseHealDriftRequest,
} from "../src/parse.js";

describe("S6-05 parse boundary", () => {
  it("parses drift resources with defaults", () => {
    const resource = parseDriftResource({ id: "api" });

    assert.equal(resource.id, "api");
    assert.equal(resource.desiredRef, "set:desired@api");
    assert.equal(resource.environment, "staging");
  });

  it("rejects malformed drift resource arrays", () => {
    assert.throws(() => parseDriftResources({}), /array/);
  });

  it("parses get_drift requests", () => {
    const request = parseGetDriftRequest({
      resourceId: "api",
      projection: [{ resourceId: "api" }],
    });

    assert.equal(request.resourceId, "api");
    assert.equal(request.projection.length, 1);
  });

  it("parses heal drift requests", () => {
    const request = parseHealDriftRequest({
      resourceId: "api",
      projection: [{ resourceId: "api", drift: { resourceId: "api" } }],
    });

    assert.equal(request.resourceId, "api");
    assert.equal(request.projection.length, 1);
  });
});
