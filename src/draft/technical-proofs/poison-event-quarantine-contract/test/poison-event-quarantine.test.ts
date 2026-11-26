import assert from "node:assert/strict";
import { test } from "vitest";

import {
  FoldExecutionError,
  QuarantineFactError,
  createAggregateFold,
  createProjectionFold,
  doctorQuarantineReport,
  replayWithQuarantine,
} from "../src/poison-event-quarantine.js";
import { isJsonString } from "../src/json.js";


test("projection poison event emits a quarantine fact, keeps the original log, and continues folding", () => {
  const projection = createProjectionFold({
    name: "ticket-view",
    kind: "projection",
    quarantineType: "ticket.Quarantined",
    readSet: ["ticket.Opened", "ticket.Commented"],
    initialState: { tickets: [], comments: 0 },
    fold(state, event) {
      if (event.type === "ticket.Opened") {
        requireString(event.data.title, "title");
        return { ...state, tickets: [...state.tickets, event.data.title] };
      }
      return { ...state, comments: state.comments + 1 };
    },
  });
  const log = [
    event("ticket-1", 1, "ticket.Opened", {}),
    event("ticket-1", 2, "ticket.Commented", { body: "still processes" }),
  ];

  const result = replayWithQuarantine({ fold: projection, events: log });

  assert.deepEqual(result.state, { tickets: [], comments: 1 });
  assert.deepEqual(result.quarantines, [
    {
      type: "ticket.Quarantined",
      streamId: "ticket-1",
      seq: 3,
      data: {
        targetSeq: 1,
        targetEventId: "ticket-1:1:ticket.Opened",
        targetType: "ticket.Opened",
        fold: "ticket-view",
        foldKind: "projection",
        reason: "title must be a string",
      },
    },
  ]);
  assert.deepEqual(result.log.map((entry) => entry.id), [
    "ticket-1:1:ticket.Opened",
    "ticket-1:2:ticket.Commented",
    "ticket-1:3:ticket.Quarantined",
  ]);
});

test("replay deterministically skips the same quarantined seq and preserves replay equals live", () => {
  const aggregate = ticketAggregateFold();
  const log = [
    event("ticket-2", 1, "ticket.Opened", { title: "Login" }),
    event("ticket-2", 2, "ticket.StatusChanged", {}),
    event("ticket-2", 3, "ticket.Commented", { body: "after poison" }),
  ];

  const live = replayWithQuarantine({ fold: aggregate, events: log });
  const replay = replayWithQuarantine({ fold: aggregate, events: live.log });

  assert.deepEqual(replay.state, live.state);
  assert.deepEqual(replay.quarantinedSeqs, [2]);
  assert.deepEqual(replay.quarantines, []);
  assert.equal(replay.replayEqualsLiveDigest, live.replayEqualsLiveDigest);
  assert.deepEqual(replay.log, live.log);
});

test("aggregate and projection folds both quarantine deterministic poison independently", () => {
  const aggregate = ticketAggregateFold();
  const aggregateResult = replayWithQuarantine({
    fold: aggregate,
    events: [
      event("ticket-3", 1, "ticket.Opened", {}),
      event("ticket-3", 2, "ticket.StatusChanged", { status: "closed" }),
    ],
  });

  const projection = createProjectionFold({
    name: "ticket-comments",
    kind: "projection",
    quarantineType: "ticket.Quarantined",
    readSet: ["ticket.Commented"],
    initialState: { commentBodies: [] },
    fold(state, current) {
      requireString(current.data.body, "body");
      return { commentBodies: [...state.commentBodies, current.data.body] };
    },
  });
  const projectionResult = replayWithQuarantine({
    fold: projection,
    events: [
      event("ticket-4", 1, "ticket.Commented", {}),
      event("ticket-4", 2, "ticket.Commented", { body: "second" }),
    ],
  });

  assert.deepEqual(aggregateResult.quarantinedSeqs, [1]);
  assert.deepEqual(aggregateResult.state, { status: "closed", title: "", comments: 0 });
  assert.deepEqual(projectionResult.quarantinedSeqs, [1]);
  assert.deepEqual(projectionResult.state, { commentBodies: ["second"] });
});

test("two poison events quarantine independently and one does not mask the other", () => {
  const aggregate = ticketAggregateFold();
  const result = replayWithQuarantine({
    fold: aggregate,
    events: [
      event("ticket-5", 1, "ticket.Opened", {}),
      event("ticket-5", 2, "ticket.StatusChanged", {}),
      event("ticket-5", 3, "ticket.Commented", { body: "survives" }),
    ],
  });

  assert.deepEqual(result.quarantinedSeqs, [1, 2]);
  assert.deepEqual(
    result.quarantines.map((quarantine) => quarantine.data.reason),
    ["title must be a string", "status must be a string"],
  );
  assert.deepEqual(result.state, { status: "unknown", title: "", comments: 1 });
});

