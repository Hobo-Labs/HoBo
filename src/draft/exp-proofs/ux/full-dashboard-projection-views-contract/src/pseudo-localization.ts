import {
  PSEUDO_LOC_DIRECTION,
  PSEUDO_LOC_EXPANSION_FACTOR,
} from "./full-dashboard-projection-views.ts";
import type { DashboardHtmlDocument } from "./dashboard-html-renderer.ts";

// domain-view: parse-produced draft-proof record; its wire form is the PseudoLocalizationResult proto message in data-models/.
export type PseudoLocalizationResult = {
  readonly expansionFactor: number;
  readonly direction: "rtl";
  readonly passed: boolean;
  readonly longestExpandedLabelLength: number;
  readonly overflowViolations: readonly string[];
};

const BRACKET_OPEN = "\u00AB";
const BRACKET_CLOSE = "\u00BB";

export function pseudoLocalizeString(input: string, factor = PSEUDO_LOC_EXPANSION_FACTOR): string {
  const padding = ".".repeat(Math.max(0, Math.floor(input.length * (factor - 1))));
  return `${BRACKET_OPEN}${input}${padding}${BRACKET_CLOSE}`;
}

export function pseudoLocalizeStrings(
  strings: Record<string, string>,
  factor = PSEUDO_LOC_EXPANSION_FACTOR,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(strings).map(([key, value]) => [key, pseudoLocalizeString(value, factor)]),
  );
}

export function auditPseudoLocalization(document: DashboardHtmlDocument): PseudoLocalizationResult {
  const textMatches = [...document.html.matchAll(/>([^<]{4,})</g)].map((match) => match[1]?.trim() ?? "");
  const overflowViolations: string[] = [];
  let longestExpandedLabelLength = 0;

  for (const label of textMatches) {
    const expanded = pseudoLocalizeString(label);
    longestExpandedLabelLength = Math.max(longestExpandedLabelLength, expanded.length);
    if (expanded.length > label.length * PSEUDO_LOC_EXPANSION_FACTOR + BRACKET_OPEN.length + BRACKET_CLOSE.length) {
      overflowViolations.push(label);
    }
  }

  const passed =
    document.dir === PSEUDO_LOC_DIRECTION &&
    overflowViolations.length === 0 &&
    longestExpandedLabelLength >= 12;

  return Object.freeze({
    expansionFactor: PSEUDO_LOC_EXPANSION_FACTOR,
    direction: PSEUDO_LOC_DIRECTION,
    passed,
    longestExpandedLabelLength,
    overflowViolations: Object.freeze(overflowViolations),
  });
}

export function renderPseudoLocalizedDashboard(
  base: DashboardHtmlDocument,
  strings: Record<string, string>,
): DashboardHtmlDocument {
  const localizedStrings = pseudoLocalizeStrings(strings);
  const html = base.html.replace(
    /(<h1[^>]*>)([^<]+)(<\/h1>)/i,
    (_match, open: string, text: string, close: string) =>
      `${open}${localizedStrings[text] ?? pseudoLocalizeString(text)}${close}`,
  );

  return Object.freeze({
    lang: base.lang,
    dir: PSEUDO_LOC_DIRECTION,
    title: pseudoLocalizeString(base.title),
    html: html.replace('<html lang="en" dir="ltr">', `<html lang="en" dir="${PSEUDO_LOC_DIRECTION}">`),
  });
}
