/**
 * The secret-capture form, one page for both channels:
 *
 * - `mcp-app`: the `ui://hobo/secret-capture` resource an MCP Apps host
 *   renders in its sandboxed iframe. It learns its ticket from the
 *   `ui/notifications/tool-result` of `capture_secret`, seals the value with
 *   Web Crypto, and calls the app-only `submit_secret_value` tool through the
 *   host (`tools/call` over `postMessage`). It never sends
 *   `ui/message` or `ui/update-model-context`, so nothing it holds is put in
 *   front of the model.
 * - `loopback`: the page the MCP server itself serves on 127.0.0.1 when the
 *   host has no MCP Apps support. Its ticket is embedded; its one-time token
 *   is the URL fragment; it POSTs the sealed value to its own origin.
 *
 * Visual contract: `packages/mcp/DESIGN.md` (HoBo Rubberhose tokens from
 * `site/DESIGN.md`): ink on paper, paper on ink at night, thick ink rules, a
 * sticker shadow on the one pressable, spark only for focus and the error
 * rule, go only for the stored rule. No external fonts, images or scripts.
 */

import { SECRET_CAPTURE_SEAL_SOURCE } from "./seal.js";

/** The hex values this surface may use; the design-lint test holds it to them. */
export const SECRET_CAPTURE_TOKEN_VALUES: ReadonlySet<string> = new Set([
	"#ffffff",
	"#101010",
	"#4a4a46",
	"#6e6d68",
	"#c9c8c2",
	"#f4f4f2",
	"#f7f7f5",
	"#c5301c",
	"#14672c",
	"#0a0a0a",
	"#111111",
	"#f2f1ec",
]);

/** What the loopback page embeds about its ticket. No value, no token. */
export type SecretCapturePageTicket = Readonly<{
	ticketId: string;
	name: string;
	label: string;
	purpose: string;
	charset: string;
	maxBytes: number;
	expiresAt: string;
	key: Readonly<{ kty: string; crv: string; x: string; y: string }>;
}>;

export type SecretCapturePageOptions =
	| Readonly<{ mode: "mcp-app" }>
	| Readonly<{
			mode: "loopback";
			/** The CSP nonce for this response's one style and two scripts. */
			nonce: string;
			ticket: SecretCapturePageTicket;
	  }>;

/** JSON for a `<script type="application/json">`: nothing in it can end the element. */
type PageConfig = Readonly<{
	mode: "mcp-app" | "loopback";
	ticket?: SecretCapturePageTicket;
}>;

function embedJson(value: PageConfig): string {
	return JSON.stringify(value)
		.replace(/</gu, "\\u003c")
		.replace(/>/gu, "\\u003e")
		.replace(/&/gu, "\\u0026")
		.replace(/\u2028/gu, "\\u2028")
		.replace(/\u2029/gu, "\\u2029");
}

const STYLE = `
:root {
  --paper: #ffffff;
  --ink: #101010;
  --mute: #4a4a46;
  --faint: #6e6d68;
  --rule: #c9c8c2;
  --inset: #f4f4f2;
  --code-bg: #f7f7f5;
  --spark: #c5301c;
  --go: #14672c;
  --dur-tap: 120ms;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --paper: #0a0a0a;
  --ink: #f2f1ec;
  --mute: #f2f1ec;
  --faint: #c9c8c2;
  --rule: #4a4a46;
  --inset: #111111;
  --code-bg: #111111;
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0a0a0a;
    --ink: #f2f1ec;
    --mute: #f2f1ec;
    --faint: #c9c8c2;
    --rule: #4a4a46;
    --inset: #111111;
    --code-bg: #111111;
    color-scheme: dark;
  }
}
[hidden] { display: none !important; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--paper); color: var(--ink); }
body {
  font: 400 1rem/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 16px;
}
.card {
  max-width: 560px;
  margin: 0 auto;
  padding: 24px;
  background: var(--paper);
  border: 3px solid var(--ink);
  border-radius: 18px;
}
.caption {
  margin: 0 0 8px;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}
h1 {
  margin: 0 0 8px;
  font: 400 1.5rem/1.2 Chewy, system-ui, sans-serif;
  letter-spacing: 0.01em;
}
.purpose, .note { margin: 0 0 16px; color: var(--mute); }
.note { font-size: 0.875rem; }
code {
  font: 400 0.875rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0 4px;
}
label { display: block; margin: 0 0 8px; font-weight: 700; }
input, textarea {
  display: block;
  width: 100%;
  margin: 0 0 8px;
  padding: 8px;
  font: 400 0.875rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink);
  background: var(--inset);
  border: 2px solid var(--ink);
  border-radius: 4px;
}
textarea { resize: vertical; min-height: 8rem; }
input:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: 3px solid var(--spark);
  outline-offset: 2px;
}
button {
  font: 400 1.25rem/1.2 Chewy, system-ui, sans-serif;
  color: var(--paper);
  background: var(--ink);
  border: 3px solid var(--ink);
  border-radius: 4px;
  padding: 8px 24px;
  box-shadow: 4px 4px 0 var(--rule);
  cursor: pointer;
  transition: transform var(--dur-tap) var(--ease), box-shadow var(--dur-tap) var(--ease);
}
button:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--rule); }
button:disabled { cursor: progress; opacity: 0.6; }
.error, .done {
  margin: 0 0 16px;
  padding: 8px 16px;
  border-left: 4px solid var(--spark);
  background: var(--inset);
}
.done { border-left-color: var(--go); margin: 16px 0 0; }
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
  button:active { transform: none; }
}
`;

