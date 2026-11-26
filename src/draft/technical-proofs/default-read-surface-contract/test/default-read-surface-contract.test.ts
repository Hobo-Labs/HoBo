import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buffer,
  coalesce,
  combineLatest,
  createEventLog,
  createUseSubscriptionProbe,
  debounce,
  distinctUntilChanged,
  filter,
  fold,
  from,
  join,
  map,
  scan,
  subscribe,
  useQuery,
  window,
} from "../src/default-read-surface.js";

test("subscribe delivers replay-then-live current value before any live push", () => {
  const log = createEventLog([
    ticketEvent("ticket-1", 1, "ticket.Opened", { title: "api down" }),
    ticketEvent("ticket-2", 1, "ticket.Opened", { title: "queue lag" }),
  ]);
  const openTickets = from("ticket.Opened", "ticket.Closed").pipe(
    scan((state, event) => {
      if (event.type === "ticket.Opened") {
        return [...state, event.data.title].sort();
      }
      return state.filter((title) => title !== event.data.title);
    }, []),
  );

  const observed = [];
  const subscription = subscribe(log, openTickets, {
    onValue(value) {
      observed.push(value);
    },
  });

  assert.deepEqual(observed, [["api down", "queue lag"]]);
  assert.deepEqual(subscription.current(), {
    data: ["api down", "queue lag"],
    seq: { "ticket:ticket-1": 1, "ticket:ticket-2": 1 },
    stale: false,
  });

  log.append(ticketEvent("ticket-3", 1, "ticket.Opened", { title: "dns flap" }));

  assert.deepEqual(observed, [
    ["api down", "queue lag"],
    ["api down", "dns flap", "queue lag"],
  ]);
  subscription.unsubscribe();
});

test("operator pipelines compose deterministically and replayably", () => {
  const events = [
    metricEvent("cpu", 1, 3),
    metricEvent("memory", 1, 7),
    metricEvent("cpu", 2, 4),
    metricEvent("memory", 2, 11),
  ];
  const pipeline = from("metric.Sampled").pipe(
    filter((event) => event.data.value >= 4),
    map((event) => ({ metric: event.data.metric, value: event.data.value * 10 })),
    scan((state, sample) => ({ ...state, [sample.metric]: sample.value }), {}),
    distinctUntilChanged(),
  );

  const first = subscribe(createEventLog(events), pipeline).current();
  const second = subscribe(createEventLog([...events].reverse()), pipeline).current();

  assert.deepEqual(first, {
    data: { cpu: 40, memory: 110 },
    seq: { "metric:cpu": 2, "metric:memory": 2 },
    stale: false,
  });
  assert.deepEqual(second, first);
});

test("useSubscription-shaped hook rerenders on push and useQuery aliases it", () => {
  const log = createEventLog([metricEvent("cpu", 1, 3)]);
  const totalMetric = from("metric.Sampled").pipe(fold((sum, event) => sum + event.data.value, 0));
  const hook = createUseSubscriptionProbe(log, totalMetric);

  assert.deepEqual(hook.value(), { data: 3, seq: { "metric:cpu": 1 }, stale: false });
  assert.equal(hook.renderCount(), 1);

  log.append(metricEvent("cpu", 2, 5));

  assert.deepEqual(hook.value(), { data: 8, seq: { "metric:cpu": 2 }, stale: false });
  assert.equal(hook.renderCount(), 2);
  assert.deepEqual(useQuery(log, totalMetric).current(), hook.value());
  hook.unsubscribe();
});

