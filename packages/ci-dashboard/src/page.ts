/**
 * The dashboard page shell (HoBo Rubberhose, ADR-0149): chrome, navigation
 * for the five views, the sign-in form and an empty `<main>` the browser
 * client fills from the read API. The shell holds no account data, so it is
 * the same for every visitor.
 *
 * The page ships a strict CSP: scripts only from its own origin plus the
 * hashed theme boot line, requests only to its own origin (the relay's read
 * API), no frames, no forms posted anywhere.
 */
import { createHash } from "node:crypto";
import { DASHBOARD_TOKENS } from "./tokens.js";
import { DASHBOARD_VIEWS, VIEW_TITLES } from "./views.js";

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
} = DASHBOARD_TOKENS;

const GRAIN =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

const NIGHT = `--ink:${cream};--paper:${nightRaised};--cream:${nightBg};--mute:${borderStrong};--faint:${borderStrong};--border:${mute};--border-strong:${mute};--inset:${nightRaised};--code-bg:${nightRaised}`;

/** The page's stylesheet: DESIGN.md tokens only, sticker shadows on pressables only. */
export function dashboardCss(): string {
	return `
:root{color-scheme:light;--ink:${ink};--paper:${paper};--cream:${cream};--mute:${mute};--faint:${faint};--spark:${spark};--go:${go};--border:${border};--border-strong:${borderStrong};--inset:${inset};--code-bg:${codeBg};--ease:cubic-bezier(.22,1,.36,1);--dur-tap:120ms}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{margin:0;background:var(--cream);color:var(--ink);font:1rem/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100%}
body{padding:1.5rem;max-width:80rem;margin:0 auto}
h1,h2,h3,button,.action{font-family:Chewy,"Arial Rounded MT Bold",system-ui,sans-serif;font-weight:400}
h1{margin:0;font-size:2.25rem;line-height:1.1;letter-spacing:.01em;transform:rotate(-1deg);text-shadow:3px 3px 0 var(--border)}
h2{margin:0 0 .65rem;font-size:1.5rem;line-height:1.2}
h3{margin:0 0 .35rem;font-size:1.25rem;line-height:1.2}
p{margin:.35rem 0 .85rem}
a{color:var(--ink);text-underline-offset:3px}a:hover{color:var(--spark)}
code{font:.875rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code-bg);padding:.05rem .3rem;border:2px solid var(--border-strong);border-radius:4px;overflow-wrap:anywhere}
.note{color:var(--mute);font-size:.9rem;max-width:62ch}
.eyebrow,.meta,caption{color:var(--mute);letter-spacing:.06em;text-transform:uppercase;font-size:.75rem;font-weight:700}
header.chrome,section,.signin{background:var(--paper);border:3px solid var(--ink);border-radius:18px;box-shadow:4px 4px 0 var(--ink);padding:1.25rem 1.4rem;margin:0 0 1.25rem}
.chrome-bar{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
nav ul{list-style:none;margin:1rem 0 0;padding:0;display:flex;gap:.75rem;flex-wrap:wrap}
button,.action{display:inline-grid;place-items:center;min-height:2.75rem;padding:.6rem 1.05rem;border:3px solid var(--ink);border-radius:4px;background:var(--inset);color:var(--ink);box-shadow:4px 4px 0 var(--ink);font-size:1.1rem;line-height:1;letter-spacing:.03em;cursor:pointer;text-decoration:none}
button:hover,.action:hover{background:var(--spark);color:var(--paper)}
button:active,.action:active{transform:translate(3px,3px);box-shadow:1px 1px 0 var(--ink)}
.action[aria-current="page"]{background:var(--ink);color:var(--paper)}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--spark);outline-offset:3px}
main:focus{outline:none}
fieldset:disabled{opacity:.6}
label{font-weight:700}
input,select{font:inherit;color:var(--ink);background:var(--paper);border:3px solid var(--ink);border-radius:4px;padding:.45rem .6rem;min-height:2.75rem;width:100%}
input[type="checkbox"]{width:1.25rem;height:1.25rem;min-height:0;accent-color:var(--ink);margin:0 .4rem 0 0;vertical-align:middle}
.picker{display:flex;gap:.75rem;align-items:end;flex-wrap:wrap;margin-top:1rem}
.picker .field{flex:1 1 16rem;margin:0}
.field{display:grid;gap:.25rem;margin:0 0 .85rem}
.check{display:block;font-weight:400;margin:.35rem 0}
fieldset{border:3px solid var(--ink);border-radius:12px;padding:1rem;margin:0 0 1rem}
legend{font-family:Chewy,"Arial Rounded MT Bold",system-ui,sans-serif;font-size:1.25rem;padding:0 .4rem}
.what-if fieldset{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:0 1rem}
.what-if legend{grid-column:1/-1}
.what-if button{justify-self:start;margin-top:.5rem}
.table-wrap{overflow-x:auto;border:3px solid var(--ink);border-radius:12px;margin:0 0 1rem}
table{border-collapse:collapse;width:100%;font-size:.95rem}
caption{text-align:left;padding:.6rem .8rem 0}
th,td{text-align:left;vertical-align:top;padding:.5rem .8rem;border-bottom:2px solid var(--border)}
th{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
tbody tr:last-child td{border-bottom:0}
.lamp-text{display:inline-flex;align-items:center;gap:.45rem;font-weight:700}
.lamp{display:inline-block;width:.85rem;height:.85rem;border:2px solid var(--ink);border-radius:999px;background:var(--faint);flex:0 0 auto}
.lamp-text[data-state="go"] .lamp{background:var(--go)}
.lamp-text[data-state="spark"] .lamp{background:var(--spark)}
.lamp-text[data-state="faint"] .lamp{background:var(--faint)}
.attention,.skipped,.offenders,.signals,.decisions{margin:0;padding:0;list-style:none}
.attention li{border:3px solid var(--ink);border-left:8px solid var(--spark);border-radius:12px;background:var(--inset);padding:.6rem .85rem;margin:0 0 .6rem}
.skipped li{margin:.15rem 0;padding-left:.85rem;border-left:6px solid var(--border-strong)}
.decisions>li,.signals>li{border-top:3px solid var(--border);padding:.75rem 0}
.decisions>li:first-child,.signals>li:first-child{border-top:0;padding-top:0}
.signal[data-shown="false"]{padding:.4rem 0}.signal[data-shown="false"] p{margin:0}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0 0 1rem}
.facts dt{font-weight:700}.facts dd{margin:0}
.job{border-top:3px solid var(--ink);padding-top:.85rem;margin-top:.85rem}
.job:first-of-type{border-top:0;padding-top:0;margin-top:0}
.diagnosis{border:3px solid var(--ink);border-left:8px solid var(--spark);border-radius:12px;background:var(--inset);padding:.6rem .85rem;margin:0 0 .85rem}
.answer{border:3px solid var(--ink);border-radius:12px;background:var(--inset);padding:.75rem .85rem}
.problem{margin:0 0 1rem}
.badge{display:inline-block;border:2px solid var(--ink);border-radius:999px;padding:0 .5rem;font-size:.75rem;font-weight:700;background:var(--inset)}
.trend{list-style:none;margin:0;padding:.5rem 0 0;display:flex;gap:4px;align-items:flex-end;height:10rem;overflow-x:auto}
.trend li{flex:0 0 2.25rem;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
.trend .bar{display:block;width:100%;background:var(--ink);border:2px solid var(--ink);border-radius:2px 2px 0 0}
.trend .day{font-size:.65rem;color:var(--mute)}
.empty{color:var(--mute);border:3px dashed var(--ink);border-radius:18px;padding:1rem;background:var(--paper);margin:0 0 1rem}
.status{color:var(--mute);margin:0 0 1rem}
.status[data-state="error"]{color:var(--ink);border:3px solid var(--ink);border-left:8px solid var(--spark);border-radius:12px;background:var(--paper);padding:.75rem 1rem}
footer{color:var(--mute);font-size:.85rem;padding:0 .25rem 2rem}
body::after{content:"";position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:.06;mix-blend-mode:multiply;background-image:url("${GRAIN}");background-size:240px 240px}
@media (max-width: 40rem){body{padding:.75rem}h1{font-size:1.6rem}header.chrome,section,.signin{padding:1rem}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}h1{transform:none}button:active,.action:active{transform:none}body::after{opacity:0}}
html{color-scheme:light dark}
:root,:root[data-theme="light"]{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark;${NIGHT}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${NIGHT}}}
:root[data-theme="dark"] body::after{mix-blend-mode:screen;opacity:.08}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) body::after{mix-blend-mode:screen;opacity:.08}}
`;
}

