import { createHash, timingSafeEqual } from "node:crypto";
import {
	type EphemeralStatePort,
	type JsonValue,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import { z } from "zod";
import { ownerHandoffSealing } from "./owner-handoff-seal.js";

export {
	type OwnerHandoffEnvelopeWire,
	type OwnerHandoffOfferWire,
	ownerHandoffSealing,
} from "./owner-handoff-seal.js";

// public-contract: the page a HoBo owner link opens; HoBo's MCP server names it in the link.
export const OWNER_HANDOFF_PAGE_PATH = "/owner-handoff";
// public-contract: the mailbox routes HoBo's MCP server and the page call (contracts/owner-handoff-relay.pact.json).
export const OWNER_HANDOFF_API_PREFIX = "/v1/owner-handoff/mailboxes";
export const OWNER_HANDOFF_MAX_TTL_MS = 15 * 60_000;
export const OWNER_HANDOFF_MAX_BODY_BYTES = 32 * 1024;
export const OWNER_HANDOFF_REGISTRATIONS_PER_MINUTE = 600;

const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const publicKey = z.string().regex(/^B[A-P][A-Za-z0-9_-]{85}$/u);

const OfferWire = z
	.object({
		mailboxId: digest,
		recipientKey: publicKey,
		binding: digest,
		expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		keyProof: digest,
	})
	.strict();
const RegistrationWire = z
	.object({ offer: OfferWire, collectDigest: digest })
	.strict();
const EnvelopeWire = z
	.object({
		senderKey: publicKey,
		iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
		ciphertext: z
			.string()
			.min(22)
			.max(21_846)
			.regex(/^[A-Za-z0-9_-]+$/u),
	})
	.strict();
const StoredMailbox = z
	.object({
		offer: OfferWire,
		collectDigest: digest,
		state: z.enum(["open", "sealed", "collected"]),
	})
	.strict();

export type OwnerHandoffOffer = z.infer<typeof OfferWire>;
export type OwnerHandoffEnvelope = z.infer<typeof EnvelopeWire>;

const noStore = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

function json(status: number, body: JsonValue): Response {
	return Response.json(body, { status, headers: noStore });
}

const JsonText = z.string().transform((text, context) => {
	try {
		return z.json().parse(JSON.parse(text));
	} catch {
		context.addIssue({ code: "custom", message: "not JSON" });
		return z.NEVER;
	}
});

function parseJsonText(text: string) {
	const parsed = JsonText.safeParse(text);
	return parsed.success ? parsed.data : undefined;
}

async function boundedJson(request: Request) {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > OWNER_HANDOFF_MAX_BODY_BYTES) return undefined;
	const text = await request.text();
	if (text.length > OWNER_HANDOFF_MAX_BODY_BYTES) return undefined;
	return parseJsonText(text);
}

function sha256(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function bearer(request: Request): string | undefined {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header);
	return match?.[1];
}

export function isOwnerHandoffPath(pathname: string): boolean {
	return (
		pathname === OWNER_HANDOFF_PAGE_PATH ||
		pathname.startsWith(`${OWNER_HANDOFF_API_PREFIX}`)
	);
}

