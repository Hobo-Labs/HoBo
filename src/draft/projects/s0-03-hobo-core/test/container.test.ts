import { describe, expect, it } from "vitest";

import { createContainer, createPortDescriptor } from "../src/index.js";

describe("DI container", () => {
  it("registers and resolves ports by descriptor key", () => {
    const runtimePort = createPortDescriptor({
      kind: "runtime",
      name: "EventStore",
      interface: "hobo:runtime/event-store@0.1.0",
      stability: "stable",
    });
    const providerPort = createPortDescriptor({
      kind: "provider",
      name: "CloudProvider",
      interface: "hobo:provider/cloud@0.1.0",
      stability: "preview",
    });
    const container = createContainer();

    container.register(runtimePort, { append: () => "ok" });
    container.register(providerPort, { realize: () => "preview" });

    expect(container.resolve<{ append: () => string }>(runtimePort).append()).toBe("ok");
    expect(container.resolve<{ realize: () => string }>(providerPort).realize()).toBe("preview");
  });

  it("throws on duplicate registration", () => {
    const descriptor = createPortDescriptor({
      kind: "runtime",
      name: "EventStore",
      interface: "hobo:runtime/event-store@0.1.0",
      stability: "stable",
    });
    const container = createContainer();
    container.register(descriptor, {});

    expect(() => container.register(descriptor, {})).toThrow(/already registered/);
  });

  it("throws when resolving an unregistered port", () => {
    const descriptor = createPortDescriptor({
      kind: "runtime",
      name: "Queue",
      interface: "hobo:runtime/queue@0.1.0",
      stability: "stable",
    });
    const container = createContainer();

    expect(() => container.resolve(descriptor)).toThrow(/not registered/);
  });
});
