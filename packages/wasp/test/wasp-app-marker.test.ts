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
		expect(messageOf(() => waspApp("../../etc"))).toContain("traversal");
	});

	test("a traversal buried mid-path is refused too", () => {
		expect(messageOf(() => waspApp("apps/../../etc"))).toContain("traversal");
	});

	test("an absolute path is refused", () => {
		expect(messageOf(() => waspApp("/etc/passwd"))).toContain("traversal");
	});

	test("an empty or whitespace root is refused", () => {
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
		const message = messageOf(() => waspApp("../evil"));
		expect(message).toContain("root");
		expect(message).toContain("../evil");
	});

	test("the refusal is the package's own typed error", () => {
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
		const meta = waspMetaOf(waspApp("apps/web"));
		expect(Object.isFrozen(meta)).toBe(true);
	});
});

describe("the stamped marker", () => {
	test("both metadata symbols carry the same meta", () => {
		const App = waspApp("apps/web");
		const specific = (App as unknown as Record<symbol, unknown>)[
			WASP_WEBAPP_METADATA
		];
		const generic = (App as unknown as Record<symbol, unknown>)[WEBAPP_META];
		expect(specific).toEqual(generic);
	});

	test("the metadata properties are not enumerable", () => {
		const App = waspApp("apps/web");
		for (const symbol of [WASP_WEBAPP_METADATA, WEBAPP_META]) {
			const descriptor = Object.getOwnPropertyDescriptor(App, symbol);
			expect(descriptor?.enumerable).toBe(false);
		}
	});

	test("the returned value is constructible", () => {
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
		const meta = waspMetaOf(waspApp("  apps/web  "));
		if (!meta) throw new Error("expected meta");
		expect(waspRootFromAnnotations([waspAnnotation(meta)])).toBe("apps/web");
	});
});
