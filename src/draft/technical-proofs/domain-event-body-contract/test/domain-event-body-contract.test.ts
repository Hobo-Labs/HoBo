import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  assertAuthoringParity,
  compileDomainRecordContract,
  createTicketOpenedZodFixture,
  createTicketOpenedWitFixture,
  decodeDomainBodyFromProtobuf,
  encodeDomainBodyToProtobuf,
  validateSchemaEvolution,
  validateDomainBody
} from "../src/domain-event-body-contract.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("WIT-authored domain record generates canonical TS, Protobuf, Zod, and CUE views", async () => {
  const contract = compileDomainRecordContract(createTicketOpenedWitFixture());

  assert.equal(contract.canonicalWit, await readFixture("generated/ticket-opened.wit"));
  assert.equal(contract.generatedTypescript, await readFixture("generated/ticket-opened.d.ts"));
  assert.equal(contract.protobufDescriptor, await readFixture("generated/ticket-opened.proto"));
  assert.equal(contract.zodValidatorSource, await readFixture("generated/ticket-opened.zod.ts"));
  assert.equal(contract.cueConstraintsSource, await readFixture("generated/ticket-opened.cue"));
  assert.deepEqual(contract.declaredContract, {
    schema: "hobo.domain-record/v1",
    type: "ticket.Opened",
    version: 1,
    canonicalHash: contract.canonicalHash,
    upstream: "canonical-wit-record",
    generatedViews: ["typescript", "protobuf", "zod", "cue"]
  });
});

test("event body round-trips through Protobuf bytes with stable re-encoding", () => {
  const contract = compileDomainRecordContract(createTicketOpenedWitFixture());
  const body = {
    ticketId: "ticket_123",
    summary: "checkout fails",
    priority: 3,
    requesterEmail: "user@example.test"
  };

  const encoded = encodeDomainBodyToProtobuf(contract, body);
  const decoded = decodeDomainBodyFromProtobuf(contract, encoded);

  assert.deepEqual(decoded, body);
  assert.deepEqual(encodeDomainBodyToProtobuf(contract, decoded), encoded);
});

test("Zod-authored body resolves to the same canonical WIT record as WIT authoring", () => {
  const fromWit = compileDomainRecordContract(createTicketOpenedWitFixture());
  const fromZod = compileDomainRecordContract(createTicketOpenedZodFixture());

  assert.equal(fromZod.canonicalWit, fromWit.canonicalWit);
  assert.equal(fromZod.canonicalHash, fromWit.canonicalHash);
  assert.equal(fromZod.declaredContract.upstream, "canonical-wit-record");
});

test("CUE constraints reject invalid domain event bodies before encoding", () => {
  const contract = compileDomainRecordContract(createTicketOpenedWitFixture());

  assert.deepEqual(validateDomainBody(contract, {
    ticketId: "ticket_123",
    summary: "checkout fails",
    priority: 3,
    requesterEmail: "user@example.test"
  }), { ok: true, errors: [] });

  const validation = validateDomainBody(contract, {
    ticketId: "legacy-123",
    summary: "",
    priority: 7,
    requesterEmail: "not-an-email"
  });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /ticketId must match/);
  assert.match(validation.errors.join("\n"), /summary length must be >= 1/);
  assert.match(validation.errors.join("\n"), /priority must be <= 5/);
  assert.match(validation.errors.join("\n"), /requesterEmail must match/);
});

test("authoring-surface divergence fails parity instead of picking one surface", () => {
  const zod = createTicketOpenedZodFixture();
  zod.fields = zod.fields.filter((field) => field.name !== "requesterEmail");

  const parity = assertAuthoringParity([
    createTicketOpenedWitFixture(),
    zod
  ]);

  assert.equal(parity.ok, false);
  assert.match(parity.errors.join("\n"), /zod canonical WIT hash differs from wit/);
});

test("non-additive field rename without a version bump is flagged", () => {
  const previous = createTicketOpenedWitFixture();
  const renamed = createTicketOpenedWitFixture();
  renamed.fields = renamed.fields.map((field) => (
    field.name === "summary"
      ? { ...field, name: "title", witName: "title", protoName: "title" }
      : field
  ));

  const evolution = validateSchemaEvolution(previous, renamed);

  assert.equal(evolution.ok, false);
  assert.match(evolution.errors.join("\n"), /field tag 2 was renamed from summary to title without version bump/);
});

async function readFixture(relativePath) {
  const content = await readFile(path.join(packageRoot, relativePath), "utf8");
  return content.replace(/\r\n/g, "\n");
}
