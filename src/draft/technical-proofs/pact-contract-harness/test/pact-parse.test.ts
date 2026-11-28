import { describe, expect, it } from "vitest";
import { parsePactDocument, PactParseError } from "../src/pact.js";

const validPact = {
  consumer: { name: "CoreReferenceConsumer" },
  provider: { name: "CoreContractSurface" },
  interactions: [
    {
      description: "ok",
      request: { method: "POST", path: "/core/contract-surface" },
      response: { status: 200, body: { ok: true } },
    },
  ],
  metadata: { pactSpecification: { version: "3.0.0" } },
};

describe("parsePactDocument", () => {
  it("accepts a valid pact document", () => {
    const pact = parsePactDocument(validPact);
    expect(pact.consumer.name).toBe("CoreReferenceConsumer");
    expect(pact.interactions).toHaveLength(1);
  });

  it("rejects bad participant names", () => {
    expect(() =>
      parsePactDocument({
        ...validPact,
        consumer: { name: "bad-name" },
      }),
    ).toThrow(PactParseError);

    try {
      parsePactDocument({ ...validPact, consumer: { name: "bad-name" } });
    } catch (error) {
      expect(error).toBeInstanceOf(PactParseError);
      // SAFETY: assertion to `expect((error as PactParseError).issues.some((issue) => issue.includes("consumer` is required at this boundary.
      expect((error as PactParseError).issues.some((issue) => issue.includes("consumer.name"))).toBe(
        true,
      );
    }
  });

  it("rejects empty interactions", () => {
    try {
      parsePactDocument({ ...validPact, interactions: [] });
    } catch (error) {
      // SAFETY: assertion to `expect((error as PactParseError).issues).toContain("interactions must be non-emp` is required at this boundary.
      expect((error as PactParseError).issues).toContain("interactions must be non-empty");
    }
  });

  it("rejects wrong pact specification version", () => {
    try {
      parsePactDocument({
        ...validPact,
        metadata: { pactSpecification: { version: "2.0.0" } },
      });
    } catch (error) {
      // SAFETY: assertion to `expect((error as PactParseError).issues).toContain(` is required at this boundary.
      expect((error as PactParseError).issues).toContain(
        'metadata.pactSpecification.version must be "3.0.0"',
      );
    }
  });

  it("rejects invalid HTTP methods", () => {
    try {
      parsePactDocument({
        ...validPact,
        interactions: [
          {
            description: "bad method",
            request: { method: "TRACE", path: "/x" },
            response: { status: 200 },
          },
        ],
      });
    } catch (error) {
      // SAFETY: assertion to `expect((error as PactParseError).issues.some((issue) => issue.includes("method")` is required at this boundary.
      expect((error as PactParseError).issues.some((issue) => issue.includes("method"))).toBe(true);
    }
  });

  it("rejects paths that do not start with /", () => {
    try {
      parsePactDocument({
        ...validPact,
        interactions: [
          {
            description: "bad path",
            request: { method: "GET", path: "no-leading-slash" },
            response: { status: 200 },
          },
        ],
      });
    } catch (error) {
      // SAFETY: assertion to `expect((error as PactParseError).issues.some((issue) => issue.includes("path")))` is required at this boundary.
      expect((error as PactParseError).issues.some((issue) => issue.includes("path"))).toBe(true);
    }
  });

  it("rejects out-of-range status codes", () => {
    try {
      parsePactDocument({
        ...validPact,
        interactions: [
          {
            description: "bad status",
            request: { method: "GET", path: "/x" },
            response: { status: 99 },
          },
        ],
      });
    } catch (error) {
      // SAFETY: assertion to `expect((error as PactParseError).issues.some((issue) => issue.includes("status")` is required at this boundary.
      expect((error as PactParseError).issues.some((issue) => issue.includes("status"))).toBe(true);
    }
  });

  it("collects multiple violations before throwing", () => {
    try {
      parsePactDocument({
        consumer: { name: "bad" },
        provider: { name: "also-bad" },
        interactions: [],
        metadata: { pactSpecification: { version: "1.0.0" } },
      });
      expect.fail("expected parse error");
    } catch (error) {
      // SAFETY: assertion to `const issues = (error as PactParseError).issues;` is required at this boundary.
      const issues = (error as PactParseError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(4);
    }
  });
});