export function createOwnerHandoffMailbox(options: {
	readonly state: EphemeralStatePort;
	readonly environment: string;
	readonly now?: () => number;
}): (request: Request) => Promise<Response> {
	const now = options.now ?? Date.now;
	const keyOf = (mailboxId: string, part: "offer" | "envelope") =>
		parseEphemeralKey(
			`hobo-ci:${options.environment}:owner-handoff:${mailboxId}:${part}`,
		);
	const ttlUntil = (expiresAtMs: number) =>
		parseEphemeralTtlMs(Math.max(1, Math.ceil(expiresAtMs - now())));

	const readMailbox = async (mailboxId: string) => {
		const entry = await options.state.get(keyOf(mailboxId, "offer"));
		if (entry === undefined) return undefined;
		const parsed = StoredMailbox.safeParse(parseJsonText(entry.value));
		if (!parsed.success || parsed.data.offer.expiresAtMs <= now())
			return undefined;
		return { mailbox: parsed.data, version: entry.version };
	};

	const register = async (request: Request) => {
		const parsed = RegistrationWire.safeParse(await boundedJson(request));
		if (!parsed.success) return json(400, { error: "invalid-registration" });
		const { offer, collectDigest } = parsed.data;
		const remaining = offer.expiresAtMs - now();
		if (remaining <= 0 || remaining > OWNER_HANDOFF_MAX_TTL_MS)
			return json(400, { error: "invalid-expiry" });
		const minute = Math.floor(now() / 60_000);
		const count = await options.state.increment(
			parseEphemeralKey(
				`hobo-ci:${options.environment}:owner-handoff-rate:${minute}`,
			),
			1,
			parseEphemeralTtlMs(120_000),
			"on-create",
		);
		if (count > OWNER_HANDOFF_REGISTRATIONS_PER_MINUTE)
			return json(429, { error: "busy" });
		const written = await options.state.putIfAbsent(
			keyOf(offer.mailboxId, "offer"),
			JSON.stringify({ offer, collectDigest, state: "open" }),
			ttlUntil(offer.expiresAtMs),
		);
		return written.applied
			? json(201, { mailboxId: offer.mailboxId })
			: json(409, { error: "exists" });
	};

	const show = async (mailboxId: string) => {
		const held = await readMailbox(mailboxId);
		if (held === undefined) return json(404, { error: "not-found" });
		if (held.mailbox.state !== "open") return json(410, { error: "used" });
		return json(200, held.mailbox.offer);
	};

	const deposit = async (mailboxId: string, request: Request) => {
		const parsed = EnvelopeWire.safeParse(await boundedJson(request));
		if (!parsed.success) return json(400, { error: "invalid-envelope" });
		const held = await readMailbox(mailboxId);
		if (held === undefined) return json(404, { error: "not-found" });
		if (held.mailbox.state !== "open") return json(410, { error: "used" });
		const ttl = ttlUntil(held.mailbox.offer.expiresAtMs);
		const sealed = await options.state.compareAndSet(
			keyOf(mailboxId, "offer"),
			held.version,
			JSON.stringify({ ...held.mailbox, state: "sealed" }),
			ttl,
		);
		if (!sealed.applied) return json(410, { error: "used" });
		const written = await options.state.putIfAbsent(
			keyOf(mailboxId, "envelope"),
			JSON.stringify(parsed.data),
			ttl,
		);
		return written.applied
			? new Response(null, { status: 204, headers: noStore })
			: json(410, { error: "used" });
	};

	const collect = async (mailboxId: string, request: Request) => {
		const token = bearer(request);
		const held = await readMailbox(mailboxId);
		if (token === undefined || held === undefined)
			return json(404, { error: "not-found" });
		const expected = Buffer.from(held.mailbox.collectDigest, "base64url");
		const presented = sha256(token);
		if (
			expected.length !== presented.length ||
			!timingSafeEqual(expected, presented)
		)
			return json(404, { error: "not-found" });
		if (held.mailbox.state === "open")
			return json(202, {
				state: "waiting",
				expiresAtMs: held.mailbox.offer.expiresAtMs,
			});
		if (held.mailbox.state === "collected") return json(410, { error: "used" });
		const envelope = await options.state.get(keyOf(mailboxId, "envelope"));
		const collected = await options.state.compareAndSet(
			keyOf(mailboxId, "offer"),
			held.version,
			JSON.stringify({ ...held.mailbox, state: "collected" }),
			ttlUntil(held.mailbox.offer.expiresAtMs),
		);
		if (envelope === undefined || !collected.applied)
			return json(410, { error: "used" });
		await options.state.delete(keyOf(mailboxId, "envelope"));
		const parsed = EnvelopeWire.safeParse(parseJsonText(envelope.value));
		return parsed.success
			? json(200, { envelope: parsed.data })
			: json(410, { error: "used" });
	};

	return async (request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname === OWNER_HANDOFF_PAGE_PATH)
			return request.method === "GET" || request.method === "HEAD"
				? ownerHandoffPage()
				: json(405, { error: "method" });
		if (pathname === OWNER_HANDOFF_API_PREFIX)
			return request.method === "POST"
				? register(request)
				: json(405, { error: "method" });
		const match = new RegExp(
			`^${OWNER_HANDOFF_API_PREFIX}/([A-Za-z0-9_-]{43})(/envelope|/collect)?$`,
			"u",
		).exec(pathname);
		const mailboxId = match?.[1];
		if (mailboxId === undefined) return json(404, { error: "not-found" });
		const action = match?.[2];
		if (action === undefined && request.method === "GET")
			return show(mailboxId);
		if (action === "/envelope" && request.method === "PUT")
			return deposit(mailboxId, request);
		if (action === "/collect" && request.method === "POST")
			return collect(mailboxId, request);
		return json(405, { error: "method" });
	};
}