/** The page's behaviour; `MODE` is replaced per channel. */
const SCRIPT = `(function () {
  "use strict";
  ${SECRET_CAPTURE_SEAL_SOURCE}
  var config = JSON.parse(document.getElementById("hobo-capture-config").textContent);
  function el(id) { return document.getElementById(id); }
  var form = el("capture-form");
  var line = el("capture-line");
  var multi = el("capture-multi");
  var submit = el("capture-submit");
  var error = el("capture-error");
  var done = el("capture-done");
  var ticket = null;
  var busy = false;

  function field() { return ticket && ticket.charset === "printable-multiline" ? multi : line; }
  function clearFields() { line.value = ""; multi.value = ""; }
  function say(text) { error.textContent = text; error.hidden = !text; }
  function finish(answer) {
    clearFields();
    form.hidden = true;
    done.textContent = (answer.status === "authorized" ? "Writes authorized for this session (" : "Stored in the secret store as ") + answer.ref + (answer.status === "authorized" ? "). " : ". ") + "You can close this.";
    done.hidden = false;
    resize();
  }
  function show(next) {
    ticket = next;
    el("capture-label").textContent = next.label || next.name;
    el("capture-purpose").textContent = next.purpose || "";
    el("capture-name").textContent = next.name;
    el("capture-waiting").hidden = true;
    if (next.state === "stored" || next.state === "authorized") { finish({ status: next.state, ref: next.ref }); return; }
    var multiline = next.charset === "printable-multiline";
    multi.hidden = !multiline;
    line.hidden = multiline;
    field().maxLength = next.maxBytes || 32768;
    el("capture-field-label").htmlFor = field().id;
    form.hidden = false;
    field().focus();
    resize();
  }
  function resize() {
    if (config.mode !== "mcp-app") return;
    notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.scrollHeight) });
  }
  function theme(context) {
    if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.setAttribute("data-theme", context.theme);
  }

  var nextId = 1;
  var pending = {};
  function post(message) { window.parent.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params }); }

  function send(sealed) {
    if (config.mode === "loopback") {
      return fetch(window.location.pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: window.location.hash.slice(1), sealed: sealed }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer"
      }).then(function (response) { return response.json(); });
    }
    return request("tools/call", { name: "submit_secret_value", arguments: { ticketId: ticket.ticketId, sealed: sealed } })
      .then(function (result) { return (result && result.structuredContent) || {}; });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (busy || !ticket) return;
    var subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) {
      say("This window cannot encrypt, so nothing was sent. Ask the agent for the local page instead.");
      return;
    }
    var value = field().value;
    clearFields();
    if (!value) { say("Enter the value first."); return; }
    busy = true;
    submit.disabled = true;
    say("");
    hoboSeal(subtle, ticket.key, value, ticket.ticketId, ticket.ticketId + ":" + ticket.name)
      .then(function (sealed) {
        value = "";
        sealed.ticketId = ticket.ticketId;
        return send(sealed);
      })
      .then(function (answer) {
        if (answer && (answer.status === "stored" || answer.status === "authorized")) finish(answer);
        else say((answer && answer.message) || "Not stored.");
      }, function () { say("Not stored: the request did not complete. Try again."); })
      .then(function () { busy = false; submit.disabled = false; resize(); });
  });

  if (config.mode === "loopback") {
    show(config.ticket);
    return;
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined) {
      var waiter = pending[message.id];
      if (!waiter) return;
      delete pending[message.id];
      if (message.error) waiter.reject(new Error("request failed"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      var content = message.params && message.params.structuredContent;
      if (content && content.ticketId && content.key) show(content);
      else if (content && content.message) say(content.message);
      return;
    }
    if (message.method === "ui/notifications/host-context-changed") { theme(message.params); return; }
    if (message.id !== undefined && (message.method === "ui/resource-teardown" || message.method === "ping")) {
      clearFields();
      post({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  });
  request("ui/initialize", {
    appInfo: { name: "hobo-secret-capture", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(function (result) {
    theme(result && result.hostContext);
    notify("ui/notifications/initialized", {});
    resize();
  }, function () { say("This host did not start the form."); });
})();`;

export function renderSecretCaptureHtml(
	options: SecretCapturePageOptions,
): string {
	const nonce = options.mode === "loopback" ? ` nonce="${options.nonce}"` : "";
	const config: PageConfig =
		options.mode === "loopback"
			? { mode: "loopback", ticket: options.ticket }
			: { mode: "mcp-app" };
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>HoBo: add a secret to the secret store</title>
<style${nonce}>${STYLE}</style>
</head>
<body>
<main class="card" aria-labelledby="capture-title">
<p class="caption">HoBo deploy · secret store</p>
<h1 id="capture-title">Add <span id="capture-label">a secret</span></h1>
<p id="capture-purpose" class="purpose"></p>
<p id="capture-waiting" class="note">Waiting for the agent's request.</p>
<form id="capture-form" hidden novalidate autocomplete="off">
<label id="capture-field-label" for="capture-line">Value of <code id="capture-name"></code></label>
<input id="capture-line" name="capture-line" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="capture-help capture-error">
<textarea id="capture-multi" name="capture-multi" rows="8" hidden autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="capture-help capture-error"></textarea>
<p id="capture-help" class="note">It is encrypted in this window and written straight to the secret store. The agent never sees it, and it is not shown here again.</p>
<p id="capture-error" class="error" role="alert" hidden></p>
<button id="capture-submit" type="submit">Store it</button>
</form>
<p id="capture-done" class="done" role="status" aria-live="polite" hidden></p>
</main>
<script type="application/json" id="hobo-capture-config">${embedJson(config)}</script>
<script${nonce}>${SCRIPT}</script>
</body>
</html>
`;
}
