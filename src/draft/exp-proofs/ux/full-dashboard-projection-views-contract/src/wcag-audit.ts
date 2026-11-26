import type { DashboardHtmlDocument } from "./dashboard-html-renderer.ts";

export type WcagViolation = {
  readonly rule: string;
  readonly impact: "critical" | "serious" | "moderate";
  readonly message: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the WcagAuditResult proto message in data-models/.
export type WcagAuditResult = {
  readonly target: "WCAG-2.1-AA";
  readonly passed: boolean;
  readonly violations: readonly WcagViolation[];
};

export function auditWcag21Aa(document: DashboardHtmlDocument): WcagAuditResult {
  const violations: WcagViolation[] = [];
  const html = document.html;

  if (!/<html[^>]*lang="/i.test(html)) {
    violations.push({
      rule: "html-has-lang",
      impact: "serious",
      message: "Document must declare a lang attribute.",
    });
  }

  if (!/<h1\b/i.test(html)) {
    violations.push({
      rule: "page-has-heading-one",
      impact: "moderate",
      message: "Document must include exactly one top-level heading.",
    });
  }

  for (const section of html.matchAll(/<section\b[^>]*data-view="([^"]+)"[^>]*>/gi)) {
    const viewId = section[1];
    if (!new RegExp(`aria-labelledby="${viewId}-heading"`, "i").test(section[0] ?? "")) {
      violations.push({
        rule: "region-name",
        impact: "serious",
        message: `View section ${viewId} must name its region.`,
      });
    }
    if (!new RegExp(`<h2[^>]*id="${viewId}-heading"`, "i").test(html)) {
      violations.push({
        rule: "heading-order",
        impact: "moderate",
        message: `View section ${viewId} must expose a level-two heading.`,
      });
    }
  }

  if (!/<a[^>]*href="#dashboard-main"/i.test(html)) {
    violations.push({
      rule: "bypass-block",
      impact: "serious",
      message: "Dashboard must expose a skip link to main content.",
    });
  }

  if (!/<main[^>]*id="dashboard-main"/i.test(html)) {
    violations.push({
      rule: "landmark-main-is-top-level",
      impact: "serious",
      message: "Dashboard must expose a main landmark.",
    });
  }

  if (!/<nav[^>]*aria-label="/i.test(html)) {
    violations.push({
      rule: "landmark-unique",
      impact: "moderate",
      message: "Dashboard navigation must be labeled.",
    });
  }

  for (const input of html.matchAll(/<input[^>]*type="range"[^>]*>/gi)) {
    const tag = input[0] ?? "";
    if (!/aria-labelledby="/i.test(tag)) {
      violations.push({
        rule: "input-range-has-label",
        impact: "serious",
        message: "Time-travel scrubber range input must have an accessible label.",
      });
    }
  }

  if (/<img\b(?![^>]*\balt=)/i.test(html)) {
    violations.push({
      rule: "image-alt",
      impact: "critical",
      message: "Images must include alt text.",
    });
  }

  return Object.freeze({
    target: "WCAG-2.1-AA",
    passed: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
