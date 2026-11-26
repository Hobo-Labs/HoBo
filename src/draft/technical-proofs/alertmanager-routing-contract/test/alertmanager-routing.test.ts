import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ALERT_ROUTING_CONTRACT_VERSION,
  evaluateAlertRouting,
  replayAlertEvents,
} from "../src/alertmanager-routing.js";

const NOW = "2026-06-26T06:45:00.000Z";

test("related SLO burns group into one receiver notification", () => {
  const result = evaluateAlertRouting({
    now: NOW,
    signals: [
      sloBurn("checkout-fast", { sloName: "checkout-api", burnRate: 16.2 }),
      sloBurn("checkout-slow", { sloName: "checkout-api", burnRate: 2.5, window: "slow-burn" }),
    ],
    policy: basePolicy(),
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.equal(result.schemaVersion, ALERT_ROUTING_CONTRACT_VERSION);
  assert.deepEqual(result.deliveries.map((delivery) => delivery.receiverId), ["pagerduty"]);
  assert.equal(result.deliveries[0].alertFingerprints.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["alert.Fired", "alert.Fired", "alert.Grouped", "alert.Routed"],
  );
  assert.equal(result.events.find((event) => event.type === "alert.Grouped").data.groupKey, "sloName=checkout-api");
});

test("active silence suppresses paging and replay explains why no page fired", () => {
  const result = evaluateAlertRouting({
    now: NOW,
    signals: [sloBurn("checkout-fast", { sloName: "checkout-api", burnRate: 16.2 })],
    policy: {
      ...basePolicy(),
      silences: [
        {
          id: "silence-maintenance",
          matcher: { sloName: "checkout-api" },
          startsAt: "2026-06-26T06:00:00.000Z",
          endsAt: "2026-06-26T07:00:00.000Z",
        },
      ],
    },
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.deepEqual(result.deliveries, []);
  assert.equal(result.events.at(-1).type, "alert.Silenced");

  const replay = replayAlertEvents(result.events);
  const explanation = replay.explanations[result.events[0].data.fingerprint];
  assert.equal(explanation.status, "silenced");
  assert.equal(explanation.reason, "silence-maintenance");
});

test("inhibition suppresses dependent alert while root cause is firing", () => {
  const result = evaluateAlertRouting({
    now: NOW,
    signals: [
      signal("gateway-down", {
        kind: "health",
        labels: { service: "gateway", severity: "critical", tenant: "tenant-a" },
      }),
      signal("checkout-burn", {
        kind: "slo",
        labels: { service: "checkout-api", severity: "warning", tenant: "tenant-a" },
      }),
    ],
    policy: {
      ...basePolicy(),
      groupBy: ["tenant"],
      inhibitions: [
        {
          id: "root-cause-critical-suppresses-warning",
          sourceMatcher: { severity: "critical" },
          targetMatcher: { severity: "warning" },
          equal: ["tenant"],
        },
      ],
    },
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.deepEqual(result.deliveries.map((delivery) => delivery.alertFingerprints.length), [1]);
  assert.equal(result.events.filter((event) => event.type === "alert.Inhibited").length, 1);

  const replay = replayAlertEvents(result.events);
  const inhibited = Object.values(replay.explanations).find((entry) => entry.status === "inhibited");
  assert.equal(inhibited.reason, "root-cause-critical-suppresses-warning");
});

test("receiver failure preserves alert record and schedules durable retry", () => {
  const result = evaluateAlertRouting({
    now: NOW,
    signals: [sloBurn("checkout-fast", { sloName: "checkout-api", burnRate: 16.2 })],
    policy: basePolicy(),
    receivers: {
      pagerduty: failingReceiver("pagerduty"),
    },
  });

  assert.equal(result.deliveries.length, 0);
  assert.equal(result.pendingDeliveries.length, 1);
  assert.equal(result.events.find((event) => event.type === "alert.Routed").data.status, "retry-scheduled");

  const replay = replayAlertEvents(result.events);
  assert.equal(replay.pendingDeliveries.length, 1);
  assert.equal(replay.explanations[result.events[0].data.fingerprint].status, "retry-scheduled");
});

test("alert storm is capped into one grouped notification with overflow evidence", () => {
  const signals = Array.from({ length: 150 }, (_, index) =>
    sloBurn(`checkout-${index}`, { sloName: "checkout-api", burnRate: 20 + index }),
  );

  const result = evaluateAlertRouting({
    now: NOW,
    signals,
    policy: {
      ...basePolicy(),
      maxGroupSize: 100,
    },
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].alertFingerprints.length, 100);
  assert.equal(result.events.find((event) => event.type === "alert.Grouped").data.overflowCount, 50);
});

test("expired silence does not suppress and circular inhibition fails closed without looping", () => {
  const result = evaluateAlertRouting({
    now: NOW,
    signals: [
      signal("a", { labels: { service: "a", severity: "critical" } }),
      signal("b", { labels: { service: "b", severity: "warning" } }),
    ],
    policy: {
      ...basePolicy(),
      silences: [
        {
          id: "expired",
          matcher: { service: "a" },
          startsAt: "2026-06-26T05:00:00.000Z",
          endsAt: "2026-06-26T06:00:00.000Z",
        },
      ],
      inhibitions: [
        { id: "a-suppresses-b", sourceMatcher: { service: "a" }, targetMatcher: { service: "b" } },
        { id: "b-suppresses-a", sourceMatcher: { service: "b" }, targetMatcher: { service: "a" } },
      ],
    },
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.equal(result.events.filter((event) => event.type === "alert.InhibitionCycleRejected").length, 1);
  assert.equal(result.events.filter((event) => event.type === "alert.Silenced").length, 0);
  assert.equal(result.deliveries[0].alertFingerprints.length, 2);
});

test("multi-rule inhibition cycle fails closed before suppressing alerts", () => {
  const result = evaluateAlertRouting({
    now: NOW,
    signals: [
      signal("a", { labels: { service: "a" } }),
      signal("b", { labels: { service: "b" } }),
      signal("c", { labels: { service: "c" } }),
    ],
    policy: {
      ...basePolicy(),
      inhibitions: [
        { id: "a-suppresses-b", sourceMatcher: { service: "a" }, targetMatcher: { service: "b" } },
        { id: "b-suppresses-c", sourceMatcher: { service: "b" }, targetMatcher: { service: "c" } },
        { id: "c-suppresses-a", sourceMatcher: { service: "c" }, targetMatcher: { service: "a" } },
      ],
    },
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.deepEqual(result.events.find((event) => event.type === "alert.InhibitionCycleRejected").data.ruleIds, [
    "a-suppresses-b",
    "b-suppresses-c",
    "c-suppresses-a",
  ]);
  assert.equal(result.deliveries[0].alertFingerprints.length, 3);
});

test("flapping signal is deduped during cooldown but resolve still replays", () => {
  const first = evaluateAlertRouting({
    now: NOW,
    signals: [sloBurn("checkout-fast", { sloName: "checkout-api", burnRate: 16.2 })],
    policy: basePolicy(),
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });
  const second = evaluateAlertRouting({
    now: "2026-06-26T06:46:00.000Z",
    previousEvents: first.events,
    signals: [
      sloBurn("checkout-fast-again", {
        sloName: "checkout-api",
        burnRate: 17,
        fingerprintSeed: "checkout-fast",
      }),
    ],
    policy: basePolicy(),
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });
  const resolved = evaluateAlertRouting({
    now: "2026-06-26T06:47:00.000Z",
    previousEvents: [...first.events, ...second.events],
    signals: [
      sloBurn("checkout-fast-resolved", {
        sloName: "checkout-api",
        burnRate: 0,
        status: "resolved",
        fingerprintSeed: "checkout-fast",
      }),
    ],
    policy: basePolicy(),
    receivers: {
      pagerduty: recordingReceiver("pagerduty"),
    },
  });

  assert.equal(second.deliveries.length, 0);
  assert.equal(second.events.at(-1).type, "alert.Deduped");
  assert.equal(resolved.events.at(-1).type, "alert.Resolved");

  const replay = replayAlertEvents([...first.events, ...second.events, ...resolved.events]);
  assert.equal(replay.explanations[first.events[0].data.fingerprint].status, "resolved");
});

function basePolicy() {
  return {
    groupBy: ["sloName"],
    dedupWindow: "5m",
    routes: [
      {
        id: "slo-pages",
        matcher: { kind: "slo" },
        receiverId: "pagerduty",
      },
      {
        id: "health-pages",
        matcher: { kind: "health" },
        receiverId: "pagerduty",
      },
    ],
  };
}

function sloBurn(id, overrides = {}) {
  return signal(id, {
    kind: "slo",
    type: "slo.BudgetBurned",
    labels: {
      sloName: overrides.sloName ?? "checkout-api",
      severity: "page",
      window: overrides.window ?? "fast-burn",
    },
    status: overrides.status ?? "firing",
    metric: {
      burnRate: overrides.burnRate ?? 10,
      remainingBudgetRatio: overrides.remainingBudgetRatio ?? 0.1,
    },
    fingerprintSeed: overrides.fingerprintSeed,
  });
}

function signal(id, overrides = {}) {
  return {
    id,
    kind: overrides.kind ?? "slo",
    type: overrides.type ?? "health.Degraded",
    status: overrides.status ?? "firing",
    startsAt: overrides.startsAt ?? NOW,
    labels: overrides.labels ?? {},
    metric: overrides.metric ?? {},
    fingerprintSeed: overrides.fingerprintSeed,
  };
}

function recordingReceiver(receiverId) {
  return {
    send(delivery) {
      return {
        ok: true,
        receiverId,
        providerMessageId: `${receiverId}:${delivery.groupKey}`,
      };
    },
  };
}

function failingReceiver(receiverId) {
  return {
    send() {
      return {
        ok: false,
        receiverId,
        retryAfter: "30s",
        error: "provider-down",
      };
    },
  };
}
