/**
 * Which Bindle resources are servable, which are public, and the evidence
 * overlay that wraps them.
 *
 * `listServableEntrypoints` decides two things that are hard to undo. **What
 * gets served**: only HTTP App Kits with a resolvable fetch handler, because a
 * resource that is not one would be bound to a port and answer nothing.
 * **What is reachable from outside**: `web` is public by default and
 * `api`/`service` stay on the private mesh — an api accidentally marked
 * external is an unauthenticated endpoint on the internet, so the default is
 * closed and only an explicit `endpoint` annotation opens it.
 *
 * The ordering is not cosmetic: external first, then api, then the rest. The
 * first entrypoint is the one a caller binds to the primary URL, and putting a
 * private service there would make the deployment's front door unreachable.
 *
 * The evidence overlay injects a bridge script into HTML responses so the
 * Evidence controls can talk to a running app. Everything about it is
 * conservative, because it rewrites bodies a user's app produced:
 *
 * - **Same-origin controls are refused**, not silently allowed — the overlay's
 *   whole isolation model is that controls live somewhere else.
 * - **Compressed and non-HTML responses pass through untouched.** Injecting
 *   into a gzip stream produces corruption, and injecting into JSON produces a
 *   parse error at the client.
 * - **When a CSP would block the bridge, it falls back to an iframe wrapper**
 *   rather than injecting a script the browser will refuse — a silent failure
 *   that looks like the overlay is broken.
 * - **Every transformed response says how it was transformed**, so a user
 *   looking at a page that behaves oddly can tell whether HoBo touched it.
 */
import type {
	BindleDefinition,
	BindleResourceRecord,
	ProviderAnnotation,
	ResourceKind,
} from "@hobo/bindles";
import { describe, expect, it } from "vitest";

import {
	isExternalComponent,
	listServableEntrypoints,
	listServableEntrypointsWithReplay,
} from "../src/servable-entrypoints.js";

type Entrypoint = NonNullable<ReturnType<BindleDefinition["entrypoint"]>>;

/** One resource of a test Bindle: its kind, what its entrypoint returns, its annotations. */
type ResourceSpec = {
	readonly kind: ResourceKind;
	readonly handler?: ReturnType<Entrypoint>;
	readonly annotations?: readonly Omit<ProviderAnnotation, "provider">[];
};

const CONTROLS = "https://controls.example/evidence";

/** A Bindle whose resources map to the given kinds and handlers. */
function definition(
	resources: Readonly<Record<string, ResourceSpec>>,
): BindleDefinition {
	const records: Record<string, BindleResourceRecord> = {};
	for (const [name, spec] of Object.entries(resources)) {
		records[name] = {
			kind: spec.kind,
			name,
			stableId: `${spec.kind}:${name}`,
			declaredAllow: [],
			annotations: (spec.annotations ?? []).map((annotation) => ({
				provider: "test",
				...annotation,
			})),
			dependsOn: [],
		};
	}
	return {
		name: "app",
		resources: records,
		edges: [],
		requirements: { require: [], prefer: [], runtimes: [], labels: {} },
		entrypoint: (name: string) => {
			const handler = resources[name]?.handler;
			if (handler === undefined) return undefined;
			return () => handler;
		},
	};
}

const ok = () => new Response("hello");
const html = (body: string, headers: Record<string, string> = {}) =>
	new Response(body, {
		headers: { "content-type": "text/html; charset=utf-8", ...headers },
	});

/** The entrypoints for a definition, with the overlay off unless asked for. */
function serve(
	def: BindleDefinition,
	options: { controls?: string } = {},
): ReturnType<typeof listServableEntrypoints> {
	if (options.controls === undefined) {
		return listServableEntrypoints(def, { env: {} });
	}
	return listServableEntrypoints(def, {
		env: {},
		evidenceControlsUrl: options.controls,
	});
}

