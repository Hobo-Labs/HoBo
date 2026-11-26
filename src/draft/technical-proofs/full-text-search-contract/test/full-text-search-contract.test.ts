import assert from "node:assert/strict";
import { test } from "vitest";

import {
  and,
  createSearchProjection,
  defineTextIndex,
  eq,
  inList,
  range,
  resolveSearchBackend,
} from "../src/full-text-search-contract.js";

test("full-text query returns ranked hits from an indexed fixture corpus", () => {
  const search = createTicketSearch();

  const result = search.query({
    text: "disk full",
    tenantId: "tenant-a",
    filter: eq("status", "open"),
  });

  assert.deepEqual(
    result.hits.map((hit) => ({ id: hit.id, score: hit.score })),
    [
      { id: "ticket-1", score: 4 },
      { id: "ticket-3", score: 1 },
    ],
  );
  assert.deepEqual(result.seq, { "ticket:ticket-1": 1, "ticket:ticket-3": 1 });
});

test("data.Changed re-pushes subscribed full-text results reactively", () => {
  const search = createTicketSearch();
  const pushed = [];
  const subscription = search.subscribe({
    subscriptionId: "sub:disk",
    text: "disk",
    tenantId: "tenant-a",
    filter: eq("status", "open"),
    onPush(event) {
      pushed.push(event);
    },
  });

  assert.deepEqual(subscription.current().hits.map((hit) => hit.id), ["ticket-1", "ticket-3"]);

  search.indexRecord({
    id: "ticket-4",
    tenantId: "tenant-a",
    fields: { title: "disk quota warning", body: "disk disk full on image cache", status: "open", priority: 2 },
    seq: { "ticket:ticket-4": 1 },
  });

  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:disk",
      seq: { "ticket:ticket-1": 1, "ticket:ticket-3": 1, "ticket:ticket-4": 1 },
      result: {
        hits: [
          { id: "ticket-4", score: 3 },
          { id: "ticket-1", score: 2 },
          { id: "ticket-3", score: 1 },
        ],
      },
      cause: {
        type: "data.Changed",
        op: "upsert",
        resource: "tickets",
        key: "ticket-4",
      },
    },
  ]);
  assert.deepEqual(subscription.current().hits.map((hit) => hit.id), ["ticket-4", "ticket-1", "ticket-3"]);
});

test("search filters compose with tenant scope in one predicate language", () => {
  const search = createTicketSearch();

  const result = search.query({
    text: "disk",
    tenantId: "tenant-a",
    filter: and(inList("status", ["open", "triage"]), range("priority", { lte: 3 })),
  });

  assert.deepEqual(result.hits.map((hit) => hit.id), ["ticket-1", "ticket-3"]);
  assert.deepEqual(
    result.appliedFilter,
    and(eq("tenantId", "tenant-a"), and(inList("status", ["open", "triage"]), range("priority", { lte: 3 }))),
  );
});

test("same search Bindle resolves to Postgres FTS in preview and managed search in prod", () => {
  const bindle = {
    name: "ticket-search",
    requires: ["text"],
    preferredManagedEngine: "opensearch-managed",
  };

  assert.deepEqual(resolveSearchBackend(bindle, { camp: "preview" }), {
    kind: "postgres-fts",
    reason: "preview Camp uses the in-core colocated full-text default",
  });
  assert.deepEqual(resolveSearchBackend(bindle, { camp: "prod" }), {
    kind: "opensearch-managed",
    reason: "prod Camp uses the managed search equivalence class",
  });
});

test("adversarial declaration and tenant-scope failures are rejected before query execution", () => {
  const search = createTicketSearch();

  assert.throws(
    () => search.query({ text: "disk", tenantId: "tenant-a", filter: eq("unindexed", "value") }),
    /filter field is not indexed: unindexed/,
  );
  assert.throws(
    () => search.query({ text: "di", tenantId: "tenant-a", prefix: true }),
    /prefix query requires a prefix-enabled text index/,
  );
  assert.throws(
    () => search.query({ text: "disk", filter: eq("status", "open") }),
    /tenant-scoped search requires a resolved tenant/,
  );
});

function createTicketSearch() {
  return createSearchProjection({
    resource: "tickets",
    index: defineTextIndex({
      name: "tickets-full-text",
      fields: ["title", "body"],
      filterFields: ["tenantId", "status", "priority"],
      prefix: false,
    }),
    records: [
      {
        id: "ticket-1",
        tenantId: "tenant-a",
        fields: { title: "disk full on api", body: "disk full alarm from api", status: "open", priority: 3 },
        seq: { "ticket:ticket-1": 1 },
      },
      {
        id: "ticket-2",
        tenantId: "tenant-b",
        fields: { title: "disk full in another tenant", body: "tenant boundary proof", status: "open", priority: 1 },
        seq: { "ticket:ticket-2": 1 },
      },
      {
        id: "ticket-3",
        tenantId: "tenant-a",
        fields: { title: "database lock", body: "disk warning from storage", status: "open", priority: 1 },
        seq: { "ticket:ticket-3": 1 },
      },
    ],
  });
}
