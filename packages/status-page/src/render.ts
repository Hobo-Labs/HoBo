/**
 * Static status-page HTML renderer (HoBo Rubberhose, ADR-0149).
 *
 * Pure `render*` functions: model in, HTML string out — no IO, no clocks.
 * Every interpolated value passes through `escapeHtml`. The page ships a
 * strict inline CSP, day/night inversion with a `data-theme` toggle, film
 * grain, sticker-shadow cards, and flat status lamps (lamps are inert —
 * "pressable = raised" means only pressables get the sticker shadow).
 */
import { STATUS_PAGE_TOKENS } from "./tokens.js";
import type {
	ComponentStatusRecord,
	IncidentRecord,
	MaintenanceRecord,
	StatusPageModel,
} from "./types.js";

const {
	ink,
	paper,
	mute,
	cream,
	spark,
	go,
	faint,
	border,
	borderStrong,
	inset,
	codeBg,
	nightBg,
	nightRaised,
	nightSpark,
	nightGo,
} = STATUS_PAGE_TOKENS;

const GRAIN =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const STATUS_LABELS = {
	operational: "Operational",
	maintenance: "Maintenance",
	unknown: "Delayed / unknown",
	degraded: "Degraded",
	partial_outage: "Partial outage",
	major_outage: "Major outage",
};

function statusPageCss(): string {
	return `
:root{color-scheme:light;--ink:${ink};--paper:${paper};--cream:${cream};--mute:${mute};--faint:${faint};--spark:${spark};--go:${go};--border:${border};--border-strong:${borderStrong};--inset:${inset};--code-bg:${codeBg};--ease:cubic-bezier(.22,1,.36,1);--dur-tap:120ms;--dur-move:220ms}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{margin:0;background:var(--cream);color:var(--ink);font:1rem/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100%}
body{padding:1.5rem;max-width:64rem;margin:0 auto}
h1,h2,h3,button,.action{font-family:Chewy,"Arial Rounded MT Bold",system-ui,sans-serif;font-weight:400}
h1{margin:0 0 .35rem;font-size:2.25rem;line-height:1.1;letter-spacing:.01em;transform:rotate(-1deg);text-shadow:3px 3px 0 var(--border)}
h2{margin:0 0 .65rem;font-size:1.5rem;line-height:1.2}
p{margin:.35rem 0 .85rem}
a{color:var(--ink);text-underline-offset:3px}a:hover{color:var(--spark)}
code{font:0.875rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code-bg);padding:.1rem .35rem;border:2px solid var(--border-strong);border-radius:4px}
.eyebrow,.meta{color:var(--mute);letter-spacing:.06em;text-transform:uppercase;font-size:.75rem;font-weight:700}
header,section{background:var(--paper);border:3px solid var(--ink);border-radius:18px;box-shadow:4px 4px 0 var(--ink);padding:1.25rem 1.4rem;margin:0 0 1.25rem}
.chrome-bar{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
button,.action{display:inline-grid;place-items:center;min-height:2.75rem;padding:.7rem 1.15rem;border:3px solid var(--ink);border-radius:4px;background:var(--inset);color:var(--ink);box-shadow:4px 4px 0 var(--ink);font-size:1.1rem;line-height:1;letter-spacing:.03em;cursor:pointer}
button:hover,.action:hover{background:var(--spark);color:var(--paper)}
button:active,.action:active{transform:translate(3px,3px);box-shadow:1px 1px 0 var(--ink)}
button:focus-visible,a:focus-visible{outline:3px solid var(--spark);outline-offset:3px}
.banner{display:flex;align-items:center;gap:.85rem}
.banner .lamp{width:1.15rem;height:1.15rem;border:3px solid var(--ink);border-radius:999px;background:var(--go);flex:0 0 auto}
.banner[data-indicator="minor"] .lamp,.banner[data-indicator="major"] .lamp,.banner[data-indicator="critical"] .lamp{background:var(--spark)}
.banner[data-indicator="unknown"] .lamp,.banner[data-indicator="maintenance"] .lamp{background:var(--faint)}
.banner .headline{font-family:Chewy,"Arial Rounded MT Bold",system-ui,sans-serif;font-size:1.5rem;line-height:1.2}
.components{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.75rem}
.component{border:3px solid var(--ink);border-radius:12px;background:var(--inset);padding:.75rem .85rem;border-left:8px solid var(--faint)}
.component[data-state="operational"]{border-left-color:var(--go)}
.component[data-state="degraded"],.component[data-state="partial_outage"],.component[data-state="major_outage"]{border-left-color:var(--spark)}
.component[data-state="maintenance"],.component[data-state="unknown"]{border-left-color:var(--faint)}
.component .row{display:flex;align-items:baseline;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
.component .name{font-weight:700}
.component .state{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:800;color:var(--mute)}
.component[data-state="operational"] .state{color:var(--go)}
.component[data-state="degraded"] .state,.component[data-state="partial_outage"] .state,.component[data-state="major_outage"] .state{color:var(--spark)}
.uptime{display:flex;gap:2px;margin:.5rem 0 0;flex-wrap:wrap}
.uptime i{display:block;width:.5rem;height:1.35rem;border:2px solid var(--ink);border-radius:2px;background:var(--go)}
.uptime i[data-day="degraded"],.uptime i[data-day="partial_outage"],.uptime i[data-day="major_outage"]{background:var(--spark)}
.uptime i[data-day="unknown"],.uptime i[data-day="maintenance"]{background:var(--border-strong)}
.incident{border-top:3px solid var(--ink);padding-top:.85rem;margin-top:.85rem}
section>h2+.incident{border-top:0;padding-top:0;margin-top:0}
.incident .state{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:800;color:var(--spark)}
.incident[data-state="resolved"] .state{color:var(--go)}
.incident ol{list-style:none;margin:.5rem 0 0;padding:0}
.incident li{margin:.35rem 0;padding-left:.85rem;border-left:6px solid var(--border-strong)}
.empty{color:var(--mute);border:3px dashed var(--ink);border-radius:18px;padding:1.2rem;background:var(--paper)}
footer{color:var(--mute);font-size:.85rem;padding:0 .25rem 2rem}
body::after{content:"";position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:.06;mix-blend-mode:multiply;background-image:url("${GRAIN}");background-size:240px 240px}
@media (max-width: 32rem){body{padding:.75rem}h1{font-size:1.5rem}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-delay:0s!important;transition-duration:.01ms!important;transition-delay:0s!important;scroll-behavior:auto!important}h1{transform:none}button:active,.action:active{transform:none}body::after{opacity:0}}
html{color-scheme:light dark}
:root,:root[data-theme="light"]{color-scheme:light}
:root[data-theme="dark"]{--ink:${cream};--paper:${nightRaised};--cream:${nightBg};--mute:${borderStrong};--faint:${border};--spark:${nightSpark};--go:${nightGo};--border:${mute};--border-strong:${mute};--inset:${nightRaised};--code-bg:${nightRaised}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ink:${cream};--paper:${nightRaised};--cream:${nightBg};--mute:${borderStrong};--faint:${border};--spark:${nightSpark};--go:${nightGo};--border:${mute};--border-strong:${mute};--inset:${nightRaised};--code-bg:${nightRaised}}}
:root[data-theme="dark"] body::after{mix-blend-mode:screen;opacity:.08}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) body::after{mix-blend-mode:screen;opacity:.08}}
.theme-toggle{flex:0 0 auto}
.theme-toggle .sun{display:none}
.theme-toggle .moon{display:block}
:root[data-theme="dark"] .theme-toggle .sun{display:block}
:root[data-theme="dark"] .theme-toggle .moon{display:none}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .theme-toggle .sun{display:block}:root:not([data-theme="light"]) .theme-toggle .moon{display:none}}
`;
}

