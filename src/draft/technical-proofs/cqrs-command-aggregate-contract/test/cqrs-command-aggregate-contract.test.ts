import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CommandInvariantError,
  ForbiddenCommandSideEffectError,
  LeaseConflictError,
  OptimisticSequenceConflictError,
  StaleFenceError,
  command,
  createCommandRuntime,
} from "../src/cqrs-command-aggregate-contract.js";

function ticketFold(state, event) {
  if (event.type === "ticket.Opened") {
    return { ...state, opened: true, title: event.data.title };
  }
  if (event.type === "ticket.Commented") {
    return { ...state, comments: [...state.comments, event.data.body] };
  }
  return state;
}

const openTicket = command(
  "Ticket.Open",
  {
    key: (input) => `ticket:${input.id}`,
    initialState: { opened: false, title: undefined, comments: [] },
    fold: ticketFold,
  },
  (input, ctx) => {
    if (ctx.state.opened) {
      throw new CommandInvariantError("ticket is already open");
    }

    const emitted = ctx.emit("ticket.Opened", {
      ticketId: input.id,
      title: input.title,
    });

    return { openedSeq: emitted.seq };
  },
);

const commentTicket = command(
  "Ticket.Comment",
  {
    key: (input) => `ticket:${input.id}`,
    initialState: { opened: false, title: undefined, comments: [] },
    fold: ticketFold,
  },
  (input, ctx) => {
    if (!ctx.state.opened) {
      throw new CommandInvariantError("ticket must be open before commenting");
    }

    return ctx.emit("ticket.Commented", {
      ticketId: input.id,
      body: input.body,
    });
  },
);

test("command checks invariants against the aggregate write-model fold and returns the emitted seq", () => {
  const runtime = createCommandRuntime();

  const result = runtime.execute(openTicket, { id: "alpha", title: "API down" });

  assert.deepEqual(result, {
    commandType: "Ticket.Open",
    streamId: "ticket:alpha",
    seq: 1,
    emitted: [
      {
        id: "ticket:alpha:1:ticket.Opened",
        streamId: "ticket:alpha",
        seq: 1,
        type: "ticket.Opened",
        v: 1,
        data: { ticketId: "alpha", title: "API down" },
        meta: {
          commandType: "Ticket.Open",
          contract: "hobo.cqrs-command-aggregate-contract/v1",
        },
      },
    ],
    value: { openedSeq: 1 },
  });
  assert.deepEqual(runtime.readAggregate(openTicket, { id: "alpha" }).state, {
    opened: true,
    title: "API down",
    comments: [],
  });

  assert.throws(
    () => runtime.execute(openTicket, { id: "alpha", title: "Duplicate" }),
    CommandInvariantError,
  );
  assert.equal(runtime.readStream("ticket:alpha").length, 1);
});

test("two concurrent commands on one aggregate reject the stale expected sequence without a lost update", () => {
  const runtime = createCommandRuntime();
  runtime.execute(openTicket, { id: "bravo", title: "Queue lag" });
  const observedSeq = runtime.readAggregate(commentTicket, { id: "bravo" }).seq;

  const first = runtime.execute(
    commentTicket,
    { id: "bravo", body: "investigating" },
    { expectedSeq: observedSeq },
  );

  assert.equal(first.seq, 2);
  assert.throws(
    () =>
      runtime.execute(
        commentTicket,
        { id: "bravo", body: "restart attempted" },
        { expectedSeq: observedSeq },
      ),
    OptimisticSequenceConflictError,
  );

  assert.deepEqual(
    runtime.readAggregate(commentTicket, { id: "bravo" }),
    {
      streamId: "ticket:bravo",
      seq: 2,
      state: {
        opened: true,
        title: "Queue lag",
        comments: ["investigating"],
      },
    },
  );
});

