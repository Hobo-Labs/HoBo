import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createCorpusBaseline,
  createTicketOpenedEvolutionContract,
  runCanDeployUpcasterGate
} from "../src/event-body-upcaster-gate.js";

test("golden corpus replays and upcasts v1 event bodies to current deterministically", () => {
  const contract = createTicketOpenedEvolutionContract();
  const gate = runCanDeployUpcasterGate(contract);

  assert.equal(gate.ok, true);
  assert.deepEqual(gate.errors, []);

  const v1Replay = gate.replays.find((replay) => replay.key === "ticket.Opened@v1#ticket-opened-v1");

  assert.deepEqual(v1Replay.currentBody, {
    ticketId: "ticket_123",
    title: "checkout fails",
    priority: 3,
    requesterRef: "email:user@example.test",
    source: "legacy-v1"
  });
  assert.equal(v1Replay.currentVersion, 3);
  assert.match(v1Replay.currentDigest, /^sha256:[a-f0-9]{64}$/);
});

test("version bump without a golden corpus entry fails can-deploy", () => {
  const contract = createTicketOpenedEvolutionContract();
  contract.goldenCorpus = contract.goldenCorpus.filter((entry) => entry.version !== 2);

  const gate = runCanDeployUpcasterGate(contract);

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /missing golden corpus entry for ticket\.Opened@v2/);
});

test("broken upcaster that drops a required field fails with precise type and version", () => {
  const contract = createTicketOpenedEvolutionContract();
  contract.upcasters = contract.upcasters.map((upcaster) => (
    upcaster.from === 1
      ? {
          ...upcaster,
          upcast: (body) => ({
            ticketId: body.ticketId,
            priority: body.priority,
            requesterEmail: body.requesterEmail,
            source: "legacy-v1"
          })
        }
      : upcaster
  ));

  const gate = runCanDeployUpcasterGate(contract);

  assert.equal(gate.ok, false);
  assert.match(
    gate.errors.join("\n"),
    /ticket\.Opened@v1 upcaster 1->2 produced invalid v2 body: title must be a string/
  );
});

test("non-total upcaster chain is caught before a fold can run", () => {
  const contract = createTicketOpenedEvolutionContract();
  contract.upcasters = contract.upcasters.filter((upcaster) => !(upcaster.from === 2 && upcaster.to === 3));

  const gate = runCanDeployUpcasterGate(contract);

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /non-total upcaster chain for ticket\.Opened@v2: missing 2->3/);
});

test("impure upcaster side effects are rejected", () => {
  const contract = createTicketOpenedEvolutionContract();
  let counter = 0;
  contract.upcasters = contract.upcasters.map((upcaster) => (
    upcaster.from === 2
      ? {
          ...upcaster,
          upcast: (body) => ({
            ticketId: body.ticketId,
            title: body.title,
            priority: body.priority,
            requesterRef: `email:${body.requesterEmail}:${counter += 1}`,
            source: body.source
          })
        }
      : upcaster
  ));

  const gate = runCanDeployUpcasterGate(contract);

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /impure upcaster for ticket\.Opened@v2: identical input produced different output/);
});

test("silent corpus deletion fails the append-only baseline check", () => {
  const contract = createTicketOpenedEvolutionContract();
  const baseline = createCorpusBaseline(contract.goldenCorpus);
  contract.goldenCorpus = contract.goldenCorpus.filter((entry) => entry.version !== 1);

  const gate = runCanDeployUpcasterGate(contract, { baselineCorpus: baseline });

  assert.equal(gate.ok, false);
  assert.match(gate.errors.join("\n"), /append-only corpus deletion detected: ticket\.Opened@v1#ticket-opened-v1/);
});
