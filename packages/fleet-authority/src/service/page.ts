/**
 * The approval page (§6.5, §6.15): every field of `ApprovalView`, so the
 * person sees who signed in, the host, device and platform, the four
 * fingerprint words of the sign-in key, whether this is a device-code
 * sign-in, and when the request expires, then confirms or declines. Plain
 * server-rendered HTML with no script, every value escaped.
 */
import type { ApprovalView, FleetFailure } from "@hobo/fleet";

const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
} as const;
type Escaped = keyof typeof ESCAPES;

function isEscaped(character: string): character is Escaped {
	return Object.hasOwn(ESCAPES, character);
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/gu, (character) =>
		isEscaped(character) ? ESCAPES[character] : character,
	);
}

const STYLE = `
:root { color-scheme: light dark; --ink: #111; --paper: #fdfbf6; --go: #1f7a3a; }
@media (prefers-color-scheme: dark) { :root { --ink: #f4f1ea; --paper: #141414; } }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 34rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; border: 3px solid var(--ink); padding: 1rem; box-shadow: 4px 4px 0 var(--ink); }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.words { font: 600 1.2rem ui-monospace, monospace; letter-spacing: .05em; }
form { display: flex; gap: 1rem; margin-top: 1.5rem; }
button { font: inherit; padding: .5rem 1.25rem; border: 3px solid var(--ink); background: var(--paper); color: var(--ink); cursor: pointer; }
button[value="true"] { background: var(--go); color: #fff; }
`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** The page for `GET /v1/fleet/approve/{state}`. */
export function approvalPage(view: ApprovalView): string {
	const platform =
		view.platform === undefined
			? "unknown"
			: `${view.platform.os} / ${view.platform.arch}`;
	const rows: readonly (readonly [string, string, string])[] = [
		["Signed in as", "principal", view.principal],
		["Host", "host_name", view.hostName],
		["Device", "device_name", view.deviceName],
		["Platform", "platform", platform],
		["Key fingerprint", "fingerprint_words", view.fingerprintWords.join(" ")],
		[
			"Sign-in kind",
			"device_flow",
			view.deviceFlow ? "device code (typed on another screen)" : "browser",
		],
		["Expires", "expires_at", view.expiresAt],
		["Request", "state", view.state],
	];
	const list = rows
		.map(
			([label, name, value]) =>
				`<dt>${escapeHtml(label)}</dt><dd data-field="${name}"${name === "fingerprint_words" ? ' class="words"' : ""}>${escapeHtml(value)}</dd>`,
		)
		.join("\n");
	return page(
		"Approve this sign-in",
		`<h1>Approve this sign-in?</h1>
<p>Approve only if you started this sign-in and the fingerprint words match the ones your terminal shows.</p>
<dl>
${list}
</dl>
<form method="post" action="/v1/fleet/approve/${encodeURIComponent(view.state)}">
<input type="hidden" name="state" value="${escapeHtml(view.state)}">
<button type="submit" name="approve" value="true">Approve</button>
<button type="submit" name="approve" value="false">Decline</button>
</form>`,
	);
}

/** After a device-code approval: nothing to redirect to. */
export function donePage(approved: boolean): string {
	return page(
		approved ? "Sign-in approved" : "Sign-in declined",
		`<h1>${approved ? "Sign-in approved" : "Sign-in declined"}</h1><p>You can close this page and return to your terminal.</p>`,
	);
}

export function errorPage(status: number, failure: FleetFailure): string {
	return page(
		"Sign-in failed",
		`<h1>Sign-in failed</h1><p>${escapeHtml(failure.message)}</p><p><code>${status} ${escapeHtml(failure.code)}</code></p>`,
	);
}
