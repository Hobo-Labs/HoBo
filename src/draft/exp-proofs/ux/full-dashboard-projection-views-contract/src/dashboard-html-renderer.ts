import type { DashboardRenderResult, RenderedDashboardView } from "./full-dashboard-projection-views.ts";
import { type JsonValue } from "./json.js";


export type DashboardHtmlDocument = {
  readonly lang: string;
  readonly dir: "ltr" | "rtl";
  readonly title: string;
  readonly html: string;
};

function escapeHtml(value: JsonValue): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderViewSection(view: RenderedDashboardView, strings: Record<string, string>): string {
  const heading = strings[view.title] ?? view.title;
  const projectionLabel = `${strings["Projection source"] ?? "Projection source"}: ${view.projectionSource}`;
  const scrubber =
    view.scrubberAtSeq === undefined
      ? ""
      : `<p><span id="${view.id}-scrubber-label">${escapeHtml(strings["Time travel scrubber"] ?? "Time travel scrubber")}</span> <input type="range" aria-labelledby="${view.id}-scrubber-label" name="${view.id}-scrubber" min="0" max="${view.scrubberAtSeq}" value="${view.scrubberAtSeq}" /></p>`;
  const replayDiff =
    view.replayDiffStatus === undefined
      ? ""
      : `<p>${escapeHtml(strings["Replay diff"] ?? "Replay diff")}: <strong>${escapeHtml(view.replayDiffStatus)}</strong></p>`;

  return [
    `<section aria-labelledby="${view.id}-heading" data-view="${view.id}" data-projection="${view.projectionSource}">`,
    `<h2 id="${view.id}-heading">${escapeHtml(heading)}</h2>`,
    `<p>${escapeHtml(projectionLabel)}</p>`,
    scrubber,
    replayDiff,
    `<pre aria-label="${escapeHtml(strings["Projection payload"] ?? "Projection payload")}">${escapeHtml(JSON.stringify(view.payload, null, 2))}</pre>`,
    `</section>`,
  ].join("\n");
}

export function renderDashboardHtml(
  dashboard: DashboardRenderResult,
  options: { readonly lang?: string; readonly dir?: "ltr" | "rtl"; readonly strings?: Record<string, string> } = {},
): DashboardHtmlDocument {
  const lang = options.lang ?? "en";
  const dir = options.dir ?? "ltr";
  const strings = options.strings ?? {};
  const skipLink = strings["Skip to dashboard content"] ?? "Skip to dashboard content";
  const mainTitle = strings["HoBo developer dashboard"] ?? "HoBo developer dashboard";
  const fixtureLabel = `${strings["Fixture"] ?? "Fixture"}: ${dashboard.fixture}`;

  const sections = dashboard.views.map((view) => renderViewSection(view, strings)).join("\n");
  const navItems = dashboard.views
    .map(
      (view) =>
        `<li><a href="#${view.id}-heading">${escapeHtml(strings[view.title] ?? view.title)}</a></li>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(mainTitle)}</title>
</head>
<body>
  <a class="skip-link" href="#dashboard-main">${escapeHtml(skipLink)}</a>
  <header>
    <h1 id="dashboard-title">${escapeHtml(mainTitle)}</h1>
    <p>${escapeHtml(fixtureLabel)}</p>
    <nav aria-label="${escapeHtml(strings["Dashboard views"] ?? "Dashboard views")}">
      <ul>${navItems}</ul>
    </nav>
  </header>
  <main id="dashboard-main" tabindex="-1">
    ${sections}
  </main>
</body>
</html>`;

  return Object.freeze({ lang, dir, title: mainTitle, html });
}
