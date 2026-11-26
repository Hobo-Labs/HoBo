import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  MembraneOverloadedError,
  MembraneSeveredError,
} from "../../wrpc-membrane-failure-contract/src/wrpc-membrane-failure.js";
import {
  createLatticeTransportContract,
  runLatticeTransportConformance,
} from "../src/wrpc-lattice-transport.js";

describe("wRPC NATS/JetStream lattice transport contract", () => {
  it("invokes the same WIT component through co-located and second-host providers with identical behavior", async () => {
    const lattice = createLatticeTransportContract();
    lattice.registerHost({ id: "host-a" });
    lattice.registerHost({ id: "host-b" });
    lattice.registerComponent({
      id: "cart-api",
      hostId: "host-a",
      imports: ["wasi:keyvalue/store"],
    });
    lattice.registerProvider(kvProvider({ id: "kv-local", hostId: "host-a" }));
    lattice.registerProvider(kvProvider({ id: "kv-remote", hostId: "host-b" }));

    lattice.link({
      componentId: "cart-api",
      importInterface: "wasi:keyvalue/store",
      providerId: "kv-local",
      exportInterface: "wasi:keyvalue/store",
    });
    const local = await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
      key: "session",
    });

    lattice.link({
      componentId: "cart-api",
      importInterface: "wasi:keyvalue/store",
      providerId: "kv-remote",
      exportInterface: "wasi:keyvalue/store",
    });
    const remote = await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
      key: "session",
    });

    assert.deepEqual(remote, local);
    assert.deepEqual(
      lattice
        .report()
        .events.filter((event) => event.type === "link.Established")
        .map((event) => event.transport),
      ["in-process", "nats-jetstream-lattice"],
    );
  });

  it("meshes two wasmCloud hosts over NATS/JetStream and resolves a cross-host link", async () => {
    const lattice = createLatticeTransportContract();
    lattice.registerHost({ id: "host-a" });
    lattice.registerHost({ id: "host-b" });
    lattice.registerComponent({
      id: "cart-api",
      hostId: "host-a",
      imports: ["wasi:keyvalue/store"],
    });
    lattice.registerProvider(kvProvider({ id: "kv-remote", hostId: "host-b" }));

    const link = lattice.link({
      componentId: "cart-api",
      importInterface: "wasi:keyvalue/store",
      providerId: "kv-remote",
      exportInterface: "wasi:keyvalue/store",
    });

    const result = await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
      key: "cart",
    });
    const report = lattice.report();

    assert.equal(link.transport, "nats-jetstream-lattice");
    assert.equal(link.jetStream.stream, "hobo-wrpc-links");
    assert.match(link.subject, /^wrpc\.hobo\.host-a\.host-b\./);
    assert.deepEqual(result, { value: "stored:cart" });
    assert.deepEqual(report.lattice.hosts, ["host-a", "host-b"]);
    assert.ok(report.events.some((event) => event.type === "lattice.MessagePublished"));
    assert.ok(
      report.events.some(
        (event) =>
          event.type === "lattice.MessageDelivered" &&
          event.providerHostId === "host-b" &&
          event.subject === link.subject,
      ),
    );
  });

  it("resolves same-host cross-process links through the lattice transport", async () => {
    const lattice = createLatticeTransportContract();
    lattice.registerHost({ id: "host-a" });
    lattice.registerComponent({
      id: "cart-api",
      hostId: "host-a",
      processId: "api-process",
      imports: ["wasi:keyvalue/store"],
    });
    lattice.registerProvider({
      ...kvProvider({ id: "kv-sidecar", hostId: "host-a" }),
      processId: "provider-process",
    });

    const link = lattice.link({
      componentId: "cart-api",
      importInterface: "wasi:keyvalue/store",
      providerId: "kv-sidecar",
      exportInterface: "wasi:keyvalue/store",
    });
    const result = await lattice.callImport("cart-api", "wasi:keyvalue/store", "get", {
      key: "same-host",
    });

    assert.equal(link.transport, "nats-jetstream-lattice");
    assert.equal(link.crossProcess, true);
    assert.equal(link.crossHost, false);
    assert.deepEqual(result, { value: "stored:same-host" });
  });

  it("classifies a NATS partition severing a mid-stream call as partial failure", async () => {
    const lattice = createLatticeTransportContract();
    lattice.registerHost({ id: "host-a" });
    lattice.registerHost({ id: "host-b" });
    lattice.registerComponent({
      id: "uploader",
      hostId: "host-a",
      imports: ["wasi:io/streams"],
    });
    lattice.registerProvider({
      id: "blob-remote",
      hostId: "host-b",
      exports: {
        "wasi:io/streams": {
          async write(_payload, context) {
            context.severMidStream({ committed: "unknown" });
          },
        },
      },
    });
    lattice.link({
      componentId: "uploader",
      importInterface: "wasi:io/streams",
      providerId: "blob-remote",
      exportInterface: "wasi:io/streams",
    });

    await assert.rejects(
      () =>
        lattice.callImport("uploader", "wasi:io/streams", "write", {
          chunk: "first",
        }),
      (error) => {
        assert.ok(error instanceof MembraneSeveredError);
        assert.equal(error.membrane, "severed");
        assert.equal(error.failure.class, "partial-failure");
        assert.equal(error.failure.requiresIdempotencyDecision, true);
        return true;
      },
    );

    assert.ok(
      lattice.report().events.some(
        (event) =>
          event.type === "link.Failed" &&
          event.failureClass === "partial-failure" &&
          event.reason === "nats-partition-mid-stream",
      ),
    );
  });

  it("maps JetStream flow-control mismatch to bounded membrane backpressure", async () => {
    let unblock;
    const slowPut = new Promise((resolve) => {
      unblock = resolve;
    });
    const lattice = createLatticeTransportContract();
    lattice.registerHost({ id: "host-a" });
    lattice.registerHost({ id: "host-b" });
    lattice.registerComponent({
      id: "writer",
      hostId: "host-a",
      imports: ["wasi:keyvalue/store"],
    });
    lattice.registerProvider({
      id: "kv-remote",
      hostId: "host-b",
      maxInFlight: 1,
      exports: {
        "wasi:keyvalue/store": {
          async set() {
            await slowPut;
            return { ok: true };
          },
        },
      },
    });
    lattice.link({
      componentId: "writer",
      importInterface: "wasi:keyvalue/store",
      providerId: "kv-remote",
      exportInterface: "wasi:keyvalue/store",
    });

    const first = lattice.callImport("writer", "wasi:keyvalue/store", "set", {
      key: "one",
    });

    await assert.rejects(
      () =>
        lattice.callImport("writer", "wasi:keyvalue/store", "set", {
          key: "two",
        }),
      (error) => {
        assert.ok(error instanceof MembraneOverloadedError);
        assert.equal(error.membrane, "overloaded");
        assert.equal(error.failure.class, "transient");
        assert.equal(error.maxInFlight, 1);
        return true;
      },
    );

    unblock();
    await first;
    assert.ok(
      lattice.report().events.some(
        (event) =>
          event.type === "lattice.FlowControlled" &&
          event.failureClass === "transient",
      ),
    );
  });

  it("publishes HOBO-27 conformance scope and declares host timing non-covered", async () => {
    const report = await runLatticeTransportConformance();

    assert.equal(report.schema, "hobo.wrpc.lattice-transport/v1");
    assert.equal(report.issue, "HOBO-27");
    assert.deepEqual(report.supportedTransports, [
      "in-process",
      "nats-jetstream-lattice",
    ]);
    assert.deepEqual(report.assertions, {
      identicalCoLocatedAndCrossHostBehavior: "pass",
      crossHostLinkResolution: "pass",
      crossProcessLinkResolution: "pass",
      midStreamPartitionPartialFailure: "pass",
      jetStreamFlowControlBackpressure: "pass",
    });
    assert.deepEqual(report.nonCoveredDivergences, [
      "host-specific partial-failure timing",
      "wall-clock scheduling jitter across hosts",
    ]);
    assert.deepEqual(report.scopeOut, [
      "wasmcloud-operator or Kubernetes packaging",
      "lattice link-migration host-.with()",
      "provider-native or SpinKube adapters",
    ]);
  });
});

function kvProvider({ id, hostId }) {
  return {
    id,
    hostId,
    exports: {
      "wasi:keyvalue/store": {
        get(payload) {
          return { value: `stored:${payload.key}` };
        },
      },
    },
  };
}
