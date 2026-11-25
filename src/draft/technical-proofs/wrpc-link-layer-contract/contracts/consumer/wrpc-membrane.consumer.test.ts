import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const pact = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../architecture/pacts/wrpc-membrane.pact.json",
    ),
    "utf8",
  ),
);

test("consumer expectations match wrpc-membrane pact fixtures", () => {
  assert.equal(pact.consumer.name, "RuntimeLocalComponentCaller");
  assert.equal(pact.provider.name, "WrpcMembraneLinkLayer");
  assert.equal(pact.metadata.pactSpecification.version, "3.0.0");
  assert.equal(pact.interactions.length, 4);

  const [establishSuccess, establishBelowFloor, unlinkedCall, linkedCall] =
    pact.interactions;

  assert.match(establishSuccess.description, /establish-link success/);
  assert.equal(establishSuccess.response.body.negotiatedWire.minor, "1.2");

  assert.equal(establishBelowFloor.response.body.code, "version-incompatible");
  assert.equal(
    establishBelowFloor.response.body.reason,
    "shared-minor-below-floor",
  );
  assert.equal(establishBelowFloor.response.body.phase, "link-establishment");

  assert.equal(unlinkedCall.response.body.code, "no-route");

  assert.equal(linkedCall.response.body.linkCalled.transport, "in-process");
  assert.equal(linkedCall.response.body.linkCalled.boundaryMode, "live");
  assert.equal(linkedCall.response.body.linkCalled.codec, "json-wit");
  assert.equal(
    linkedCall.response.body.linkCalled.deadline,
    "2026-06-25T15:45:00.000Z",
  );
});
