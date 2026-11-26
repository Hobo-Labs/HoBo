/**
 * `waspApp(root)` stamps a marker that travels into a Bindle manifest and is
 * read back much later, somewhere else, by code that will resolve it against a
 * real repository and read files under it. That distance is the whole reason
 * the path is parsed at the stamping site rather than at the reading site: by
 * the time anyone resolves it, the context that could have judged it is gone.
 *
 * So the interesting behaviour here is refusal. A traversal sequence, an
 * absolute path, or a backslash that survives into the manifest becomes a file
 * read outside the repository later on, and at that point it looks like a
 * legitimate declared root rather than an injection.
 *
 * The rest is the marker's shape: three symbol-keyed properties that different
 * consumers read, none enumerable, so a manifest serialiser cannot accidentally
 * publish them.
 */
import { describe, expect, test } from "vitest";
import { WaspInputRejectedError } from "../src/parse.js";
import {
	isWaspWebAppAnnotation,
	WASP_WEBAPP_METADATA,
	WEBAPP_META,
	WEBAPP_OPTION,
	waspAnnotation,
	waspApp,
	waspMetaOf,
	waspRootFromAnnotations,
} from "../src/wasp-app.js";

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "<did not throw>";
}

describe("waspApp refuses a root it cannot vouch for", () => {
	test("a traversal sequence is refused at the stamping site", () => {
		// This is the point of parsing here. `../../etc` inside a manifest is
		// indistinguishable from a real root by the time something reads files
		// under it.
		expect(messageOf(() => waspApp("../../etc"))).toContain("traversal");
	});

	test("a traversal buried mid-path is refused too", () => {
		expect(messageOf(() => waspApp("apps/../../etc"))).toContain("traversal");
	});

	test("an absolute path is refused", () => {
		// An absolute root ignores the repo entirely; whatever it names is read
		// regardless of where the manifest was checked out.
		expect(messageOf(() => waspApp("/etc/passwd"))).toContain("traversal");
	});

	test("an empty or whitespace root is refused", () => {
		// An empty root resolves to the repository itself, handing a web Kit the
		// whole tree.
		for (const root of ["", "   ", "\t"]) {
			expect(messageOf(() => waspApp(root))).toContain("non-empty");
		}
	});

	test("a non-string root is refused", () => {
		for (const root of [undefined, null, 42, {}]) {
			expect(messageOf(() => waspApp(root as unknown as string))).toContain(
				"non-empty",
			);
		}
	});

	test("a path with characters outside the allowed set is refused", () => {
		// The allow-list is narrow on purpose: a root is a directory name, and
		// anything needing quoting is more likely an injection than a directory.
		for (const root of [
			"apps/my app",
			"apps/$(whoami)",
			"apps/a;b",
			"apps/a|b",
		]) {
			expect(messageOf(() => waspApp(root))).toContain("traversal");
		}
	});

	test("the refusal names the field and the offending value", () => {
		// A rejection a developer cannot map back to their own input is a
		// rejection they will work around rather than fix.
		const message = messageOf(() => waspApp("../evil"));
		expect(message).toContain("root");
		expect(message).toContain("../evil");
	});

	test("the refusal is the package's own typed error", () => {
		// Callers distinguish "this input was rejected" from "something else went
		// wrong"; a bare Error would collapse the two.
		let caught: unknown;
		try {
			waspApp("../evil");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WaspInputRejectedError);
		expect((caught as WaspInputRejectedError).field).toBe("root");
	});
});

describe("waspApp accepts and normalises a real root", () => {
	test("a simple relative root is kept", () => {
		expect(waspMetaOf(waspApp("apps/web"))?.root).toBe("apps/web");
	});

	test("a single-segment root is kept", () => {
		expect(waspMetaOf(waspApp("web"))?.root).toBe("web");
	});

	test("surrounding whitespace is trimmed", () => {
		// Trailing whitespace from a copied path would otherwise become part of
		// the directory name and fail to resolve later, far from the typo.
		expect(waspMetaOf(waspApp("  apps/web  "))?.root).toBe("apps/web");
	});

	test("dots, dashes and underscores are allowed in a segment", () => {
		expect(waspMetaOf(waspApp("apps/my-app_v2.0"))?.root).toBe(
			"apps/my-app_v2.0",
		);
	});

	test("the framework is always wasp", () => {
		expect(waspMetaOf(waspApp("apps/web"))?.framework).toBe("wasp");
	});

	test("the meta is frozen", () => {
		// The same object is read by several consumers; a mutable one would let
		// the first of them change what the rest see.
		const meta = waspMetaOf(waspApp("apps/web"));
		expect(Object.isFrozen(meta)).toBe(true);
	});
});

describe("the stamped marker", () => {
	test("both metadata symbols carry the same meta", () => {
		// One is Wasp-specific, the other is the generic webApp symbol Bindle
		// reads for any framework. They have to agree or a Bindle detects a
		// webApp whose root differs from the one Wasp recorded.
		const App = waspApp("apps/web");
		const specific = (App as unknown as Record<symbol, unknown>)[
			WASP_WEBAPP_METADATA
		];
		const generic = (App as unknown as Record<symbol, unknown>)[WEBAPP_META];
		expect(specific).toEqual(generic);
	});

	test("the metadata properties are not enumerable", () => {
		// A manifest serialiser walks own keys; an enumerable marker would be
		// published into output that is meant to carry declarations, not
		// internals.
		const App = waspApp("apps/web");
		for (const symbol of [WASP_WEBAPP_METADATA, WEBAPP_META]) {
			const descriptor = Object.getOwnPropertyDescriptor(App, symbol);
			expect(descriptor?.enumerable).toBe(false);
		}
	});

	test("the returned value is constructible", () => {
		// It is declared as a component class; a plain object would fail wherever
		// the runtime instantiates it.
		const App = waspApp("apps/web");
		expect(() => new App()).not.toThrow();
	});

	test("two apps with different roots do not share a marker", () => {
		expect(waspMetaOf(waspApp("apps/a"))?.root).toBe("apps/a");
		expect(waspMetaOf(waspApp("apps/b"))?.root).toBe("apps/b");
	});
});

