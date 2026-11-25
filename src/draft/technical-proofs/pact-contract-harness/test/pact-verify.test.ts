import { describe, expect, it } from "vitest";
import { parsePactDocument } from "../src/pact.js";
import { verifyPact, type ProviderStub } from "../src/verify.js";

const pact = parsePactDocument({
  consumer: { name: "TestConsumer" },
  provider: { name: "TestProvider" },
  interactions: [
    {
      description: "happy path",
      request: { method: "GET", path: "/items" },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: 1, name: "alpha" },
      },
    },
  ],
  metadata: { pactSpecification: { version: "3.0.0" } },
});

function stubFrom(
  name: string,
  handler: ProviderStub["handle"],
): ProviderStub {
  return { name, handle: handler };
}

describe("verifyPact", () => {
  it("passes when provider returns extra fields", async () => {
    const provider = stubFrom("TestProvider", () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: 1, name: "alpha", extra: "tolerated" },
    }));

    const report = await verifyPact(pact, provider);
    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("fails when a declared body field is missing", async () => {
    const provider = stubFrom("TestProvider", () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: 1 },
    }));

    const report = await verifyPact(pact, provider);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.reason).toMatch(/name/);
  });

  it("fails on wrong status", async () => {
    const provider = stubFrom("TestProvider", () => ({
      status: 500,
      headers: { "content-type": "application/json" },
      body: { id: 1, name: "alpha" },
    }));

    const report = await verifyPact(pact, provider);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.reason).toMatch(/status/);
  });

  it("fails on wrong declared header", async () => {
    const provider = stubFrom("TestProvider", () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: { id: 1, name: "alpha" },
    }));

    const report = await verifyPact(pact, provider);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.reason).toMatch(/content-type/);
  });

  it("fails when provider identity does not match the pact", async () => {
    const provider = stubFrom("OtherProvider", () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: 1, name: "alpha" },
    }));

    const report = await verifyPact(pact, provider);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.description).toBe("provider identity");
    expect(report.failures[0]?.reason).toMatch(/TestProvider/);
  });
});
