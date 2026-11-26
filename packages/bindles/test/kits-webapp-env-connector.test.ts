/**
 * App Kits, webApp detection, the `env` dual surface, and the connector
 * registry.
 *
 * Four small surfaces that share one trait: each answers a question by
 * *classification*, and a wrong answer is silent. A kind wrongly classified as
 * an App Kit gets Session Replay attached to something that hosts no
 * entrypoint; a binding wrongly classified as a web app gets a framework
 * annotation naming a root that does not exist; a connector looked up before
 * its package was imported would otherwise resolve to nothing.
 *
 * The webApp detector is the subtlest. It reads well-known symbols that
 * framework packages stamp onto their binding function, and it is *structural*
 * — no import of Wasp or Convex, no instanceof. That is what lets a framework
 * package participate without this package depending on it. The cost is that
 * every field has to be checked: a stamped meta object with a non-string root,
 * or an empty one, has to be rejected rather than carried into an annotation
 * that would send a build looking for a directory nobody named.
 */
import { describe, expect, it } from "vitest";
import {
	APP_KIT_KINDS,
	appKitLabel,
	HTTP_APP_KIT_KINDS,
	INFRA_KIT_KINDS,
	isAppKitKind,
	isHttpAppKitKind,
} from "../src/app-kits.js";
import { connectorDefinition, defineConnector } from "../src/connector.js";
import { env } from "../src/env.js";
import type { JsonValue } from "../src/json.js";
import { secretRef } from "../src/secret-ref.js";
import {
	CONVEX_WEBAPP_METADATA,
	isWebAppAnnotation,
	WASP_WEBAPP_METADATA,
	WEBAPP_META,
	WEBAPP_OPTION,
	webAppAnnotationFromBinding,
} from "../src/webapp.js";

