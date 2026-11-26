import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createInspectCli,
  createInspectStore,
  fixtureEvents,
} from "../src/inspect-contract.js";

test("inspect run --last renders the local step timeline without auth", async () => {
  const oldLexicallyLastRun = {
    seq: 0,
    type: "run.Started",
    streamId: "run:zz-old",
    data: { runId: "zz-old" },
  };
  const cli = createInspectCli({ store: createInspectStore([...fixtureEvents(), oldLexicallyLastRun]) });

  const result = await cli.run(["run", "--last"], { source: "local", identity: null });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Run run-2\s+PARTIAL/);
  assert.match(result.stdout, /step\s+plan\s+completed\s+attempts=1\s+duration=11ms/);
  assert.match(result.stdout, /step\s+apply\s+running\s+attempts=1/);
  assert.doesNotMatch(result.stdout, /login/i);
});

test("inspect run --at reproduces historical state and JSON uses a stable envelope", async () => {
  const store = createInspectStore(fixtureEvents());
  const cli = createInspectCli({ store });

  const result = await cli.run(["run", "run-1", "--at", "4", "--json"], { source: "local" });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope), ["ok", "verb", "subject", "selector", "source", "at", "seq", "view"]);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.verb, "inspect");
  assert.equal(envelope.subject, "run");
  assert.equal(envelope.selector, "run-1");
  assert.equal(envelope.source, "local");
  assert.equal(envelope.at, 4);
  assert.equal(envelope.seq.head, 4);
  assert.equal(envelope.view.status, "completed");
  assert.equal(envelope.view.partial, false);
  assert.deepEqual(
    envelope.view.steps.map((step) => [step.name, step.status]),
    [
      ["plan", "completed"],
      ["apply", "completed"],
    ],
  );
});

test("inspect topology lists resolved providers and bind edges", async () => {
  const cli = createInspectCli({ store: createInspectStore(fixtureEvents()) });

  const result = await cli.run(["topology", "--json"], { source: "local" });

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.view.resources, [
    { id: "api", kind: "service", provider: "aws", region: "us-east-1" },
    { id: "db", kind: "postgres", provider: "neon", region: "us-east-1" },
  ]);
  assert.deepEqual(envelope.view.bindEdges, [
    { from: "api", to: "db", capability: "postgres", tier: "private-link" },
  ]);
});

test("from-zero projection rebuild equals the live view for the same query", () => {
  const store = createInspectStore(fixtureEvents());

  const live = store.inspect("deploy", { selector: "deploy-1" });
  const rebuilt = createInspectStore([...fixtureEvents()].reverse()).inspect("deploy", { selector: "deploy-1" });

  assert.deepEqual(rebuilt, live);
});

test("adversarial inspect cases fail closed or stay honest", async () => {
  const cli = createInspectCli({ store: createInspectStore(fixtureEvents()) });

  const unknown = await cli.run(["run", "missing-run"], { source: "local" });
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /Unknown run "missing-run"/);
  assert.doesNotMatch(unknown.stderr, /empty/i);

  const beyondHead = await cli.run(["run", "run-1", "--at", "999"], { source: "local" });
  assert.equal(beyondHead.exitCode, 2);
  assert.match(beyondHead.stderr, /beyond log head 11/);

  const remoteNoSvid = await cli.run(["deploy", "deploy-1", "--remote"], {
    source: "remote",
    identity: null,
  });
  assert.equal(remoteNoSvid.exitCode, 1);
  assert.match(remoteNoSvid.stderr, /Run "hobo login"/);
  assert.doesNotMatch(remoteNoSvid.stdout, /deploy-1/);
});
