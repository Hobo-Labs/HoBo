import { createHash, randomUUID, webcrypto } from "node:crypto";

import { z } from "zod";

import { STORE_OPTIONS } from "./mcp-store-choice.js";

// public-contract: the artifact database collection HoBo's owner page writes its sealed answer to.
export const OWNER_PAGE_COLLECTION = "hobo-owner-page";
// public-contract: the HKDF info string of a sealed owner page answer.
export const OWNER_PAGE_INFO = "hobo-owner-page/v1";

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export const OWNER_PAGE_SECRET_FIELDS = [
	"INFISICAL_TOKEN",
	"OP_CONNECT_TOKEN",
	"BW_CLIENTID",
	"BW_CLIENTSECRET",
] as const;

export type OwnerPageSecretField = (typeof OWNER_PAGE_SECRET_FIELDS)[number];

const answerField = z.string().max(16384).optional();

const answersSchema = z
	.object({
		store: z.enum(["infisical", "1password", "bitwarden"]),
		INFISICAL_PROJECT_ID: answerField,
		OP_VAULT_ID: answerField,
		OP_CONNECT_HOST: answerField,
		BITWARDEN_SERVER_URL: answerField,
		INFISICAL_TOKEN: answerField,
		OP_CONNECT_TOKEN: answerField,
		BW_CLIENTID: answerField,
		BW_CLIENTSECRET: answerField,
	})
	.strict();

export type OwnerPageAnswers = z.infer<typeof answersSchema>;

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

const sealedSchema = z
	.object({
		v: z.literal(1),
		page: z.string().uuid(),
		epk: z.object({
			kty: z.literal("EC"),
			crv: z.literal("P-256"),
			x: base64url,
			y: base64url,
		}),
		iv: base64url,
		ct: base64url,
	})
	.strict();

const sealedText = z
	.string()
	.max(65536)
	.transform((text, ctx) => {
		try {
			return JSON.parse(text);
		} catch {
			ctx.addIssue({ code: "custom", message: "not JSON" });
			return z.NEVER;
		}
	})
	.pipe(sealedSchema);

export class OwnerPageRefused extends Error {
	constructor(
		readonly reason: "malformed" | "unknown-page" | "expired" | "unreadable",
	) {
		super(reason);
		this.name = "OwnerPageRefused";
	}
}

export interface OpenedOwnerPage {
	readonly page: string;
	readonly fingerprint: string;
	readonly html: string;
}

export interface OwnerPages {
	open(cwd: string): Promise<OpenedOwnerPage>;
	unseal(sealed: string): Promise<{
		readonly cwd: string;
		readonly answers: OwnerPageAnswers;
	}>;
}

type PendingPage = Readonly<{
	cwd: string;
	privateKey: webcrypto.CryptoKey;
	expiresAt: number;
}>;

const encoder = new TextEncoder();

function fromBase64url(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "base64url"));
}

function fingerprintOf(x: string, y: string): string {
	const hex = createHash("sha256").update(`${x}.${y}`).digest("hex");
	return (hex.slice(0, 16).match(/.{4}/gu) ?? []).join("-");
}

async function aesKey(
	privateKey: webcrypto.CryptoKey,
	epk: z.infer<typeof sealedSchema>["epk"],
	page: string,
): Promise<webcrypto.CryptoKey> {
	const subtle = webcrypto.subtle;
	const peer = await subtle.importKey(
		"jwk",
		{ ...epk, ext: true },
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = await subtle.deriveBits(
		{ name: "ECDH", public: peer },
		privateKey,
		256,
	);
	const hkdf = await subtle.importKey("raw", shared, "HKDF", false, [
		"deriveKey",
	]);
	return subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: encoder.encode(page),
			info: encoder.encode(OWNER_PAGE_INFO),
		},
		hkdf,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
}