const PAGE_STYLE = `:root{color-scheme:light dark;--ink:#16181d;--muted:#555b66;--paper:#ffffff;--panel:#f4f5f7;--line:#c9ccd3;--accent:#1d4ed8;--accent-ink:#ffffff;--bad:#b42318;--good:#067647}
@media (prefers-color-scheme:dark){:root{--ink:#eceef2;--muted:#a6acb8;--paper:#111318;--panel:#1a1d24;--line:#3a3f4b;--accent:#8fb3ff;--accent-ink:#0b1020;--bad:#ff8a7a;--good:#6ce0a4}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.35rem;margin:0 0 4px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.9rem}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:16px 0;background:var(--panel)}legend{font-weight:600;padding:0 4px}
.store{display:flex;gap:10px;align-items:center;padding:8px 0}label{display:block;font-weight:600;margin:12px 0 4px}
input[type=text],input[type=password],input[type=email],textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font:inherit}
textarea{min-height:5rem;font-family:ui-monospace,monospace;font-size:.85rem}a{color:var(--accent)}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:progress}#say{margin-top:16px;min-height:1.5em;font-weight:600}#say[data-tone=bad]{color:var(--bad)}#say[data-tone=good]{color:var(--good)}[hidden]{display:none!important}`;

const PAGE_BODY = `<main>
<h1>Connect your secret store to HoBo</h1>
<p class="muted">What you enter here is encrypted in this browser for your HoBo session alone. The relay that serves this page and your agent never see it. This link works once.</p>
<form id="form" hidden>
<fieldset><legend>Secret store</legend>
<label class="store"><input type="radio" name="store" value="infisical" required> Infisical</label>
<label class="store"><input type="radio" name="store" value="1password"> 1Password</label>
<label class="store"><input type="radio" name="store" value="bitwarden"> Bitwarden</label>
</fieldset>
<fieldset data-store="infisical" hidden><legend>Infisical</legend>
<label for="INFISICAL_PROJECT_ID">Project ID</label><input type="text" id="INFISICAL_PROJECT_ID" name="INFISICAL_PROJECT_ID" autocomplete="off" data-required>
<p class="muted"><a id="infisical-sign-in" target="_blank" rel="noopener noreferrer">Sign in to Infisical</a>. When it says Unable to reach CLI, click Copy to clipboard and paste it here.</p>
<label for="INFISICAL_CLI_SESSION">Infisical session</label><textarea id="INFISICAL_CLI_SESSION" name="INFISICAL_CLI_SESSION" autocomplete="off" spellcheck="false" data-required></textarea>
</fieldset>
<fieldset data-store="1password" hidden><legend>1Password</legend>
<label for="OP_VAULT_ID">Vault ID</label><input type="text" id="OP_VAULT_ID" name="OP_VAULT_ID" autocomplete="off" data-required>
<label for="OP_CONNECT_HOST">Connect server (optional, https)</label><input type="text" id="OP_CONNECT_HOST" name="OP_CONNECT_HOST" autocomplete="off">
<div id="op-sign-in">
<label for="ONEPASSWORD_EMAIL">Email</label><input type="email" id="ONEPASSWORD_EMAIL" name="ONEPASSWORD_EMAIL" autocomplete="off">
<label for="ONEPASSWORD_SECRET_KEY">Secret Key (A3-…)</label><input type="password" id="ONEPASSWORD_SECRET_KEY" name="ONEPASSWORD_SECRET_KEY" autocomplete="off">
<label for="ONEPASSWORD_PASSWORD">Password</label><input type="password" id="ONEPASSWORD_PASSWORD" name="ONEPASSWORD_PASSWORD" autocomplete="off">
<p class="muted">Used once to create HoBo's own service account for the vault; never stored.</p>
</div>
</fieldset>
<fieldset data-store="bitwarden" hidden><legend>Bitwarden</legend>
<label for="BITWARDEN_SERVER_URL">Self-hosted server (optional, https)</label><input type="text" id="BITWARDEN_SERVER_URL" name="BITWARDEN_SERVER_URL" autocomplete="off">
<p class="muted">Your personal API key: Account settings, Security, Keys, View API key.</p>
<label for="BW_CLIENTID">client_id</label><input type="text" id="BW_CLIENTID" name="BW_CLIENTID" autocomplete="off">
<label for="BW_CLIENTSECRET">client_secret</label><input type="password" id="BW_CLIENTSECRET" name="BW_CLIENTSECRET" autocomplete="off">
</fieldset>
<button type="submit" id="send">Send to HoBo</button>
</form>
<div id="say" role="status" aria-live="polite">Checking this link…</div>
</main>`;

