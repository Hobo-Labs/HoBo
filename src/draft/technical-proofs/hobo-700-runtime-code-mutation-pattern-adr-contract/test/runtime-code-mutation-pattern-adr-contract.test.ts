import assert from "node:assert/strict";
import { test } from "vitest";

import {
  evaluateRuntimeCodeMutationPatternAdrLinks,
  readRuntimeCodeMutationPattern,
} from "../src/runtime-code-mutation-pattern-adr-contract.ts";

test("pattern doc links ADR-0048 in Relevance and Sources with current design paths", () => {
  const content = readRuntimeCodeMutationPattern();
  const gate = evaluateRuntimeCodeMutationPatternAdrLinks(content);

  assert.deepEqual(gate.errors, []);
  assert.equal(gate.ok, true);
});

test("missing ADR-0048 link fails the acceptance gate", () => {
  const baseline = readRuntimeCodeMutationPattern();
  const withoutAdr = baseline.replaceAll(
    "../design/adr/03-data-plane.md#adr-0048",
    "../design/adr/missing.md#adr-0048",
  );

  const gate = evaluateRuntimeCodeMutationPatternAdrLinks(withoutAdr);

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /ADR-0048/);
});

test("stale forge/event-model cross-refs fail the acceptance gate", () => {
  const baseline = readRuntimeCodeMutationPattern();
  const stale = `${baseline}\n[stale](./../design/forge-generated-stack.md#plan-23)`;

  const gate = evaluateRuntimeCodeMutationPatternAdrLinks(stale);

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /stale link fragment/);
});

test("unanswered framing without historical deferral fails the acceptance gate", () => {
  const baseline = readRuntimeCodeMutationPattern();
  const stale = baseline.replace(
    "Before [ADR-0048]",
    "The unanswered question remains:",
  );

  const gate = evaluateRuntimeCodeMutationPatternAdrLinks(stale);

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /unanswered/);
});