describe("isExternalComponent", () => {
	it("makes only web public when nothing says otherwise", () => {
		// An api reachable from the internet without being asked for is an
		// unauthenticated endpoint. The default has to be the closed one.
		expect(isExternalComponent("web", [])).toBe(true);
		for (const kind of ["api", "service", "ui", "kv"]) {
			expect(isExternalComponent(kind, [])).toBe(false);
		}
	});

	it("lets an endpoint annotation open or close any kind", () => {
		// Exposure is a deliberate act in both directions: an internal-only web
		// surface is as legitimate as a public api, and both are stated the same
		// way.
		const open = [{ option: "endpoint", config: { external: true } }];
		const closed = [{ option: "endpoint", config: { external: false } }];
		expect(isExternalComponent("api", open)).toBe(true);
		expect(isExternalComponent("web", closed)).toBe(false);
	});

	it("ignores annotations that are not endpoint, or whose value is not boolean", () => {
		// `external: "true"` from a hand-written manifest is not a decision to
		// expose. Coercing it would turn a typo into an open port.
		expect(
			isExternalComponent("api", [
				{ option: "env", config: { external: true } },
			]),
		).toBe(false);
		expect(
			isExternalComponent("api", [
				{ option: "endpoint", config: { external: "true" } },
			]),
		).toBe(false);
		expect(
			isExternalComponent("api", [{ option: "endpoint", config: {} }]),
		).toBe(false);
	});

	it("takes the first endpoint annotation that carries a boolean", () => {
		expect(
			isExternalComponent("api", [
				{ option: "endpoint", config: { external: true } },
				{ option: "endpoint", config: { external: false } },
			]),
		).toBe(true);
	});
});