describe("waspMetaOf", () => {
	test("it reads back the meta from a stamped class", () => {
		expect(waspMetaOf(waspApp("apps/web"))).toEqual({
			framework: "wasp",
			root: "apps/web",
		});
	});

	test("a non-function is not a marker", () => {
		// The marker lives on a class. Anything else — a config object, a string
		// — is simply not one, and must answer so rather than throwing.
		for (const value of [undefined, null, 42, "apps/web", {}, []]) {
			expect(waspMetaOf(value)).toBeUndefined();
		}
	});

	test("an unstamped function is not a marker", () => {
		expect(waspMetaOf(() => undefined)).toBeUndefined();
		expect(waspMetaOf(class Plain {})).toBeUndefined();
	});
});

describe("annotations", () => {
	test("an annotation carries the framework and root under the webapp option", () => {
		const annotation = waspAnnotation({ framework: "wasp", root: "apps/web" });
		expect(annotation.provider).toBe("hobo");
		expect(annotation.option).toBe(WEBAPP_OPTION);
		expect(annotation.config).toEqual({
			framework: "wasp",
			root: "apps/web",
		});
	});

	test("the annotation and its config are frozen", () => {
		const annotation = waspAnnotation({ framework: "wasp", root: "apps/web" });
		expect(Object.isFrozen(annotation)).toBe(true);
		expect(Object.isFrozen(annotation.config)).toBe(true);
	});

	test("a well-formed annotation is recognised", () => {
		expect(
			isWaspWebAppAnnotation(
				waspAnnotation({ framework: "wasp", root: "apps/web" }),
			),
		).toBe(true);
	});

	test("another provider's annotation answers false rather than throwing", () => {
		// A Bindle carries annotations from many packages. Throwing on somebody
		// else's would make this package's presence break unrelated ones.
		expect(
			isWaspWebAppAnnotation({
				provider: "vercel",
				option: "webapp",
				config: {},
			} as never),
		).toBe(false);
	});

	test("a different option under the same provider answers false", () => {
		expect(
			isWaspWebAppAnnotation({
				provider: "hobo",
				option: "something-else",
				config: {},
			} as never),
		).toBe(false);
	});

	test("a malformed Wasp annotation is a rejection, not a no", () => {
		// The distinction the source calls out: an annotation that claims to be
		// this package's but carries a bad root is a problem to report, not
		// something to skip past.
		expect(() =>
			isWaspWebAppAnnotation({
				provider: "hobo",
				option: WEBAPP_OPTION,
				config: { framework: "wasp", root: "../../etc" },
			} as never),
		).toThrow(WaspInputRejectedError);
	});
});

describe("waspRootFromAnnotations", () => {
	test("it finds the root among unrelated annotations", () => {
		const root = waspRootFromAnnotations([
			{ provider: "vercel", option: "edge", config: {} } as never,
			waspAnnotation({ framework: "wasp", root: "apps/web" }),
			{ provider: "hobo", option: "other", config: {} } as never,
		]);
		expect(root).toBe("apps/web");
	});

	test("the first matching annotation wins", () => {
		const root = waspRootFromAnnotations([
			waspAnnotation({ framework: "wasp", root: "apps/first" }),
			waspAnnotation({ framework: "wasp", root: "apps/second" }),
		]);
		expect(root).toBe("apps/first");
	});

	test("no annotation at all is an error naming what is missing", () => {
		// A web Kit with no root cannot be built; the message has to say which
		// declaration is absent rather than failing later on a missing directory.
		expect(messageOf(() => waspRootFromAnnotations([]))).toContain(
			"waspApp(root)",
		);
	});

	test("only unrelated annotations is also an error", () => {
		expect(
			messageOf(() =>
				waspRootFromAnnotations([
					{ provider: "vercel", option: "edge", config: {} } as never,
				]),
			),
		).toContain("waspApp(root)");
	});

	test("a malformed root among the annotations is refused, not skipped", () => {
		// Skipping it would silently fall through to a later annotation — or to
		// the "missing" error — and hide the fact that a declaration was wrong.
		expect(() =>
			waspRootFromAnnotations([
				{
					provider: "hobo",
					option: WEBAPP_OPTION,
					config: { framework: "wasp", root: "../escape" },
				} as never,
			]),
		).toThrow(WaspInputRejectedError);
	});

	test("a root that survives the round trip is the one that was stamped", () => {
		// The end-to-end property: what `waspApp` recorded is what a consumer
		// reading the manifest gets back.
		const meta = waspMetaOf(waspApp("  apps/web  "));
		if (!meta) throw new Error("expected meta");
		expect(waspRootFromAnnotations([waspAnnotation(meta)])).toBe("apps/web");
	});
});