export function createOwnerPages(
	options: { readonly now?: () => number; readonly ttlMs?: number } = {},
): OwnerPages {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const pending = new Map<string, PendingPage>();
	return {
		async open(cwd) {
			const pair = await webcrypto.subtle.generateKey(
				{ name: "ECDH", namedCurve: "P-256" },
				false,
				["deriveBits"],
			);
			const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
			const x = jwk.x ?? "";
			const y = jwk.y ?? "";
			const page = randomUUID();
			pending.set(page, {
				cwd,
				privateKey: pair.privateKey,
				expiresAt: now() + ttlMs,
			});
			const fingerprint = fingerprintOf(x, y);
			return {
				page,
				fingerprint,
				html: renderOwnerPageHtml({ page, x, y, fingerprint }),
			};
		},
		async unseal(sealed) {
			const parsed = sealedText.safeParse(sealed);
			if (!parsed.success) throw new OwnerPageRefused("malformed");
			const envelope = parsed.data;
			const held = pending.get(envelope.page);
			if (held === undefined) throw new OwnerPageRefused("unknown-page");
			pending.delete(envelope.page);
			if (now() > held.expiresAt) throw new OwnerPageRefused("expired");
			let plain: ArrayBuffer;
			try {
				const key = await aesKey(held.privateKey, envelope.epk, envelope.page);
				plain = await webcrypto.subtle.decrypt(
					{
						name: "AES-GCM",
						iv: fromBase64url(envelope.iv),
						additionalData: encoder.encode(envelope.page),
					},
					key,
					fromBase64url(envelope.ct),
				);
			} catch {
				throw new OwnerPageRefused("unreadable");
			}
			let decoded: unknown;
			try {
				decoded = JSON.parse(new TextDecoder().decode(plain));
			} catch {
				throw new OwnerPageRefused("unreadable");
			}
			const answers = answersSchema.safeParse(decoded);
			if (!answers.success) throw new OwnerPageRefused("unreadable");
			return { cwd: held.cwd, answers: answers.data };
		},
	};
}