function themeBootScript(): string {
	return `(function(){try{var s=localStorage.getItem("hobo-theme");var t=s==="light"||s==="dark"?s:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
}

function themeToggleMarkup(): string {
	return `<button type="button" class="theme-toggle action" id="theme-toggle" aria-label="night" title="night" aria-pressed="false"><svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></button>`;
}

function themeToggleScript(): string {
	return `(function(){var root=document.documentElement;var btn=document.getElementById("theme-toggle");var media=matchMedia("(prefers-color-scheme: dark)");var sync=function(){var night=root.getAttribute("data-theme")==="dark";if(btn){btn.setAttribute("aria-pressed",String(night));btn.setAttribute("aria-label",night?"day":"night");btn.setAttribute("title",night?"day":"night");}};sync();btn&&btn.addEventListener("click",function(){var next=root.getAttribute("data-theme")==="dark"?"light":"dark";root.setAttribute("data-theme",next);try{localStorage.setItem("hobo-theme",next);}catch(e){}sync();});media.addEventListener("change",function(){try{if(localStorage.getItem("hobo-theme"))return;}catch(e){}root.setAttribute("data-theme",media.matches?"dark":"light");sync();});})();`;
}

function renderUptime(component: ComponentStatusRecord): string {
	if (component.history.length === 0) return "";
	const cells = component.history
		.map(
			(day) =>
				`<i data-day="${escapeHtml(day.worst)}" title="${escapeHtml(day.date)}: ${escapeHtml(STATUS_LABELS[day.worst])} (${day.samples} samples)"></i>`,
		)
		.join("");
	return `<div class="uptime" role="img" aria-label="${component.history.length}-day history for ${escapeHtml(component.spec.label)}">${cells}</div>`;
}

function renderComponent(component: ComponentStatusRecord): string {
	const attainment =
		component.attainment !== undefined
			? `<span class="meta">${escapeHtml((component.attainment * 100).toFixed(2))}%</span>`
			: "";
	return `<li class="component" data-state="${escapeHtml(component.status)}">
<div class="row"><span class="name">${escapeHtml(component.spec.label)}</span>${attainment}<span class="state">${escapeHtml(STATUS_LABELS[component.status])}</span></div>
${renderUptime(component)}
</li>`;
}

function renderIncident(incident: IncidentRecord): string {
	const updates = incident.updates
		.map(
			(update) =>
				`<li><span class="state">${escapeHtml(update.state)}</span> — ${escapeHtml(update.body)} <span class="meta">${escapeHtml(update.at)}</span></li>`,
		)
		.join("");
	return `<article class="incident" data-state="${escapeHtml(incident.state)}">
<h3>${escapeHtml(incident.title)}</h3>
<p><span class="state">${escapeHtml(incident.state)}</span> <span class="meta">impact ${escapeHtml(incident.impact)} · opened ${escapeHtml(incident.openedAt)}${incident.resolvedAt ? ` · resolved ${escapeHtml(incident.resolvedAt)}` : ""}</span></p>
${updates.length > 0 ? `<ol>${updates}</ol>` : ""}
</article>`;
}

function renderMaintenance(maintenance: MaintenanceRecord): string {
	return `<article class="incident" data-state="${escapeHtml(maintenance.state)}">
<h3>${escapeHtml(maintenance.title)}</h3>
<p><span class="meta">${escapeHtml(maintenance.state)} · ${escapeHtml(maintenance.windowStart)} → ${escapeHtml(maintenance.windowEnd)}</span></p>
<p>${escapeHtml(maintenance.expectedImpact)}</p>
</article>`;
}

/** Render one status page as a self-contained static HTML document. */
export function renderStatusPageHtml(model: StatusPageModel): string {
	const componentsMarkup =
		model.components.length > 0
			? `<ul class="components">${model.components.map(renderComponent).join("\n")}</ul>`
			: `<p class="empty">No components registered yet. Components appear when SLO measurements or incidents reference this scope.</p>`;
	const activeMarkup =
		model.activeIncidents.length > 0
			? model.activeIncidents.map(renderIncident).join("\n")
			: `<p class="empty">No active incidents.</p>`;
	const recentMarkup =
		model.recentIncidents.length > 0
			? model.recentIncidents.map(renderIncident).join("\n")
			: "";
	const maintenanceMarkup =
		model.maintenances.length > 0
			? model.maintenances.map(renderMaintenance).join("\n")
			: "";
	const delayedNote =
		model.freshness.staleComponentIds.length > 0
			? `<p class="meta">Delayed / unknown components have not reported inside the ${Math.round(model.freshness.budgetMs / 60000)}-minute freshness budget — never shown as stale operational.</p>`
			: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(model.scope.label)} — HoBo status</title>
<script>${themeBootScript()}</script>
<style>${statusPageCss()}</style>
</head>
<body>
<header>
<div class="chrome-bar">
<div>
<p class="eyebrow">HoBo status · ${escapeHtml(model.scope.kind)}</p>
<h1>${escapeHtml(model.scope.label)}</h1>
</div>
${themeToggleMarkup()}
</div>
<div class="banner" data-indicator="${escapeHtml(model.overall.indicator)}" role="status">
<span class="lamp" aria-hidden="true"></span>
<span class="headline">${escapeHtml(model.overall.description)}</span>
</div>
${delayedNote}
</header>
<section aria-labelledby="components-heading">
<h2 id="components-heading">Components</h2>
${componentsMarkup}
</section>
<section aria-labelledby="incidents-heading">
<h2 id="incidents-heading">Active incidents</h2>
${activeMarkup}
</section>
${maintenanceMarkup.length > 0 ? `<section aria-labelledby="maintenance-heading">\n<h2 id="maintenance-heading">Maintenance</h2>\n${maintenanceMarkup}\n</section>` : ""}
${recentMarkup.length > 0 ? `<section aria-labelledby="past-heading">\n<h2 id="past-heading">Past incidents</h2>\n${recentMarkup}\n</section>` : ""}
<footer>
<p>Generated ${escapeHtml(model.generatedAt)}${model.contentHash ? ` · <code>${escapeHtml(model.contentHash)}</code>` : ""} · schema <code>${escapeHtml(model.schema)}</code></p>
</footer>
<script>${themeToggleScript()}</script>
</body>
</html>
`;
}
