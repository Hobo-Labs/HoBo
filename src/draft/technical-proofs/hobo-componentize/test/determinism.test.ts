import { describe, expect, it } from "vitest";

import { runComponentSmoke } from "../src/index.js";
import { buildHelloBindle, componentizeRealBuildSkipReason } from "./helpers.js";

const realBuildIt = componentizeRealBuildSkipReason ? it.skip : it;

describe("componentize determinism", () => {
  // Two full real builds back-to-back; cold CI runners exceed the 360s
  // default lane budget even though local runs finish in ~75s.
  realBuildIt("keeps canonical inputs stable and smoke output consistent across rebuilds", { timeout: 900_000 }, async () => {
    const first = await buildHelloBindle();
    const second = await buildHelloBindle();

    expect(second.reproducibility.inputsDigest).toBe(first.reproducibility.inputsDigest);
    expect(second.reproducibility.sourceDigests).toEqual(first.reproducibility.sourceDigests);

    const firstSmoke = await runComponentSmoke(first.component, { exportName: "health" });
    const secondSmoke = await runComponentSmoke(second.component, { exportName: "health" });
    expect(secondSmoke.stdout).toBe(firstSmoke.stdout);
    expect(secondSmoke.stdout).toBe("hello-bindle:ok\n");

    if (second.component.digest === first.component.digest) {
      expect(Buffer.from(second.component.bytes)).toEqual(Buffer.from(first.component.bytes));
      expect(second.oci.manifestDigest).toBe(first.oci.manifestDigest);
    }
  }, 360_000);
});