const PAGE_LOGIC = `(function(){
var say=document.getElementById("say"),form=document.getElementById("form"),send=document.getElementById("send");
function tell(text,tone){say.textContent=text;if(tone)say.setAttribute("data-tone",tone);else say.removeAttribute("data-tone")}
var ticket=location.hash.slice(1);history.replaceState(null,"",location.pathname);
var api=${JSON.stringify(OWNER_HANDOFF_API_PREFIX)},offer,mailbox;
document.getElementById("infisical-sign-in").href="https://app.infisical.com/login?callback_port="+(20000+Math.floor(Math.random()*40000));
function chosen(){var c=form.querySelector("input[name=store]:checked");return c?c.value:""}
function sync(){var s=chosen();Array.prototype.forEach.call(form.querySelectorAll("[data-store]"),function(f){f.hidden=f.getAttribute("data-store")!==s});
document.getElementById("op-sign-in").hidden=document.getElementById("OP_CONNECT_HOST").value.trim()!==""}
form.addEventListener("input",sync);form.addEventListener("change",sync);
function gone(){form.hidden=true;tell("This link has expired or was already used. Ask your agent to call choose_secret_store again for a new one.","bad")}
sealing.mailboxOf(ticket).then(function(id){mailbox=id;return fetch(api+"/"+id,{cache:"no-store"})}).then(function(r){
if(r.status!==200){gone();return}return r.json().then(function(o){return sealing.verifyOffer(ticket,o).then(function(ok){
if(!ok||o.expiresAtMs<=Date.now()){form.hidden=true;tell("This link could not be verified. Ask your agent for a new one.","bad");return}
offer=o;form.hidden=false;sync();tell("")})})}).catch(function(){form.hidden=true;tell("This link is not valid. Ask your agent for a new one.","bad")});
form.addEventListener("submit",function(e){e.preventDefault();var s=chosen();if(!offer||!s)return;
var answer={store:s},missing=false;
Array.prototype.forEach.call(form.querySelectorAll("[data-store='"+s+"'] input[name],[data-store='"+s+"'] textarea[name]"),function(el){
if(el.closest("[hidden]"))return;var v=el.value.trim();if(v)answer[el.name]=v;else if(el.hasAttribute("data-required"))missing=true});
if(missing){tell("Fill in the required fields for "+s+".","bad");return}
send.disabled=true;tell("Encrypting and sending…");
sealing.seal(ticket,offer,answer).then(function(env){return fetch(api+"/"+mailbox+"/envelope",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(env),cache:"no-store"})})
.then(function(r){if(r.status===204){form.reset();form.hidden=true;offer=undefined;tell("Sent to your HoBo session. Return to your agent; it connects the store on its next step.","good")}
else if(r.status===410||r.status===404){gone()}else{send.disabled=false;tell("Not sent. Try again.","bad")}},
function(){send.disabled=false;tell("Not sent. Check your connection and try again.","bad")})});
})();`;

function pageScript(): string {
	return `var sealing=(${ownerHandoffSealing.toString()})();\n${PAGE_LOGIC}`;
}

function cspHash(text: string): string {
	return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

export function ownerHandoffPageHtml() {
	const script = pageScript();
	return {
		html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Connect your store</title><style>${PAGE_STYLE}</style></head><body>${PAGE_BODY}<script>${script}</script></body></html>`,
		csp: `default-src 'none'; script-src ${cspHash(script)}; style-src ${cspHash(PAGE_STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	};
}

function ownerHandoffPage(): Response {
	const page = ownerHandoffPageHtml();
	return new Response(page.html, {
		status: 200,
		headers: {
			...noStore,
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": page.csp,
			"X-Frame-Options": "DENY",
		},
	});
}