/** Sets `data-theme` before first paint: the visitor's stored choice, else the system's. */
// public-contract: the one inline script the page's CSP allows, by its hash.
export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem("hobo-theme");var t=s==="light"||s==="dark"?s:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

function scriptHash(script: string): string {
	return `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
}

/** The page's Content-Security-Policy. */
export function dashboardCsp(): string {
	return `default-src 'none'; script-src 'self' ${scriptHash(THEME_BOOT_SCRIPT)}; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

export type DashboardPageOptions = Readonly<{
	/** Where the page is served, e.g. `/dashboard`; the client script is `<basePath>/app.js`. */
	basePath: string;
}>;

/** The dashboard's HTML document. */
export function renderDashboardPage(options: DashboardPageOptions): string {
	const nav = DASHBOARD_VIEWS.map(
		(view) =>
			`<li><a class="action" href="#/${view}" data-view="${view}">${VIEW_TITLES.get(view) ?? view}</a></li>`,
	).join("");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>HoBo CI dashboard</title>
<script>${THEME_BOOT_SCRIPT}</script>
<style>${dashboardCss()}</style>
</head>
<body>
<header class="chrome">
<div class="chrome-bar">
<div>
<p class="eyebrow">HoBo CI relay · read-only</p>
<h1>Dashboard</h1>
</div>
<button type="button" class="theme-toggle" id="theme-toggle" aria-pressed="false">Night</button>
</div>
<nav aria-label="Views"><ul>${nav}</ul></nav>
<form class="picker" id="picker" novalidate>
<div class="field"><label for="repository">Repository</label><input id="repository" name="repository" list="repositories" placeholder="every connected repository" autocomplete="off" spellcheck="false"><datalist id="repositories"></datalist></div>
<button type="submit">Show</button>
</form>
</header>
<form class="signin" id="signin" hidden novalidate>
<h2>Sign in</h2>
<p>The dashboard reads this relay's read API with an account token that holds the <code>policy:read</code> scope. The token stays in this tab and is sent only to this relay.</p>
<div class="field"><label for="token">Account token</label><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required></div>
<button type="submit">Open the dashboard</button>
</form>
<p class="status" id="status" role="status" aria-live="polite"></p>
<main id="view" tabindex="-1" aria-live="off"></main>
<footer><p>Read-only: this page sends only <code>GET</code> requests to the relay's read API. Routing changes are commits to <code>.hobo/ci.json</code>, made through a pull request.</p></footer>
<script src="${options.basePath}/app.js" defer></script>
</body>
</html>
`;
}