test("naked emit appends a domain event without an aggregate command boundary", () => {
  const runtime = createCommandRuntime();

  const emitted = runtime.emit("audit.Noted", { actorId: "worker-1" }, { streamId: "audit:global" });

  assert.deepEqual(emitted, {
    streamId: "audit:global",
    seq: 1,
  });
  assert.deepEqual(runtime.readStream("audit:global"), [
    {
      id: "audit:global:1:audit.Noted",
      streamId: "audit:global",
      seq: 1,
      type: "audit.Noted",
      v: 1,
      data: { actorId: "worker-1" },
      meta: {
        contract: "hobo.cqrs-command-aggregate-contract/v1",
      },
    },
  ]);
});

test("stale expectedSeq and invariant violations do not append", () => {
  const runtime = createCommandRuntime();
  runtime.execute(openTicket, { id: "charlie", title: "DNS flap" });

  assert.throws(
    () =>
      runtime.execute(
        commentTicket,
        { id: "charlie", body: "old writer" },
        { expectedSeq: 0 },
      ),
    OptimisticSequenceConflictError,
  );
  assert.equal(runtime.readStream("ticket:charlie").length, 1);

  assert.throws(
    () => runtime.execute(commentTicket, { id: "missing", body: "should fail" }),
    CommandInvariantError,
  );
  assert.deepEqual(runtime.readStream("ticket:missing"), []);
});

test("command handlers cannot call step or external write APIs", () => {
  const runtime = createCommandRuntime();
  const stepCommand = command(
    "Ticket.BadStep",
    {
      key: () => "ticket:bad-step",
      initialState: { opened: false, title: undefined, comments: [] },
      fold: ticketFold,
    },
    (_input, ctx) => {
      ctx.emit("ticket.Opened", { ticketId: "bad-step", title: "bad" });
      ctx.step("notify-slack");
    },
  );
  const externalWriteCommand = command(
    "Ticket.BadExternalWrite",
    {
      key: () => "ticket:bad-external",
      initialState: { opened: false, title: undefined, comments: [] },
      fold: ticketFold,
    },
    (_input, ctx) => {
      ctx.emit("ticket.Opened", { ticketId: "bad-external", title: "bad" });
      ctx.externalWrite("postgres", { id: "bad-external" });
    },
  );

  assert.throws(() => runtime.execute(stepCommand, {}), ForbiddenCommandSideEffectError);
  assert.throws(() => runtime.execute(externalWriteCommand, {}), ForbiddenCommandSideEffectError);
  assert.deepEqual(runtime.readStream("ticket:bad-step"), []);
  assert.deepEqual(runtime.readStream("ticket:bad-external"), []);
});

test("fencing-token-stale writers cannot append", () => {
  const runtime = createCommandRuntime();
  const staleLease = runtime.acquireFence("ticket:delta", { holderId: "stale-writer" });
  const liveLease = runtime.acquireFence("ticket:delta", {
    holderId: "live-writer",
    replace: true,
  });

  assert.throws(
    () => runtime.execute(openTicket, { id: "delta", title: "Fence split" }, { lease: staleLease }),
    StaleFenceError,
  );
  assert.deepEqual(runtime.readStream("ticket:delta"), []);

  const result = runtime.execute(openTicket, { id: "delta", title: "Fence held" }, { lease: liveLease });

  assert.equal(result.seq, 1);
  assert.equal(runtime.readStream("ticket:delta").length, 1);
});

test("live aggregate fences cannot be bypassed by implicit command execution", () => {
  const runtime = createCommandRuntime();
  const ownerLease = runtime.acquireFence("ticket:echo", { holderId: "owner" });

  assert.throws(
    () => runtime.execute(openTicket, { id: "echo", title: "Bypass attempt" }),
    LeaseConflictError,
  );
  assert.deepEqual(runtime.readStream("ticket:echo"), []);

  const result = runtime.execute(openTicket, { id: "echo", title: "Owned write" }, { lease: ownerLease });

  assert.equal(result.seq, 1);
  assert.equal(runtime.readStream("ticket:echo").length, 1);
});
