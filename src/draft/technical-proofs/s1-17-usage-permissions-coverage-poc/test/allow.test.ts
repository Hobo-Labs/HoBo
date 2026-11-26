import { describe, expect, it } from "vitest";

import { createResourceHandle } from "../src/allow.js";

describe(".allow() authoring surface", () => {
  it("throws TypeError when called with zero verbs", () => {
    const handle = createResourceHandle({
      kind: "kv",
      name: "cache",
      port: "wasi:keyvalue",
      catalogVerbs: ["get", "set"],
    });

    expect(() => handle.allow()).toThrow(TypeError);
    expect(() => handle.allow()).toThrow(/at least one verb/);
  });

  it("records declaredAllow facts for narrowing calls", () => {
    const narrowed = createResourceHandle({
      kind: "topic",
      name: "events",
      port: "wasi:messaging",
      catalogVerbs: ["publish", "subscribe"],
    }).allow("publish");

    expect(narrowed.facts.declaredAllow).toEqual(["publish"]);
    expect(narrowed.facts.dynamicAllow).toBeUndefined();
  });

  it("records dynamicAllow facts when dynamic option is provided", () => {
    const dynamic = createResourceHandle({
      kind: "queue",
      name: "mail",
      port: "hobo:queue",
      catalogVerbs: ["enqueue", "dequeue"],
    }).allow({ dynamic: true, reason: "worker may dequeue at runtime" }, "dequeue");

    expect(dynamic.facts.dynamicAllow).toEqual(["dequeue"]);
    expect(dynamic.facts.dynamicReason).toBe("worker may dequeue at runtime");
    expect(dynamic.facts.declaredAllow).toEqual(["dequeue"]);
  });

  it("requires non-empty reason for dynamic grants", () => {
    const handle = createResourceHandle({
      kind: "queue",
      name: "mail",
      port: "hobo:queue",
      catalogVerbs: ["enqueue", "dequeue"],
    });

    expect(() => handle.allow({ dynamic: true, reason: "" }, "dequeue")).toThrow(TypeError);
  });
});
