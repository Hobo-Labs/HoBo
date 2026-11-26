import type { BrowserRuntimeDescriptor } from "./guest-source.js";
import {
	parseBrowserRuntimeManifest,
	type BrowserRuntimeManifest,
} from "../runtime-manifest.js";

export { parseBrowserRuntimeManifest } from "../runtime-manifest.js";

export interface BrowserWitStationHost {
	readonly url: string;
	readonly evidence: Pick<
		BrowserRuntimeManifest,
		"componentDigest" | "witWorld" | "toolchain"
	> & { readonly componentModel: true };
	revoke(): void;
}

export interface BrowserWitStationInput {
	readonly assetBaseUrl: string;
	readonly exampleId: string;
	readonly title: string;
	readonly ui: "counter" | "hello" | "notes" | "todos" | "queue" | "saas";
	readonly stationId: string;
	readonly targetLabel: string;
	readonly runtime: BrowserRuntimeDescriptor;
}

export async function browserWitRuntimeAvailable(
	assetBaseUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const manifestUrl = new URL(
		`${assetBaseUrl.replace(/\/$/u, "")}/manifest.json`,
		globalThis.document === undefined ? "https://example.invalid/" : document.baseURI,
	);
	try {
		const response = await fetchImpl(manifestUrl, { credentials: "same-origin" });
		return response.ok;
	} catch {
		return false;
	}
}

export async function createBrowserWitStationHost(
	input: BrowserWitStationInput,
): Promise<BrowserWitStationHost> {
	const manifestUrl = new URL(
		`${input.assetBaseUrl.replace(/\/$/u, "")}/manifest.json`,
		document.baseURI,
	);
	const response = await fetch(manifestUrl, { credentials: "same-origin" });
	if (!response.ok) {
		throw new Error(
			`Browser WIT runtime manifest unavailable (${response.status})`,
		);
	}
	const manifest = parseBrowserRuntimeManifest(await response.json());
	await fetchVerifiedAsset("station.component.wasm", manifest, manifestUrl);
	const entryBytes = await fetchVerifiedAsset(
		manifest.entryModule,
		manifest,
		manifestUrl,
	);
	const wasmNames = manifest.assets.filter(
		(name) => name.endsWith(".wasm") && !name.endsWith(".component.wasm"),
	);
	const wasmAssets = await Promise.all(
		wasmNames.map(async (name) => {
			const bytes = await fetchVerifiedAsset(name, manifest, manifestUrl);
			return {
				name,
				base64: encodeBase64(bytes),
			};
		}),
	);
	const html = buildBrowserWitStationHtml({
		...input,
		entryModuleSource: new TextDecoder().decode(entryBytes),
		wasmAssets,
		manifest,
	});
	const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
	return {
		url,
		evidence: {
			componentModel: true,
			componentDigest: manifest.componentDigest,
			witWorld: manifest.witWorld,
			toolchain: manifest.toolchain,
		},
		revoke: () => URL.revokeObjectURL(url),
	};
}