describe("App Kit classification", () => {
	it("recognises every declared App Kit kind", () => {
		for (const kind of APP_KIT_KINDS) {
			expect(isAppKitKind(kind)).toBe(true);
		}
	});

	it("does not classify an infrastructure kind as an App Kit", () => {
		// The consequential half. Session Replay is default-supplied for every
		// Kit, so misclassifying a bucket or a queue would attach replay to
		// something that hosts no entrypoint for it to attach to.
		for (const kind of INFRA_KIT_KINDS) {
			expect(isAppKitKind(kind)).toBe(false);
		}
	});

	it("keeps the two lists disjoint", () => {
		// Stated as a property rather than assumed. A kind in both lists would
		// make `isAppKitKind` and the infra classification disagree, and which
		// one a consumer believed would depend on which it happened to call.
		const app = new Set<string>(APP_KIT_KINDS);
		for (const kind of INFRA_KIT_KINDS) {
			expect(app.has(kind)).toBe(false);
		}
	});

	it("rejects an unknown kind rather than guessing", () => {
		for (const kind of ["", "database", "API", "wasm", "kit"]) {
			expect(isAppKitKind(kind)).toBe(false);
		}
	});

	it("classifies only the HTTP-servable subset as http kits", () => {
		// `listServableEntrypoints` binds on this. A job or a wasm-component
		// listed as servable would have a host try to route HTTP to something
		// with no fetch handler.
		for (const kind of HTTP_APP_KIT_KINDS) {
			expect(isHttpAppKitKind(kind)).toBe(true);
		}
		for (const kind of ["job", "websocket", "wasm-component"]) {
			expect(isHttpAppKitKind(kind)).toBe(false);
		}
	});

	it("keeps the http subset inside the App Kit set", () => {
		// A subset that escaped its parent would make something servable that is
		// not a Kit at all.
		for (const kind of HTTP_APP_KIT_KINDS) {
			expect(isAppKitKind(kind)).toBe(true);
		}
	});

	it("labels every App Kit kind", () => {
		// The switch is exhaustive by construction — the `never` default makes a
		// new kind a compile error rather than a runtime fallthrough. This
		// asserts the runtime half: no kind returns undefined or its own name.
		for (const kind of APP_KIT_KINDS) {
			const label = appKitLabel(kind);
			expect(label).toBeTypeOf("string");
			expect(label.length).toBeGreaterThan(0);
			expect(label).toMatch(/Kit$/u);
		}
	});

	it("gives each kind a distinct label", () => {
		// Two kinds sharing a label would make a doctor surface ambiguous about
		// which one it was reporting on.
		const labels = APP_KIT_KINDS.map(appKitLabel);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("labels the ones whose names do not match their kind", () => {
		// `websocket` is Realtime and `wasm-component` is Component. Both are
		// deliberate renamings for the docs surface, and pinning them stops a
		// well-meaning tidy-up from making the labels mechanical.
		expect(appKitLabel("websocket")).toBe("Realtime Kit");
		expect(appKitLabel("wasm-component")).toBe("Component Kit");
		expect(appKitLabel("api")).toBe("API Kit");
	});

	it("freezes the kind lists", () => {
		// Read on every classification. A pushed entry would silently make
		// something a Kit for the rest of the process.
		expect(Object.isFrozen(APP_KIT_KINDS)).toBe(true);
		expect(Object.isFrozen(HTTP_APP_KIT_KINDS)).toBe(true);
		expect(Object.isFrozen(INFRA_KIT_KINDS)).toBe(true);
	});
});

describe("webApp detection", () => {
	/** A framework-style binding: a function carrying a stamped meta symbol. */
	type StampedBinding = (() => undefined) & {
		[symbol: symbol]: JsonValue | undefined;
	};
	function stamped(symbol: symbol, meta: JsonValue) {
		// SAFETY: this test binding deliberately models a framework symbol bag.
		const binding = (() => undefined) as StampedBinding;
		binding[symbol] = meta;
		// SAFETY: the fixture is intentionally passed through the untyped binding boundary.
		return binding as never;
	}

	it("reads a framework and root from the neutral meta symbol", () => {
		const annotation = webAppAnnotationFromBinding(
			stamped(WEBAPP_META, { framework: "astro", root: "./web" }),
		);
		expect(annotation).toEqual({
			provider: "hobo",
			option: WEBAPP_OPTION,
			config: { framework: "astro", root: "./web" },
		});
	});

	it("reads the Wasp and Convex symbols too", () => {
		// Framework packages stamp their own symbol as well as the neutral one,
		// and older versions stamp only theirs. Knowing one spelling would make
		// a correctly-annotated app invisible.
		for (const symbol of [WASP_WEBAPP_METADATA, CONVEX_WEBAPP_METADATA]) {
			expect(
				webAppAnnotationFromBinding(
					stamped(symbol, { framework: "wasp", root: "./app" }),
				),
			).toBeDefined();
		}
	});

	it("prefers the neutral symbol when several are stamped", () => {
		// The `??` chain order. A package stamping both means the neutral one is
		// its current answer; reading the framework-specific one first would
		// return stale metadata after a migration.
		const binding = stamped(WEBAPP_META, {
			framework: "neutral",
			root: "./neutral",
		});
		binding[WASP_WEBAPP_METADATA] = {
			framework: "wasp",
			root: "./wasp",
		};
		expect(
			// SAFETY: the preceding fixture establishes a valid web-app annotation.
			(
				webAppAnnotationFromBinding(binding) as {
					config: { framework: string };
				}
			).config.framework,
		).toBe("neutral");
	});

	it("answers undefined for a binding that is not a function", () => {
		// The stamp lives on a framework's binding *function*. Anything else is
		// simply not a web app, which is a normal answer rather than an error.
		for (const binding of [undefined, null, {}, "app", 7, []]) {
			// SAFETY: invalid fixtures test the parser boundary.
			expect(webAppAnnotationFromBinding(binding as never)).toBeUndefined();
		}
	});

	it("answers undefined for a function carrying no stamp", () => {
		expect(
			// SAFETY: an un-stamped function fixture tests the parser boundary.
			webAppAnnotationFromBinding((() => undefined) as never),
		).toBeUndefined();
	});

	it("rejects a stamp that is not an object", () => {
		for (const meta of ["astro", 7, true, null]) {
			expect(
				webAppAnnotationFromBinding(stamped(WEBAPP_META, meta)),
			).toBeUndefined();
		}
	});

	it("rejects a stamp with a missing or empty framework", () => {
		// A framework annotation with no framework names nothing, and whatever
		// consumed it would have to guess — most likely by defaulting, which is
		// how the wrong builder gets run.
		for (const framework of [undefined, "", 7, null, {}]) {
			expect(
				webAppAnnotationFromBinding(
					stamped(WEBAPP_META, { framework, root: "./web" }),
				),
			).toBeUndefined();
		}
	});

	it("rejects a stamp with a missing or empty root", () => {
		// The root is a directory a build will be pointed at. An empty one
		// resolves to the repository root, which would build the whole tree.
		for (const root of [undefined, "", 7, null, {}]) {
			expect(
				webAppAnnotationFromBinding(
					stamped(WEBAPP_META, { framework: "astro", root }),
				),
			).toBeUndefined();
		}
	});

	it("freezes the annotation and its config", () => {
		// Annotations are collected into a manifest and read repeatedly. A
		// mutated root would repoint a build after the fact.
		const annotation = webAppAnnotationFromBinding(
			stamped(WEBAPP_META, { framework: "astro", root: "./web" }),
		);
		expect(Object.isFrozen(annotation)).toBe(true);
		// SAFETY: the returned annotation contract includes a config object.
		expect(Object.isFrozen((annotation as { config: object }).config)).toBe(
			true,
		);
	});

	it("recognises its own annotation and rejects another provider's", () => {
		// The round trip. A recogniser that matched on the option alone would
		// claim another provider's `webapp` option as its own.
		const annotation = webAppAnnotationFromBinding(
			stamped(WEBAPP_META, { framework: "astro", root: "./web" }),
		);
		// SAFETY: the returned annotation is the valid provider annotation under test.
		expect(isWebAppAnnotation(annotation as never)).toBe(true);
		// SAFETY: invalid provider fixtures test the parser boundary.
		expect(
			isWebAppAnnotation({
				provider: "other",
				option: WEBAPP_OPTION,
				config: {},
			} as never),
		).toBe(false);
		// SAFETY: invalid option fixtures test the parser boundary.
		expect(
			isWebAppAnnotation({
				provider: "hobo",
				option: "env",
				config: {},
			} as never),
		).toBe(false);
	});
});

describe("the env dual surface", () => {
	it("builds an annotation when called as a function", () => {
		expect(env({ LOG_LEVEL: "debug" })).toEqual({
			provider: "hobo",
			option: "env",
			config: { LOG_LEVEL: "debug" },
		});
	});

	it("carries string, number, and boolean values through", () => {
		// The three JSON scalars a config value can be. Coercing them to strings
		// here would make a typed field's parse fail downstream on its own value.
		expect(env({ A: "s", B: 7, C: true }).config).toEqual({
			A: "s",
			B: 7,
			C: true,
		});
	});

	it("accepts an empty annotation", () => {
		// A resource with no environment is normal, and refusing it would make
		// the call site conditional.
		expect(env({}).config).toEqual({});
	});

	it("refuses an empty key", () => {
		// An empty environment variable name cannot be exported, and it would be
		// dropped somewhere far from here with nothing recording the loss.
		expect(() => env({ "": "value" })).toThrow(TypeError);
	});

	it("freezes the annotation and its config", () => {
		const annotation = env({ A: "1" });
		expect(Object.isFrozen(annotation)).toBe(true);
		expect(Object.isFrozen(annotation.config)).toBe(true);
	});

	it("copies rather than holding the caller's object", () => {
		// The annotation is built key by key into a fresh record. Holding the
		// caller's object would let a later mutation change a frozen annotation's
		// contents out from under it.
		const config = { A: "1" };
		const annotation = env(config);
		config.A = "2";
		expect(annotation.config.A).toBe("1");
	});

	it("also exposes the typed field builders", () => {
		// The dual surface: `env(...)` is an annotation, `env.string()` is a
		// schema field. A caller reaching for one must not find the other
		// missing, since both are documented as the same import.
		for (const builder of ["string", "boolean", "int", "json"] as const) {
			expect(env[builder]).toBeTypeOf("function");
		}
	});

	it("builds a typed field that names itself", () => {
		const field = env.string("LOG_LEVEL");
		expect(field).toBeDefined();
	});
});

describe("secretRef", () => {
	it("wraps a reference rather than a value", () => {
		// The whole point of the type: what travels is a locator, and the
		// material is fetched by whatever holds custody. A secret ref carrying
		// the secret would put it in every manifest that mentioned it.
		const ref = secretRef("vault://app/db-password");
		expect(JSON.stringify(ref)).not.toContain("password-value");
		expect(String(JSON.stringify(ref))).toContain("vault://app/db-password");
	});
});

describe("the connector registry", () => {
	function definition(id: string) {
		return {
			kind: "connector-definition" as const,
			id,
			origin: "https://example.test",
		};
	}

	it("registers a definition and resolves it back by symbol", () => {
		const symbol = defineConnector(definition("acme.test.roundtrip"));
		expect(connectorDefinition(symbol)).toMatchObject({
			id: "acme.test.roundtrip",
			origin: "https://example.test",
		});
	});

	it("keys the registry on a global symbol, so two copies of the package agree", () => {
		// `Symbol.for`, not `Symbol`. A duplicated package instance in a
		// dependency tree would otherwise register into a registry nobody else
		// reads, and every connector lookup would fail with "unknown symbol"
		// while the package was demonstrably imported.
		const symbol = defineConnector(definition("acme.test.global"));
		expect(symbol).toBe(Symbol.for("hobo.connector/acme.test.global"));
	});

	it("freezes what it stores", () => {
		// The registry is process-wide. A mutated definition would change what
		// every later Bindle resolved.
		const symbol = defineConnector(definition("acme.test.frozen"));
		expect(Object.isFrozen(connectorDefinition(symbol))).toBe(true);
	});

	it("copies the definition rather than storing the caller's object", () => {
		// `{ ...definition }`. Storing the caller's object would let a later edit
		// change a registration that is already frozen from the registry's side.
		// SAFETY: this fixture is narrowed to the connector definition contract.
		const source = definition("acme.test.copied") as {
			kind: "connector-definition";
			id: string;
			origin: string;
		};
		const symbol = defineConnector(source);
		source.origin = "https://mutated.test";
		expect(connectorDefinition(symbol).origin).toBe("https://example.test");
	});

	it("refuses a definition with the wrong kind", () => {
		// The kind discriminates this from every other stamped object a package
		// might export. Registering one would put a non-connector into the
		// registry under a connector symbol.
		// SAFETY: invalid kind fixtures test the parser boundary.
		expect(() =>
			defineConnector({
				...definition("acme.test.kind"),
				kind: "other",
			} as never),
		).toThrow(TypeError);
	});

	it("refuses a definition missing its id or origin", () => {
		// The id becomes the symbol and the origin is what a consumer connects
		// to. Either missing produces a registration nothing can use.
		for (const partial of [
			{ kind: "connector-definition", origin: "https://example.test" },
			{ kind: "connector-definition", id: "a", origin: "" },
			{ kind: "connector-definition", id: "", origin: "https://example.test" },
		]) {
			// SAFETY: partial fixtures test the parser boundary.
			expect(() => defineConnector(partial as never)).toThrow(TypeError);
		}
	});

	it("refuses to resolve a symbol nothing registered, and says why", () => {
		// The message names the actual cause — the defining package was never
		// imported — because the symptom (an unknown symbol) gives no hint that
		// an import is missing.
		try {
			connectorDefinition(
				// SAFETY: an unknown symbol fixture tests the registry boundary.
				Symbol.for("hobo.connector/never.registered") as never,
			);
			expect.unreachable("an unregistered connector must be refused");
		} catch (error) {
			// SAFETY: this catch follows the Error assertion above.
			expect((error as Error).message).toContain("import the package");
		}
	});

	it("lets a re-registration replace an earlier one under the same id", () => {
		// Same id, same symbol, so the second call wins. That is what makes a
		// hot reload work rather than leaving the first definition pinned for
		// the life of the process.
		defineConnector(definition("acme.test.replaced"));
		const second = defineConnector({
			...definition("acme.test.replaced"),
			origin: "https://second.test",
		});
		expect(connectorDefinition(second).origin).toBe("https://second.test");
	});
});
