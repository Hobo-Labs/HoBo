import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  TriggerDispatcher,
  api,
  compileHandlerManifest,
  createLocalEventStore,
  createRuntimeLocalPorts,
  schedule,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "../contracts/manifests/hello-bindle.manifest.json");

describe("hello-bindle manifest fixture", () => {
  it("collects GET /hello and schedule.every tick deterministically", () => {
    const logs: string[] = [];

    async function helloHandler() {
      return { message: "hello" };
    }
    Object.defineProperty(helloHandler, "name", { value: "helloHandler" });

    function tickHandler() {
      logs.push("tick");
    }
    Object.defineProperty(tickHandler, "name", { value: "tickHandler" });

    const app = api("api");
    const tick = schedule("tick");
    app.get("/hello", helloHandler);
    tick.every("5s", tickHandler);

    const manifest = compileHandlerManifest([app, tick]);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const fixture = readFileSync(fixturePath, "utf8");

    assert.equal(serialized, fixture);
    assert.equal(manifest.triggerEdges!.length, 2);
    assert.equal(manifest.triggerEdges![0].kind, "http.route");
    assert.equal(manifest.triggerEdges![1].kind, "schedule.every");
  });

  it("boots hello-bindle manifest through TriggerDispatcher offline", async () => {
    const logs: string[] = [];
    const manifest = JSON.parse(readFileSync(fixturePath, "utf8"));
    const ports = createRuntimeLocalPorts();
    const eventStore = createLocalEventStore();

    async function helloHandler() {
      return { message: "hello" };
    }
    Object.defineProperty(helloHandler, "name", { value: "helloHandler" });

    function tickHandler() {
      logs.push("tick");
    }
    Object.defineProperty(tickHandler, "name", { value: "tickHandler" });

    const dispatcher = new TriggerDispatcher({
      manifest,
      ports,
      eventStore,
      handlers: {
        get: (name) =>
          ({
            helloHandler,
            tickHandler,
          })[name],
      },
    });
    dispatcher.wire();

    const response = await dispatcher.handleHttp({ method: "GET", path: "/hello" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { message: "hello" });

    await dispatcher.tickSchedule("tick");
    assert.deepEqual(logs, ["tick"]);
    assert.equal(eventStore.events.length, 2);
  });
});
