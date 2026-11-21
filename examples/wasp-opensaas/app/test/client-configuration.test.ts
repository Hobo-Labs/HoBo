import { beforeEach, describe, expect, it } from "vitest";
import { legalLinks } from "../src/client/components/cookie-consent/legalLinks";
import { installPlausibleAnalytics } from "../src/client/components/plausibleAnalytics";

beforeEach(() => document.head.querySelector("#plausible-analytics")?.remove());

describe("client configuration", () => {
  it("loads one configured analytics script and ignores invalid domains", () => {
    installPlausibleAnalytics(document, undefined, true);
    installPlausibleAnalytics(document, 'example.com" onload="alert(1)', true);
    expect(document.head.querySelector("#plausible-analytics")).toBeNull();
    installPlausibleAnalytics(document, "example.com", true);
    installPlausibleAnalytics(document, "example.com", true);
    const scripts = document.head.querySelectorAll<HTMLScriptElement>(
      "#plausible-analytics",
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0].dataset.domain).toBe("example.com");
    expect(scripts[0].src).toBe("https://plausible.io/js/script.js");
  });

  it("uses the local analytics script during development", () => {
    installPlausibleAnalytics(document, "localhost", false);
    expect(
      document.head.querySelector<HTMLScriptElement>("#plausible-analytics")
        ?.src,
    ).toBe("https://plausible.io/js/script.local.js");
  });

  it("renders only safe configured policy links", () => {
    const links = legalLinks(
      "/privacy?version=1&view=full",
      "https://example.com/terms",
      "https://app.example.com",
    );
    expect(links).toContain(
      'href="https://app.example.com/privacy?version=1&amp;view=full"',
    );
    expect(links).toContain('href="https://example.com/terms"');
    expect(links).toContain('rel="noopener noreferrer"');
    expect(
      legalLinks(
        "javascript:alert(1)",
        "//example.com/terms",
        "https://app.example.com",
      ),
    ).toBe("");
    expect(
      legalLinks(
        "https://user:password@example.com",
        undefined,
        "https://app.example.com",
      ),
    ).toBe("");
    expect(legalLinks(undefined, undefined, "https://app.example.com")).toBe(
      "",
    );
  });
});