test("doctor report surfaces quarantines without rewriting or hiding the source events", () => {
  const aggregate = ticketAggregateFold();
  const result = replayWithQuarantine({
    fold: aggregate,
    events: [
      event("ticket-6", 1, "ticket.Opened", {}),
      event("ticket-6", 2, "ticket.Commented", { body: "visible" }),
    ],
  });

  assert.deepEqual(doctorQuarantineReport(result), {
    ok: false,
    findings: [
      {
        code: "event-log.poison-quarantined",
        severity: "incident",
        streamId: "ticket-6",
        seq: 1,
        eventId: "ticket-6:1:ticket.Opened",
        reason: "title must be a string",
        remediation: "investigate the fold/upcaster and choose explicit keep-quarantined or reprocess policy",
      },
    ],
  });
});

test("a quarantine fact from one fold does not mask another fold that can process the event", () => {
  const aggregate = ticketAggregateFold();
  const live = replayWithQuarantine({
    fold: aggregate,
    events: [
      event("ticket-10", 1, "ticket.Opened", {}),
      event("ticket-10", 2, "ticket.Commented", { body: "visible" }),
    ],
  });
  const projection = createProjectionFold({
    name: "lenient-ticket-projection",
    quarantineType: "ticket.Quarantined",
    readSet: ["ticket.Opened", "ticket.Commented"],
    initialState: { opened: 0, comments: 0 },
    fold(state, current) {
      if (current.type === "ticket.Opened") {
        return { ...state, opened: state.opened + 1 };
      }
      return { ...state, comments: state.comments + 1 };
    },
  });

  const replay = replayWithQuarantine({ fold: projection, events: live.log });

  assert.deepEqual(replay.state, { opened: 1, comments: 1 });
  assert.deepEqual(replay.quarantineFacts, []);
  assert.deepEqual(replay.policyFindings, []);
});

test("newly processable quarantined seq requires explicit policy instead of silent un-quarantine", () => {
  const strict = ticketAggregateFold();
  const live = replayWithQuarantine({
    fold: strict,
    events: [
      event("ticket-7", 1, "ticket.Opened", {}),
      event("ticket-7", 2, "ticket.Commented", { body: "after poison" }),
    ],
  });
  const relaxed = ticketAggregateFold({
    allowUntitledOpen: true,
  });

  const replay = replayWithQuarantine({ fold: relaxed, events: live.log });

  assert.deepEqual(replay.state, live.state);
  assert.deepEqual(replay.policyFindings, [
    {
      code: "event-log.quarantine-reprocess-policy-required",
      streamId: "ticket-7",
      seq: 1,
      eventId: "ticket-7:1:ticket.Opened",
    },
  ]);
});

test("nondeterministic fold failures are not quarantined as poison", () => {
  const fold = createAggregateFold({
    name: "flaky-ticket",
    quarantineType: "ticket.Quarantined",
    readSet: ["ticket.Opened"],
    initialState: {},
    fold() {
      throw new Error("transient network hiccup");
    },
    classifyFailure() {
      return "transient";
    },
  });

  assert.throws(
    () => replayWithQuarantine({ fold, events: [event("ticket-8", 1, "ticket.Opened", {})] }),
    FoldExecutionError,
  );
});

test("malformed quarantine fact fails rather than being recursively quarantined", () => {
  const aggregate = ticketAggregateFold();

  assert.throws(
    () =>
      replayWithQuarantine({
        fold: aggregate,
        events: [
          event("ticket-9", 1, "ticket.Opened", { title: "Login" }),
          {
            ...event("ticket-9", 2, "ticket.Quarantined", { targetSeq: 1 }),
            meta: { quarantineFor: "ticket-9:1:ticket.Opened" },
          },
        ],
      }),
    QuarantineFactError,
  );
});

function ticketAggregateFold(overrides = {}) {
  return createAggregateFold({
    name: "ticket-aggregate",
    quarantineType: "ticket.Quarantined",
    readSet: ["ticket.Opened", "ticket.StatusChanged", "ticket.Commented"],
    initialState: { status: "unknown", title: "", comments: 0 },
    fold(state, current) {
      if (current.type === "ticket.Opened") {
        if (overrides.allowUntitledOpen === true && current.data.title === undefined) {
          return { ...state, title: "untitled" };
        }
        requireString(current.data.title, "title");
        return { ...state, title: current.data.title, status: "open" };
      }
      if (current.type === "ticket.StatusChanged") {
        requireString(current.data.status, "status");
        return { ...state, status: current.data.status };
      }
      requireString(current.data.body, "body");
      return { ...state, comments: state.comments + 1 };
    },
  });
}

function event(streamId, seq, type, data) {
  return {
    id: `${streamId}:${seq}:${type}`,
    streamId,
    seq,
    type,
    v: 1,
    data,
  };
}

function requireString(value, field) {
  if (!isJsonString(value)) {
    throw new Error(`${field} must be a string`);
  }
}