export function buildBrowserWitStationHtml(
	input: Omit<BrowserWitStationInput, "assetBaseUrl"> & {
		readonly entryModuleSource: string;
		readonly wasmAssets: readonly { readonly name: string; readonly base64: string }[];
		readonly manifest: BrowserRuntimeManifest;
	},
): string {
	const config = safeJson({
		exampleId: input.exampleId,
		title: input.title,
		ui: input.ui,
		stationId: input.stationId,
		targetLabel: input.targetLabel,
		runtime: input.runtime,
		componentDigest: input.manifest.componentDigest,
		entryModuleSource: input.entryModuleSource,
		wasmAssets: input.wasmAssets,
	});
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(input.title)} · ${escapeHtml(input.targetLabel)}</title>
  <style>
    :root{color-scheme:dark;font:15px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:#0b1012;color:#e8eddf}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:clamp(1rem,4vw,2.5rem);background:radial-gradient(circle at top right,#20382d 0,transparent 42%),#0b1012}main{max-width:44rem;margin:auto;border:1px solid #405047;border-radius:18px;background:#111819;padding:clamp(1rem,4vw,2rem);box-shadow:0 20px 70px #0009}.top{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}.badge{border:1px solid #6ea97e;border-radius:999px;padding:.25rem .65rem;color:#a7e2b4;background:#173122}h1{font-family:ui-rounded,system-ui,sans-serif;font-size:clamp(1.4rem,6vw,2.4rem);margin:1.25rem 0 .25rem}small{color:#9eaaa3}.controls{display:flex;gap:.65rem;flex-wrap:wrap;margin:1.5rem 0}input,button{font:inherit;border-radius:9px;min-height:44px}input{flex:1;min-width:10rem;border:1px solid #526259;background:#080d0e;color:inherit;padding:.65rem .8rem}button{border:1px solid #bada88;background:#bada88;color:#132014;padding:.65rem 1rem;font-weight:700;cursor:pointer}button.secondary{background:transparent;color:#dce9d7}button:disabled{opacity:.55;cursor:wait}output{display:block;border:1px solid #35423c;border-radius:12px;background:#080d0e;padding:1rem;min-height:7rem;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#ffaaa0}.proof{margin-top:1rem;color:#84928b;font-size:.75rem;overflow-wrap:anywhere}.panels{display:grid;gap:1rem;margin:1.25rem 0}.panel{border:1px solid #35423c;border-radius:12px;padding:.85rem}.panel h2{margin:0 0 .65rem;font:700 .95rem/1.2 ui-rounded,system-ui,sans-serif}.panel .row{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem}.hidden{display:none}
  </style>
</head>
<body>
  <main>
    <div class="top"><span class="badge">Live · ${escapeHtml(input.targetLabel)}</span><small id="status">booting WIT component…</small></div>
    <h1 id="title"></h1>
    <small id="station"></small>
    <div class="controls" id="controls"></div>
    <output id="result" aria-live="polite">Starting Environment Station…</output>
    <div class="proof" id="proof"></div>
  </main>
  <script type="module">
    const config = ${config};
    const status = document.querySelector("#status");
    const controls = document.querySelector("#controls");
    const result = document.querySelector("#result");
    document.querySelector("#title").textContent = config.title;
    document.querySelector("#station").textContent = config.stationId;
    document.querySelector("#proof").textContent = "verified WIT runtime · component provenance " + config.componentDigest;

    function route(action) {
      return config.runtime.routes.find((candidate) => candidate.action === action);
    }
    function button(label, action, body) {
      const element = document.createElement("button");
      element.textContent = label;
      element.addEventListener("click", () => call(action, body ? body() : undefined));
      controls.append(element);
      return element;
    }
    function input(placeholder) {
      const element = document.createElement("input");
      element.placeholder = placeholder;
      element.setAttribute("aria-label", placeholder);
      controls.append(element);
      return element;
    }
	    function show(response) {
      result.classList.toggle("error", response.status >= 400);
      result.textContent = JSON.stringify(response.body, null, 2);
	    }
	    let component;
    function allButtons() {
      return document.querySelectorAll("button");
    }
    async function call(action, body, required = false) {
      const match = route(action);
      if (!match) return null;
      allButtons().forEach((item) => { item.disabled = true; });
      try {
        const response = component.invoke({
          exampleId: config.exampleId,
          stationId: config.stationId,
          method: match.method,
          path: match.path,
		  bodyJson: JSON.stringify(body ?? {}),
		});
        const parsed = { status: response.status, body: JSON.parse(response.bodyJson) };
		show(parsed);
        return parsed;
      } catch (error) {
        show({ status: 500, body: { error: error instanceof Error ? error.message : String(error) } });
		if (required) throw error;
        return null;
      } finally {
        allButtons().forEach((item) => { item.disabled = false; });
      }
    }
    async function mountSaasUi() {
      controls.classList.add("hidden");
      const panels = document.createElement("div");
      panels.className = "panels";
      const auth = document.createElement("section");
      auth.className = "panel";
      auth.innerHTML = "<h2>Auth</h2><div class=\\"row\\"></div><div class=\\"row\\"></div>";
      const store = document.createElement("section");
      store.className = "panel";
      store.innerHTML = "<h2>Store</h2><div class=\\"row\\"></div>";
      const admin = document.createElement("section");
      admin.className = "panel hidden";
      admin.innerHTML = "<h2>Admin</h2><div class=\\"row\\"></div>";
      panels.append(auth, store, admin);
      controls.after(panels);
      const authRows = auth.querySelectorAll(".row");
      const email = document.createElement("input");
      email.placeholder = "email";
      email.value = "admin@demo.hobo";
      const password = document.createElement("input");
      password.placeholder = "password";
      password.type = "password";
      password.value = "demo";
      const name = document.createElement("input");
      name.placeholder = "display name";
      authRows[0].append(email, password, name);
      function makeButton(label, action, body, secondary) {
        const element = document.createElement("button");
        element.textContent = label;
        if (secondary) element.classList.add("secondary");
        element.addEventListener("click", async () => {
          const response = await call(action, body());
          if (response) await refreshSaas(response);
        });
        return element;
      }
      authRows[1].append(
        makeButton("Sign up", "signup", () => ({ email: email.value, password: password.value, name: name.value })),
        makeButton("Log in", "login", () => ({ email: email.value, password: password.value })),
        makeButton("Log out", "logout", () => ({}), true),
        makeButton("Me", "me", () => ({}), true),
      );
      const storeRow = store.querySelector(".row");
      storeRow.append(
        makeButton("List products", "listProducts", () => ({})),
        makeButton("Checkout first", "checkout", () => ({ productId: "1" })),
        makeButton("My orders", "listOrders", () => ({}), true),
      );
      admin.querySelector(".row").append(
        makeButton("List users", "adminListUsers", () => ({})),
      );
      async function refreshSaas(last) {
        const me = last?.body?.session ? last : await call("me", {});
        const session = me?.body?.session;
        admin.classList.toggle("hidden", !(session && session.role === "admin"));
        await call("listProducts", {});
      }
      await call("login", { email: "admin@demo.hobo", password: "demo" });
      await refreshSaas(null);
    }

	    try {
	      const objectUrls = [];
	      let moduleSource = config.entryModuleSource;
	      for (const asset of config.wasmAssets) {
	        const binary = atob(asset.base64);
	        const bytes = new Uint8Array(binary.length);
	        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	        const assetUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
	        objectUrls.push(assetUrl);
	        moduleSource = moduleSource.replaceAll("./" + asset.name, assetUrl);
	        moduleSource = moduleSource.replaceAll(asset.name, assetUrl);
	      }
	      const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
	      objectUrls.push(moduleUrl);
	      addEventListener("unload", () => objectUrls.forEach((url) => URL.revokeObjectURL(url)), { once: true });
	      component = await import(moduleUrl);
	      await component.$init;
      if (typeof component.invoke !== "function") throw new Error("WIT invoke export missing");
      if (config.ui === "counter") {
        button("Increment", "increment", () => ({ by: 1 }));
        const reset = button("Reset", "reset"); reset.classList.add("secondary");
		await call("read", undefined, true);
      } else if (config.ui === "hello") {
        const name = input("Optional name");
        button("Greet", "greet", () => ({ name: name.value }));
        await call("greet", {}, true);
      } else if (config.ui === "notes" || config.ui === "todos") {
        const text = input(config.ui === "todos" ? "New task" : "New note");
        button("Add", "create", () => ({ text: text.value, completed: false }));
        if (config.ui === "todos") button("Toggle first", "toggle", () => ({ id: "1" }));
		else button("Delete first", "delete", () => ({ id: "1" }));
		await call("list", undefined, true);
      } else if (config.ui === "saas") {
        await mountSaasUi();
      } else {
        const message = input("Queue message");
        button("Enqueue", "enqueue", () => ({ message: message.value }));
        const drain = button("Drain", "drain"); drain.classList.add("secondary");
		await call(route("list") ? "list" : "read", undefined, true);
      }
      status.textContent = "component ready";
      parent.postMessage({ source: "hobo-browser-station", stationId: config.stationId, status: "ready" }, "*");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = "component failed";
      show({ status: 500, body: { error: message } });
      parent.postMessage({ source: "hobo-browser-station", stationId: config.stationId, status: "error", message }, "*");
    }
  </script>
</body>
</html>`;
}

type BrowserWitStationHtmlConfig = {
	readonly exampleId: string;
	readonly title: string;
	readonly ui: BrowserWitStationInput["ui"];
	readonly stationId: string;
	readonly targetLabel: string;
	readonly runtime: BrowserRuntimeDescriptor;
	readonly componentDigest: string;
	readonly entryModuleSource: string;
	readonly wasmAssets: readonly { readonly name: string; readonly base64: string }[];
};

function safeJson(value: BrowserWitStationHtmlConfig): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function encodeBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
	}
	return btoa(chunks.join(""));
}

async function fetchVerifiedAsset(
	name: string,
	manifest: BrowserRuntimeManifest,
	manifestUrl: URL,
): Promise<Uint8Array> {
	const response = await fetch(new URL(name, manifestUrl), {
		credentials: "same-origin",
	});
	if (!response.ok) {
		throw new Error(`Browser WIT asset ${name} unavailable (${response.status})`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const digest = `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
	if (digest !== manifest.assetDigests[name]) {
		throw new Error(`Browser WIT asset digest mismatch: ${name}`);
	}
	return bytes;
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