test("advanced operator vocabulary stays deterministic over one replay", () => {
  const events = [
    ownerEvent("team-a", 1, "Ava"),
    metricEvent("cpu", 1, 1),
    metricEvent("memory", 1, 10),
    metricEvent("cpu", 2, 2),
    metricEvent("memory", 2, 20),
    metricEvent("cpu", 3, 3),
    ticketEvent("ticket-1", 1, "ticket.Opened", { title: "api down", ownerId: "team-a" }),
  ];
  const cpu = from("metric.Sampled")
    .where((event) => event.data.metric === "cpu")
    .pipe(map((event) => event.data.value));
  const memory = from("metric.Sampled")
    .where((event) => event.data.metric === "memory")
    .pipe(map((event) => event.data.value));
  const tickets = from("ticket.Opened").pipe(map((event) => event.data));
  const owners = from("owner.Named").pipe(map((event) => event.data), coalesce());
  const assignedTickets = tickets.pipe(
    join(owners, {
      leftKey: (ticket) => ticket.ownerId,
      rightKey: (owner) => owner.id,
      project: (ticket, owner) => ({ title: ticket.title, owner: owner.name }),
    }),
  );

  assert.deepEqual(subscribe(createEventLog(events), cpu.pipe(window(2))).current().data, [[2, 3]]);
  assert.deepEqual(subscribe(createEventLog(events), cpu.pipe(buffer(2))).current().data, [[1, 2], [3]]);
  assert.deepEqual(subscribe(createEventLog(events), cpu.pipe(coalesce())).current().data, 3);
  assert.deepEqual(subscribe(createEventLog(events), combineLatest({ cpu, memory })).current().data, {
    cpu: 3,
    memory: 20,
  });

  const log = createEventLog(events);
  const observedJoins = [];
  const subscription = subscribe(log, assignedTickets, {
    onValue(value) {
      observedJoins.push(value);
    },
  });

  log.append(ownerEvent("team-a", 2, "Ira"));

  assert.deepEqual(observedJoins, [
    [{ title: "api down", owner: "Ava" }],
    [{ title: "api down", owner: "Ira" }],
  ]);
  assert.deepEqual(subscription.current().seq, {
    "owner:team-a": 2,
    "ticket:ticket-1": 1,
  });
  subscription.unsubscribe();
});

test("adversarial cases fail closed or stay honest", () => {
  const empty = subscribe(createEventLog([]), from("ticket.Opened").pipe(scan((state) => state + 1, 0)));
  assert.deepEqual(empty.current(), { data: 0, seq: {}, stale: false });

  assert.throws(() => from("metric.Sampled").pipe(debounce({ ms: 5 })), /requires a deterministic seed/);

  const seededDebounce = from("metric.Sampled").pipe(debounce({ ms: 5, seed: "runtime-seed" }));
  assert.deepEqual(
    subscribe(createEventLog([metricEvent("cpu", 1, 1), metricEvent("cpu", 2, 2)]), seededDebounce).current(),
    { data: [metricEvent("cpu", 2, 2)], seq: { "metric:cpu": 2 }, stale: false },
  );
});

test("back-to-back subscribers share one history replay instead of double-folding", () => {
  const log = createEventLog([metricEvent("cpu", 1, 1), metricEvent("cpu", 2, 2)]);
  let foldCount = 0;
  const totalMetric = from("metric.Sampled").pipe(
    scan((sum, event) => {
      foldCount += 1;
      return sum + event.data.value;
    }, 0),
  );

  const first = subscribe(log, totalMetric);
  const second = subscribe(log, totalMetric);

  assert.equal(foldCount, 2);
  assert.deepEqual(first.current(), second.current());
  first.unsubscribe();
  second.unsubscribe();
});

function ticketEvent(id, seq, type, data) {
  return {
    id: `${id}-${seq}`,
    streamId: `ticket:${id}`,
    seq,
    type,
    v: 1,
    data,
  };
}

function metricEvent(metric, seq, value) {
  return {
    id: `${metric}-${seq}`,
    streamId: `metric:${metric}`,
    seq,
    type: "metric.Sampled",
    v: 1,
    data: { metric, value },
  };
}

function ownerEvent(id, seq, name) {
  return {
    id: `${id}-${seq}`,
    streamId: `owner:${id}`,
    seq,
    type: "owner.Named",
    v: 1,
    data: { id, name },
  };
}