describe("entrypoint collection", () => {
	it("collects the four HTTP App Kits and nothing else", () => {
		// A kv or queue resource has no fetch handler. Binding one to a port
		// would produce a listener that answers nothing.
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				api: { kind: "api", handler: ok },
				svc: { kind: "service", handler: ok },
				panel: { kind: "ui", handler: ok },
				cache: { kind: "kv", handler: ok },
				queue: { kind: "queue", handler: ok },
			}),
		);
		expect(entries.map((entry) => entry.name).sort()).toEqual([
			"api",
			"panel",
			"site",
			"svc",
		]);
	});

	it("skips a resource whose entrypoint is missing", async () => {
		// A declared-but-unimplemented resource is a normal state mid-build.
		// Failing here would make an incomplete Bindle unservable rather than
		// partially servable.
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				todo: { kind: "api" },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site"]);
	});

	it("skips a resource whose entrypoint does not resolve to a function", async () => {
		// An entrypoint returning a config object rather than a handler is a
		// programming mistake; serving it would call the object as a function on
		// the first request instead of at startup.
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				broken: { kind: "api", handler: { notAFunction: true } },
				nullish: { kind: "api", handler: null },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site"]);
	});

	it("orders external first, then api, then the rest", () => {
		// The first entrypoint becomes the primary URL. A private service there
		// would make the deployment's front door unreachable.
		const entries = serve(
			definition({
				svc: { kind: "service", handler: ok },
				api: { kind: "api", handler: ok },
				site: { kind: "web", handler: ok },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site", "api", "svc"]);
		expect(entries[0]?.external).toBe(true);
	});

	it("promotes an explicitly-external api ahead of the default web", () => {
		// Rank is by exposure first, so an api the author deliberately opened
		// competes for the primary URL on equal terms.
		const entries = serve(
			definition({
				api: {
					kind: "api",
					handler: ok,
					annotations: [{ option: "endpoint", config: { external: true } }],
				},
				site: {
					kind: "web",
					handler: ok,
					annotations: [{ option: "endpoint", config: { external: false } }],
				},
			}),
		);
		expect(entries[0]?.name).toBe("api");
		expect(entries[0]?.external).toBe(true);
	});

	it("returns the session replay plan and store alongside the entrypoints", () => {
		// The plan says which surfaces are being captured. A caller that got
		// only the handlers would have no way to report capture state.
		const result = listServableEntrypointsWithReplay(
			definition({ site: { kind: "web", handler: ok } }),
			{ env: {}, stationId: "station:test" },
		);
		expect(result.entrypoints).toHaveLength(1);
		expect(result.sessionReplay).toBeDefined();
		expect(result.sessionReplayStore).toBeDefined();
	});
});

describe("evidence overlay — when it engages", () => {
	it("leaves handlers alone when no controls url is configured", async () => {
		// The overlay rewrites a user's HTML. It must not do that on a machine
		// that never asked for Evidence.
		const entries = serve(definition({ site: { kind: "web", handler: ok } }));
		const response = await entries[0]?.handler(
			new Request("https://app.example/"),
		);
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBeNull();
	});

	it("ignores an empty controls url as firmly as an absent one", async () => {
		const entries = serve(definition({ site: { kind: "web", handler: ok } }), {
			controls: "",
		});
		const response = await entries[0]?.handler(
			new Request("https://app.example/"),
		);
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBeNull();
	});

	it("reads the controls url from the environment when no option is passed", async () => {
		// The Code lane exports it rather than threading an option through every
		// caller; ignoring the variable would make the overlay silently inert.
		const entries = listServableEntrypoints(
			definition({
				site: { kind: "web", handler: () => html("<body>x</body>") },
			}),
			{ env: { HOBO_CODE_EVIDENCE_CONTROLS_URL: CONTROLS } },
		);
		const response = await entries[0]?.handler(
			new Request("https://app.example/"),
		);
		expect(response?.headers.get("x-hobo-evidence-overlay")).not.toBeNull();
	});
});

describe("evidence overlay — what it refuses to touch", () => {
	const overlaid = (handler: () => Response) =>
		serve(definition({ site: { kind: "web", handler } }), {
			controls: CONTROLS,
		})[0];

	it("passes a non-HTML response through unchanged", async () => {
		// Injecting a script tag into JSON produces a parse error at the client
		// — a failure that looks like the app is broken, not the overlay.
		const entry = overlaid(
			() =>
				new Response('{"ok":true}', {
					headers: { "content-type": "application/json" },
				}),
		);
		const response = await entry?.handler(new Request("https://app.example/"));
		expect(await response?.text()).toBe('{"ok":true}');
	});

	it("passes a compressed response through unchanged", async () => {
		// The body is gzip bytes. Splicing HTML into them corrupts the stream,
		// and the browser reports a decode error rather than anything actionable.
		const entry = overlaid(() =>
			html("<body>x</body>", { "content-encoding": "gzip" }),
		);
		const response = await entry?.handler(new Request("https://app.example/"));
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBeNull();
	});

	it("treats an identity content-encoding as uncompressed", async () => {
		// `identity` is the explicit spelling of "not compressed". Refusing on it
		// would disable the overlay for servers that are precise.
		const entry = overlaid(() =>
			html("<body>x</body>", { "content-encoding": " Identity " }),
		);
		const response = await entry?.handler(new Request("https://app.example/"));
		expect(response?.headers.get("x-hobo-evidence-overlay")).not.toBeNull();
	});

	it("passes a non-GET response through unchanged", async () => {
		// A POST response is usually a redirect or an action result, not a page
		// the overlay belongs on.
		const entry = overlaid(() => html("<body>x</body>"));
		const response = await entry?.handler(
			new Request("https://app.example/", { method: "POST" }),
		);
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBeNull();
	});

	it("refuses when the app and the controls share an origin", async () => {
		// The isolation model is that controls run somewhere the app cannot
		// reach into. Same-origin would defeat it silently, so it is refused
		// with a header saying why.
		const entry = serve(
			definition({
				site: { kind: "web", handler: () => html("<body>x</body>") },
			}),
			{ controls: "https://app.example/evidence" },
		)[0];
		const response = await entry?.handler(new Request("https://app.example/"));
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBe(
			"refused-same-origin",
		);
	});
});

describe("evidence overlay — how it transforms", () => {
	const overlaid = (handler: (request: Request) => Response) =>
		serve(definition({ site: { kind: "web", handler } }), {
			controls: CONTROLS,
		})[0];

	it("injects the bridge before the closing body tag", async () => {
		// After `</body>` the browser has already closed the document; before it
		// the script runs in the page it is instrumenting.
		const entry = overlaid(() => html("<html><body>page</body></html>"));
		const response = await entry?.handler(new Request("https://app.example/"));
		const body = (await response?.text()) ?? "";
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBe("bridge");
		expect(body.indexOf("data-hobo-evidence-overlay-bridge")).toBeGreaterThan(
			body.indexOf("page"),
		);
		expect(body.indexOf("data-hobo-evidence-overlay-bridge")).toBeLessThan(
			body.lastIndexOf("</body>"),
		);
	});

	it("falls back to an iframe wrapper when a CSP would block the bridge", async () => {
		// Injecting a script the browser refuses is a silent failure that reads
		// as "the overlay is broken". The wrapper works within the app's own CSP
		// by not being inside the app's document at all.
		const entry = overlaid(() =>
			html("<html><body>page</body></html>", {
				"content-security-policy": "script-src 'none'",
			}),
		);
		const response = await entry?.handler(new Request("https://app.example/"));
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBe("wrapper");
	});

	it("falls back to the wrapper when there is no body tag to inject into", async () => {
		// A fragment response has nowhere for the bridge to go.
		const entry = overlaid(() => html("<div>fragment</div>"));
		const response = await entry?.handler(new Request("https://app.example/"));
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBe("wrapper");
	});

	it("serves the app itself when the raw marker is present", async () => {
		// The wrapper's iframe requests the app with this marker. Overlaying
		// again would nest a wrapper inside a wrapper, forever.
		const entry = overlaid((request) => html(`<body>${request.url}</body>`));
		const response = await entry?.handler(
			new Request("https://app.example/?__hobo_evidence_raw=1"),
		);
		const body = (await response?.text()) ?? "";
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBeNull();
		// The marker is stripped before the app sees the request — an app
		// routing on the query string should not have to know about it.
		expect(body).not.toContain("__hobo_evidence_raw");
	});

	it("answers the overlay's own idle path without calling the app", async () => {
		// The controls poll this path. Routing it into the app would show up in
		// the user's logs as traffic they did not receive.
		let called = false;
		const entry = overlaid(() => {
			called = true;
			return html("<body>x</body>");
		});
		const response = await entry?.handler(
			new Request("https://app.example/__hobo/evidence/bo-idle.png"),
		);
		expect(response?.status).toBeLessThan(400);
		expect(called).toBe(false);
	});

	it("serves the debug wrapper on request, and refuses it same-origin", async () => {
		// The debug parameter forces the wrapper so an operator can see the
		// overlay chrome. Same-origin is refused here too — with a 409 rather
		// than a silently unhelpful page.
		const entry = overlaid(() => html("<body>x</body>"));
		const response = await entry?.handler(
			new Request("https://app.example/?__hobo_debug=1"),
		);
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBe("debug");

		const sameOrigin = serve(
			definition({
				site: { kind: "web", handler: () => html("<body>x</body>") },
			}),
			{ controls: "https://app.example/evidence" },
		)[0];
		const refused = await sameOrigin?.handler(
			new Request("https://app.example/?__hobo_debug=1"),
		);
		expect(refused?.status).toBe(409);
		expect(refused?.headers.get("x-hobo-evidence-overlay")).toBe(
			"refused-same-origin",
		);
	});

	it("sends no body for a HEAD request while keeping the headers", async () => {
		// A HEAD that carried a body is a protocol violation, and clients that
		// tolerate it still misreport the length.
		const entry = overlaid(() => html("<body>x</body>"));
		const response = await entry?.handler(
			new Request("https://app.example/?__hobo_debug=1", {
				method: "HEAD",
			}),
		);
		expect(response?.headers.get("x-hobo-evidence-overlay")).toBe("debug");
		expect(await response?.text()).toBe("");
	});

	it("rewrites component.local back to the public host before building URLs", async () => {
		// Component hosts rewrite the request URL to `component.local`. An
		// overlay that built its wrapper from that would hand the browser a URL
		// only the host can resolve.
		const entry = overlaid(() => html("<div>fragment</div>"));
		const response = await entry?.handler(
			new Request("https://component.local/page?a=1", {
				headers: { host: "app.example" },
			}),
		);
		const body = (await response?.text()) ?? "";
		expect(body).toContain("app.example");
		expect(body).not.toContain("component.local");
	});
});
