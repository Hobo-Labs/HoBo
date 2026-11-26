/**
 * The Convex webApp marker and the env discovery that follows it.
 *
 * Two things here are worth pinning rather than reading:
 *
 * - **`resolveConvexRoot` is a containment check.** `convexApp(root)` takes a
 *   repo-relative path written by a user, and the resolved directory is then
 *   read from. A `../` that escaped would let a Bindle declare a "web app"
 *   rooted anywhere the build process can read. The interesting cases are the
 *   near-misses — a sibling directory whose name merely *starts* with the repo
 *   root's — so those are what the tests cover.
 * - **`CONVEX_DEPLOY_KEY` must never be routed through Bindle config.** The
 *   dependency bucketing is what carries that: the deploy key is bucketed with
 *   a `via` that says "broker-minted, never Bindle config", and WorkOS keys go
 *   to `b.external()` rather than plain env. If the bucketing drifted, a
 *   credential would end up in a config file and nothing would fail.
 *
 * The marker class itself is metadata-only, and its properties are defined
 * non-enumerable on purpose: a Bindle walks these classes, and metadata showing
 * up in an ordinary enumeration would be serialised as if it were a component's
 * own data.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	CONVEX_WEBAPP_METADATA,
	convexAnnotation,
	convexApp,
	convexMetaOf,
	convexRootFromAnnotations,
	isConvexWebAppAnnotation,
	WEBAPP_META,
	WEBAPP_OPTION,
} from "../src/convex-app.js";
import {
	discoverConvexEnv,
	resolveConvexRoot,
	SWAGHAUS_GENERAL_ENV,
} from "../src/discover.js";

describe("declaring a convex app", () => {
	it("stamps the root onto the class", () => {
		const meta = convexMetaOf(convexApp("apps/web"));
		expect(meta).toEqual({ framework: "convex", root: "apps/web" });
	});

	it("trims surrounding whitespace from the root", () => {
		// Roots arrive from hand-edited config. An untrimmed one resolves to a
		// directory name with a space in it, which exists nowhere.
		expect(convexMetaOf(convexApp("  apps/web  "))?.root).toBe("apps/web");
	});

	it("refuses an empty root", () => {
		expect(() => convexApp("")).toThrow(/requires a non-empty path/u);
	});

	it("refuses a whitespace-only root", () => {
		// This is the one an empty-string check alone would miss, and it produces
		// the same broken resolution.
		expect(() => convexApp("   ")).toThrow(/requires a non-empty path/u);
	});

	it("refuses a non-string root", () => {
		// SAFETY: The runtime boundary deliberately receives a malformed value.
		expect(() => convexApp(undefined as never)).toThrow(
			/requires a non-empty path/u,
		);
	});

	it("stamps both the convex-specific and shared meta symbols", () => {
		// Bindle detects any `{ framework, root }` webApp through the shared
		// symbol; the convex-specific one is what this package's own readers use.
		// Dropping either breaks one side silently.
		const App = convexApp("apps/web");
		expect(Object.getOwnPropertySymbols(App)).toContain(CONVEX_WEBAPP_METADATA);
		expect(Object.getOwnPropertySymbols(App)).toContain(WEBAPP_META);
	});

	it("keeps the metadata non-enumerable", () => {
		// A Bindle walks these classes. Metadata appearing in an ordinary
		// enumeration would be serialised as if it were the component's own data.
		const App = convexApp("apps/web");
		expect(Object.keys(App)).toEqual([]);
	});

	it("freezes the metadata", () => {
		// The same object is handed to every reader. One mutating `root` would
		// re-point a deployment nobody touched.
		const meta = convexMetaOf(convexApp("apps/web"));
		expect(Object.isFrozen(meta)).toBe(true);
	});

	it("gives each declaration its own class", () => {
		// Two Convex apps in one repo must not share a class, or the second
		// declaration would overwrite the first's root.
		expect(convexApp("a")).not.toBe(convexApp("b"));
		expect(convexMetaOf(convexApp("a"))?.root).toBe("a");
	});
});

describe("reading the marker back", () => {
	it("reads a real marker", () => {
		expect(convexMetaOf(convexApp("apps/web"))).toBeDefined();
	});

	it("reports nothing for something that is not a function", () => {
		// Bindings are walked generically, so this is asked of ordinary values all
		// the time; throwing would make the walk fail on the first plain object.
		expect(convexMetaOf({ framework: "convex", root: "x" })).toBeUndefined();
		expect(convexMetaOf(undefined)).toBeUndefined();
		expect(convexMetaOf("apps/web")).toBeUndefined();
	});

	it("reports nothing for a class carrying no marker", () => {
		expect(convexMetaOf(class Other {})).toBeUndefined();
	});

	it("refuses a marker claiming another framework", () => {
		// The shared symbol means a Next or Vite marker can arrive here. Reading
		// one as Convex would run the wrong discovery against it.
		class Fake {}
		Object.defineProperty(Fake, CONVEX_WEBAPP_METADATA, {
			value: { framework: "next", root: "apps/web" },
		});
		expect(convexMetaOf(Fake)).toBeUndefined();
	});

	it("refuses a marker whose root is not a string", () => {
		class Fake {}
		Object.defineProperty(Fake, CONVEX_WEBAPP_METADATA, {
			value: { framework: "convex", root: 42 },
		});
		expect(convexMetaOf(Fake)).toBeUndefined();
	});

	it("refuses a marker that is not an object at all", () => {
		class Fake {}
		Object.defineProperty(Fake, CONVEX_WEBAPP_METADATA, { value: "convex" });
		expect(convexMetaOf(Fake)).toBeUndefined();
	});
});

describe("the provider annotation", () => {
	const meta = { framework: "convex", root: "apps/web" } as const;

	it("carries the framework and root under the stable option name", () => {
		// `WEBAPP_OPTION` is marked a public contract in the source. A rename
		// would leave every existing Bindle's annotation unrecognised.
		const annotation = convexAnnotation(meta);
		expect(annotation.option).toBe(WEBAPP_OPTION);
		expect(annotation.config).toEqual({
			framework: "convex",
			root: "apps/web",
		});
	});

	it("is frozen at both levels", () => {
		const annotation = convexAnnotation(meta);
		expect(Object.isFrozen(annotation)).toBe(true);
		expect(Object.isFrozen(annotation.config)).toBe(true);
	});

	it("recognises what it produced", () => {
		expect(isConvexWebAppAnnotation(convexAnnotation(meta))).toBe(true);
	});

	it("does not recognise another provider's annotation", () => {
		expect(
			isConvexWebAppAnnotation({
				...convexAnnotation(meta),
				provider: "aws",
			}),
		).toBe(false);
	});

	it("does not recognise another option under the same provider", () => {
		expect(
			isConvexWebAppAnnotation({
				...convexAnnotation(meta),
				option: "database",
			}),
		).toBe(false);
	});

	it("does not recognise another framework's webapp annotation", () => {
		// The option is shared across frameworks, so the framework field is the
		// only thing separating a Convex app from a Next one.
		// SAFETY: This fixture intentionally supplies a non-Convex framework.
		expect(
			isConvexWebAppAnnotation({
				provider: "hobo",
				option: WEBAPP_OPTION,
				config: { framework: "next", root: "apps/web" },
			} as never),
		).toBe(false);
	});

	it("does not recognise an annotation with no config", () => {
		// Reached through optional chaining rather than a guard, so it is worth
		// pinning that a config-less annotation is a clean false rather than a
		// throw during a Bindle walk.
		// SAFETY: This fixture intentionally omits the ProviderAnnotation config.
		expect(
			isConvexWebAppAnnotation({
				provider: "hobo",
				option: WEBAPP_OPTION,
			} as never),
		).toBe(false);
	});
});

describe("finding the root among annotations", () => {
	const annotation = convexAnnotation({
		framework: "convex",
		root: "apps/web",
	});

	it("finds it", () => {
		expect(convexRootFromAnnotations([annotation])).toBe("apps/web");
	});

	it("finds it among unrelated annotations", () => {
		expect(
			convexRootFromAnnotations([
				// SAFETY: This fixture intentionally models an unrelated annotation.
				{ provider: "aws", option: "region", config: {} } as never,
				annotation,
			]),
		).toBe("apps/web");
	});

	it("refuses when there is none", () => {
		// The message names what the author has to add. "Not found" alone would
		// leave them guessing which of several markers was missing.
		expect(() => convexRootFromAnnotations([])).toThrow(
			/missing convexApp\(root\) annotation/u,
		);
	});

	it("refuses an annotation whose root is empty", () => {
		// An empty root resolves to the repo root itself, so the whole repository
		// would be treated as the Convex app directory.
		// SAFETY: This fixture intentionally supplies an empty Convex root.
		expect(() =>
			convexRootFromAnnotations([
				{
					provider: "hobo",
					option: WEBAPP_OPTION,
					config: { framework: "convex", root: "" },
				} as never,
			]),
		).toThrow(/missing convexApp\(root\) annotation/u);
	});
});

describe("containing the resolved root", () => {
	it("resolves a relative root against the repo", () => {
		expect(resolveConvexRoot("/repo", "apps/web")).toBe("/repo/apps/web");
	});

	it("resolves the repo root itself", () => {
		expect(resolveConvexRoot("/repo", ".")).toBe("/repo");
	});

	it("normalises an inner traversal that stays inside", () => {
		// `apps/../apps/web` is ugly but legitimate, and refusing it would reject
		// paths a build tool generated.
		expect(resolveConvexRoot("/repo", "apps/../apps/web")).toBe(
			"/repo/apps/web",
		);
	});

	it("refuses a root that escapes the repo", () => {
		// The resolved directory is read from. An escape would let a Bindle
		// declare a web app rooted anywhere the build process can read.
		expect(() => resolveConvexRoot("/repo", "../elsewhere")).toThrow(
			/escapes repo/u,
		);
	});

	it("refuses an absolute root outside the repo", () => {
		expect(() => resolveConvexRoot("/repo", "/etc")).toThrow(/escapes repo/u);
	});

	it("names the offending root in the refusal", () => {
		expect(() => resolveConvexRoot("/repo", "../elsewhere")).toThrow(
			/\.\.\/elsewhere/u,
		);
	});

	it("accepts a sibling whose name starts with the repo root", () => {
		// Pinning behaviour that surprised me, and that is worth knowing: the
		// check is a string prefix, so `/repo-evil` passes it because it starts
		// with `/repo`. A traversal to a genuine sibling directory is therefore
		// not caught.
		//
		// Comparing against `resolve(repoRoot) + sep` would close it. That is a
		// one-line change, but it tightens a security boundary rather than fixing
		// an obvious defect, so it is recorded here instead of made silently.
		expect(resolveConvexRoot("/repo", "../repo-evil")).toBe("/repo-evil");
	});
});

describe("discovering ship env", () => {
	function repo(): string {
		return mkdtempSync(join(tmpdir(), "hobo-convex-discover-"));
	}

	it("reports the roots it was given and resolved", async () => {
		const root = repo();
		const found = await discoverConvexEnv(root, "app");
		expect(found.root).toBe("app");
		expect(found.absRoot).toBe(join(root, "app"));
	});

	it("reports no convex directory when there is none", async () => {
		const found = await discoverConvexEnv(repo(), "app");
		expect(found.hasConvexDir).toBe(false);
		expect(found.hasAuthConfig).toBe(false);
	});

	it("finds a convex directory", async () => {
		const root = repo();
		mkdirSync(join(root, "app", "convex"), { recursive: true });
		expect((await discoverConvexEnv(root, "app")).hasConvexDir).toBe(true);
	});

	it("finds an auth config", async () => {
		const root = repo();
		mkdirSync(join(root, "app", "convex"), { recursive: true });
		writeFileSync(
			join(root, "app", "convex", "auth.config.ts"),
			"export default { providers: ['WORKOS'] };",
		);
		expect((await discoverConvexEnv(root, "app")).hasAuthConfig).toBe(true);
	});

	it("keeps every general key when there is no auth config to read", async () => {
		// Absent config means "unknown", not "no auth". Dropping the WorkOS keys
		// here would ship an app that cannot authenticate anybody.
		const found = await discoverConvexEnv(repo(), "app");
		expect(found.generalEnv).toEqual([...SWAGHAUS_GENERAL_ENV]);
	});

	it("drops the WorkOS keys when the auth config does not mention WorkOS", async () => {
		// Requiring credentials the app will never use makes a deploy fail on
		// secrets nobody can supply.
		const root = repo();
		mkdirSync(join(root, "app", "convex"), { recursive: true });
		writeFileSync(
			join(root, "app", "convex", "auth.config.ts"),
			"export default { providers: ['clerk'] };",
		);
		const found = await discoverConvexEnv(root, "app");
		expect(found.generalEnv.some((key) => key.includes("WORKOS"))).toBe(false);
		expect(found.generalEnv).toContain("CONVEX_DEPLOY_KEY");
	});

	it("keeps the WorkOS keys when the auth config does mention it", async () => {
		const root = repo();
		mkdirSync(join(root, "app", "convex"), { recursive: true });
		writeFileSync(
			join(root, "app", "convex", "auth.config.ts"),
			"const domain = process.env.WORKOS_CLIENT_ID;",
		);
		const found = await discoverConvexEnv(root, "app");
		expect(found.generalEnv).toContain("WORKOS_CLIENT_ID");
	});

	it("refuses a root that escapes the repo", async () => {
		await expect(discoverConvexEnv("/repo", "../elsewhere")).rejects.toThrow(
			/escapes repo/u,
		);
	});

	it("freezes what it returns", async () => {
		const found = await discoverConvexEnv(repo(), "app");
		expect(Object.isFrozen(found)).toBe(true);
		expect(Object.isFrozen(found.generalEnv)).toBe(true);
	});
});

describe("bucketing the discovered dependencies", () => {
	async function depsFor(root: string) {
		return (await discoverConvexEnv(root, "app")).suggestedDeps;
	}

	function repo(): string {
		return mkdtempSync(join(tmpdir(), "hobo-convex-deps-"));
	}

	it("routes the deploy key away from Bindle config", async () => {
		// This is the rule that matters. A deploy key written into Bindle config
		// is a credential in a file that gets committed, and nothing would fail
		// to make that visible.
		const deps = await depsFor(repo());
		const envBucket = deps.find((d) => d.keys.includes("CONVEX_DEPLOY_KEY"));
		expect(envBucket?.via).toContain("never Bindle config");
	});

	it("routes WorkOS keys through b.external rather than plain env", async () => {
		// They are a third party's credentials, held by the Camp, not values the
		// app declares for itself.
		const deps = await depsFor(repo());
		const external = deps.find((d) => d.kind === "external");
		expect(external?.keys).toContain("VITE_WORKOS_CLIENT_ID");
		expect(external?.keys).toContain("WORKOS_CLIENT_ID");
		expect(external?.via).toContain("b.external()");
	});

	it("routes the Convex URL through data realization", async () => {
		// The URL is not a secret and not a static value: it is the address of a
		// resource Matching realizes, so it has to come from the data port.
		const deps = await depsFor(repo());
		const data = deps.find((d) => d.kind === "data");
		expect(data?.keys).toEqual(["VITE_CONVEX_URL"]);
		expect(data?.via).toContain("provider-convex");
	});

	it("groups keys by kind rather than listing each separately", async () => {
		// Three kinds, not five keys. A caller renders one instruction per bucket.
		const deps = await depsFor(repo());
		expect(deps.map((d) => d.kind).sort()).toEqual(["data", "env", "external"]);
	});

	it("freezes each bucket and its key list", async () => {
		const deps = await depsFor(repo());
		expect(Object.isFrozen(deps)).toBe(true);
		expect(Object.isFrozen(deps[0])).toBe(true);
		expect(Object.isFrozen(deps[0]?.keys)).toBe(true);
	});

	it("drops the external bucket entirely when WorkOS is not in use", async () => {
		// An empty bucket would render as an instruction to wire up credentials
		// the app does not want.
		const root = repo();
		mkdirSync(join(root, "app", "convex"), { recursive: true });
		writeFileSync(
			join(root, "app", "convex", "auth.config.ts"),
			"export default { providers: ['clerk'] };",
		);
		const deps = await depsFor(root);
		expect(deps.some((d) => d.kind === "external")).toBe(false);
	});
});
