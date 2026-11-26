import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createPaginatedStore,
  decodeCursor,
  usePaginatedQuery,
  view,
} from "../src/paginated-query-contract.js";

test("cursor pagination returns stable pages over mutating snapshots", () => {
  const store = createTickets([
    ticket("t1", "2026-06-26T10:00:00.000Z", "opened"),
    ticket("t2", "2026-06-26T11:00:00.000Z", "triaged"),
    ticket("t3", "2026-06-26T12:00:00.000Z", "working"),
    ticket("t4", "2026-06-26T13:00:00.000Z", "waiting"),
  ]);
  const tickets = view(store, "tickets").order("createdAt");

  const firstPage = tickets.paginate({ limit: 2 });

  assert.deepEqual(firstPage.items.map((item) => item.id), ["t1", "t2"]);
  assert.deepEqual(firstPage.seq, { "ticket:t1": 1, "ticket:t2": 1 });

  const cursor = decodeCursor(firstPage.nextCursor);
  assert.equal(cursor.orderBy, "createdAt");
  assert.deepEqual(cursor.after, { key: "2026-06-26T11:00:00.000Z", id: "t2" });
  assert.equal(Object.hasOwn(cursor, "offset"), false);

  store.upsert(ticket("t0", "2026-06-26T09:00:00.000Z", "new-earlier"));
  const secondPage = tickets.paginate({ cursor: firstPage.nextCursor, limit: 2 });

  assert.deepEqual(secondPage.items.map((item) => item.id), ["t3", "t4"]);
  assert.deepEqual(secondPage.seq, { "ticket:t3": 1, "ticket:t4": 1 });
});

test("paginated reactive query re-pushes only for changes inside the page window", () => {
  const store = createTickets([
    ticket("t1", "2026-06-26T10:00:00.000Z", "opened"),
    ticket("t2", "2026-06-26T11:00:00.000Z", "triaged"),
    ticket("t3", "2026-06-26T12:00:00.000Z", "working"),
  ]);
  const tickets = view(store, "tickets").order("createdAt");
  const pushed = [];

  const query = usePaginatedQuery(tickets, {
    limit: 2,
    onPush(page) {
      pushed.push({
        ids: page.items.map((item) => item.id),
        titles: page.items.map((item) => item.title),
        seq: page.seq,
      });
    },
  });

  store.upsert({ ...ticket("t3", "2026-06-26T12:00:00.000Z", "outside-window"), seq: 2 });
  store.upsert({ ...ticket("t2", "2026-06-26T11:00:00.000Z", "in-window"), seq: 2 });

  assert.deepEqual(pushed, [
    {
      ids: ["t1", "t2"],
      titles: ["opened", "triaged"],
      seq: { "ticket:t1": 1, "ticket:t2": 1 },
    },
    {
      ids: ["t1", "t2"],
      titles: ["opened", "in-window"],
      seq: { "ticket:t1": 1, "ticket:t2": 2 },
    },
  ]);
  assert.deepEqual(query.current().seq, { "ticket:t1": 1, "ticket:t2": 2 });
  assert.throws(
    () => store.upsert({ ...ticket("t2", "2026-06-26T11:00:00.000Z", "stale"), seq: 1 }),
    /seq must advance/,
  );

  query.unsubscribe();
});

test("loadMore extends the page window read-set", () => {
  const store = createTickets([
    ticket("t1", "2026-06-26T10:00:00.000Z", "one"),
    ticket("t2", "2026-06-26T11:00:00.000Z", "two"),
    ticket("t3", "2026-06-26T12:00:00.000Z", "three"),
    ticket("t4", "2026-06-26T13:00:00.000Z", "four"),
  ]);
  const tickets = view(store, "tickets").order("createdAt");
  const pushed = [];
  const query = usePaginatedQuery(tickets, {
    limit: 2,
    onPush(page) {
      pushed.push(page.items.map((item) => `${item.id}:${item.title}`));
    },
  });

  store.upsert({ ...ticket("t4", "2026-06-26T13:00:00.000Z", "outside-before-load-more"), seq: 2 });
  assert.deepEqual(pushed, [["t1:one", "t2:two"]]);

  const extended = query.loadMore();
  assert.deepEqual(extended.items.map((item) => item.id), ["t1", "t2", "t3", "t4"]);

  store.upsert({ ...ticket("t4", "2026-06-26T13:00:00.000Z", "inside-after-load-more"), seq: 3 });
  assert.deepEqual(pushed, [
    ["t1:one", "t2:two"],
    ["t1:one", "t2:two", "t3:three", "t4:outside-before-load-more"],
    ["t1:one", "t2:two", "t3:three", "t4:inside-after-load-more"],
  ]);

  query.unsubscribe();
});

test("adversarial pagination cases fail closed or remove phantom rows", () => {
  const store = createTickets([
    ticket("t1", "2026-06-26T10:00:00.000Z", "one"),
    ticket("t2", "2026-06-26T11:00:00.000Z", "two"),
    ticket("t3", "2026-06-26T12:00:00.000Z", "three"),
    ticket("t4", "2026-06-26T13:00:00.000Z", "four"),
  ]);

  assert.throws(() => view(store, "tickets").order("title"), /not indexable/);

  const pushed = [];
  const query = usePaginatedQuery(view(store, "tickets").order("createdAt"), {
    limit: 3,
    onPush(page) {
      pushed.push(page.items.map((item) => item.id));
    },
  });

  store.delete("t2", { seq: 2 });

  assert.deepEqual(pushed, [
    ["t1", "t2", "t3"],
    ["t1", "t3"],
  ]);
  assert.deepEqual(query.current().seq, { "ticket:t1": 1, "ticket:t2": 2, "ticket:t3": 1 });

  query.unsubscribe();
});

function createTickets(rows) {
  return createPaginatedStore({
    name: "tickets",
    indexKeys: ["createdAt"],
    rows,
  });
}

function ticket(id, createdAt, title) {
  return {
    id,
    streamId: `ticket:${id}`,
    seq: 1,
    createdAt,
    title,
  };
}