const STORE_SECTIONS = {
	infisical: [
		{ name: "INFISICAL_PROJECT_ID", label: "Project ID", secret: false },
		{
			name: "INFISICAL_TOKEN",
			label: "Token Auth access token",
			secret: true,
		},
	],
	"1password": [
		{ name: "OP_VAULT_ID", label: "Vault ID", secret: false },
		{ name: "OP_CONNECT_HOST", label: "Connect server (https)", secret: false },
		{ name: "OP_CONNECT_TOKEN", label: "Connect access token", secret: true },
	],
	bitwarden: [
		{
			name: "BITWARDEN_SERVER_URL",
			label: "Self-hosted server (optional)",
			secret: false,
		},
		{ name: "BW_CLIENTID", label: "API key client_id", secret: true },
		{ name: "BW_CLIENTSECRET", label: "API key client_secret", secret: true },
	],
} as const;

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function renderOwnerPageHtml(input: {
	readonly page: string;
	readonly x: string;
	readonly y: string;
	readonly fingerprint: string;
}): string {
	const options = STORE_OPTIONS.map(
		(o) =>
			`<label class="opt"><input type="radio" name="store" value="${o.id}" required><span><b>${escapeHtml(o.label)}</b><small>${escapeHtml(o.needs)}</small></span></label>`,
	).join("");
	const fields = STORE_OPTIONS.map((o) => {
		const inputs = STORE_SECTIONS[o.id]
			.map(
				(f) =>
					`<label for="${f.name}">${escapeHtml(f.label)}</label><input id="${f.name}" name="${f.name}" type="${f.secret ? "password" : "text"}" autocomplete="off" spellcheck="false">`,
			)
			.join("");
		return `<fieldset data-for="${o.id}" hidden><legend>${escapeHtml(o.label)}</legend>${inputs}</fieldset>`;
	}).join("");
	const config = JSON.stringify({
		page: input.page,
		x: input.x,
		y: input.y,
		info: OWNER_PAGE_INFO,
		collection: OWNER_PAGE_COLLECTION,
	}).replaceAll("<", "\\u003c");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your secret store</title>
<style>
:root{--ink:#14161a;--muted:#5b616b;--paper:#ffffff;--panel:#f4f5f7;--line:#d5d8de;--accent:#1f5eff;--on-accent:#ffffff;--ok:#0b7a3e;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ink:#eceef2;--muted:#a3a9b4;--paper:#121417;--panel:#1b1e23;--line:#30353d;--accent:#6b93ff;--on-accent:#0b0d10;--ok:#4cc38a;--bad:#ff8a80}}
:root[data-theme="dark"]{--ink:#eceef2;--muted:#a3a9b4;--paper:#121417;--panel:#1b1e23;--line:#30353d;--accent:#6b93ff;--on-accent:#0b0d10;--ok:#4cc38a;--bad:#ff8a80}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:20px;margin:0 0 4px}
p{margin:0 0 16px;color:var(--muted)}
.opt{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:10px;margin:0 0 8px;background:var(--panel);cursor:pointer}
.opt span{display:flex;flex-direction:column}
.opt small{color:var(--muted)}
fieldset{border:1px solid var(--line);border-radius:10px;margin:16px 0 0;padding:12px}
legend{font-weight:600;padding:0 4px}
fieldset label{display:block;margin:10px 0 4px;font-size:13px;color:var(--muted)}
input[type=text],input[type=password]{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font:inherit}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font:600 15px/1 inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#say{margin-top:12px;min-height:1.5em}
#say.ok{color:var(--ok)}#say.bad{color:var(--bad)}
.key{margin-top:20px;font-size:12px;color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head><body><main>
<h1>Connect your secret store</h1>
<p>HoBo keeps this project's credentials in your store. What you enter is encrypted in this page to the HoBo server running your session; the agent only carries the sealed result and cannot read it.</p>
<form id="f">${options}${fields}
<button type="submit" id="go">Seal and send to HoBo</button>
<div id="say" role="status"></div></form>
<div class="key">HoBo key fingerprint <code>${escapeHtml(input.fingerprint)}</code></div>
</main>
<script id="cfg" type="application/json">${config}</script>
<script>
(function(){
var cfg=JSON.parse(document.getElementById("cfg").textContent);
var f=document.getElementById("f"),say=document.getElementById("say"),go=document.getElementById("go");
function status(text,kind){say.textContent=text;say.className=kind||""}
function picked(){var r=f.querySelector("input[name=store]:checked");return r?r.value:""}
function show(){var s=picked();Array.prototype.forEach.call(f.querySelectorAll("fieldset"),function(e){e.hidden=e.getAttribute("data-for")!==s})}
f.addEventListener("change",show);show();
function b64(buf){var s="",a=new Uint8Array(buf);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
async function seal(answers){
var enc=new TextEncoder(),subtle=crypto.subtle;
var hobo=await subtle.importKey("jwk",{kty:"EC",crv:"P-256",x:cfg.x,y:cfg.y,ext:true},{name:"ECDH",namedCurve:"P-256"},false,[]);
var mine=await subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
var shared=await subtle.deriveBits({name:"ECDH",public:hobo},mine.privateKey,256);
var hk=await subtle.importKey("raw",shared,"HKDF",false,["deriveKey"]);
var key=await subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:enc.encode(cfg.page),info:enc.encode(cfg.info)},hk,{name:"AES-GCM",length:256},false,["encrypt"]);
var iv=crypto.getRandomValues(new Uint8Array(12));
var ct=await subtle.encrypt({name:"AES-GCM",iv:iv,additionalData:enc.encode(cfg.page)},key,enc.encode(JSON.stringify(answers)));
var epk=await subtle.exportKey("jwk",mine.publicKey);
return JSON.stringify({v:1,page:cfg.page,epk:{kty:"EC",crv:"P-256",x:epk.x,y:epk.y},iv:b64(iv),ct:b64(ct)})}
f.addEventListener("submit",async function(e){e.preventDefault();var s=picked();if(!s){status("Choose a store.","bad");return}
var answers={store:s};Array.prototype.forEach.call(f.querySelectorAll('fieldset[data-for="'+s+'"] input'),function(i){var v=i.value.trim();if(v)answers[i.name]=v});
go.disabled=true;status("Sealing…");
try{var sealed=await seal(answers);
Array.prototype.forEach.call(f.querySelectorAll("input[type=password],input[type=text]"),function(i){i.value=""});
var db=window.claude&&window.claude.use?await window.claude.use("db"):null;
if(!db){status("This view cannot save. Open the page in Claude and try again.","bad");go.disabled=false;return}
await db.doc(cfg.collection+"/"+cfg.page).set({sealed:sealed,at:Date.now()});
status("Sealed and sent. Tell Claude you are done.","ok")}
catch(err){status("Not sent: "+((err&&err.message)||"the page could not seal or save your answer."),"bad");go.disabled=false}});
})();
</script></body></html>`;
}
