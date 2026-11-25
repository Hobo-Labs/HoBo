/**
 * Coverage lane. Deliberately separate from `vitest.config.ts`, which keeps
 * `coverage: { enabled: false }` so the ordinary test lanes stay fast.
 *
 * Scoped to first-party package sources. The root config's default discovery
 * also sweeps in `external/` (vendored projects that are not ours),
 * `src/draft/` (proof material with its own gates), `site/`, and generated
 * `.optimizexp/` feature suites — measuring those as if they were HoBo package
 * coverage would report a number that means nothing.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve every workspace package to its `src` entrypoint for the coverage lane.
 *
 * Without this the reported number is badly wrong — understated, not inflated.
 * Workspace packages publish `exports` pointing at `dist/`, so a cross-package
 * import executes the built JavaScript. Coverage instruments `src/**` with
 * `all: true`, which loads every un-executed source file to give it a zero
 * baseline. A file whose logic ran *via dist* never merges with its `src` entry,
 * so it lands in that zero baseline and reports ~0% despite being exercised.
 *
 * Measured on `packages/testing`: **47.2% without this alias map, 91.0% with
 * it** — identical tests, identical 142 passing assertions. `pact-chaos.ts`
 * alone went 0.7% → 92.8%.
 *
 * This matters beyond a nicer number: chasing the un-aliased figure would mean
 * writing duplicate tests for code that is already covered, which is worse than
 * doing nothing.
 *
 * Only the bare specifier is aliased, and it is matched with an anchored regex
 * rather than a string. A string alias in Vite is a *prefix* match, so
 * `"@hobo/core"` also swallows `@hobo/core/total-access` and rewrites it to
 * `packages/core/src/index.ts/total-access` — that mistake failed 301 test
 * files here before the anchor was added. Subpath imports must keep resolving
 * through the package's own `exports` map, because mapping a subpath to a
 * source file is the package's business, not this config's.
 */
function workspaceSrcAliases(): { find: RegExp; replacement: string }[] {
	const aliases: { find: RegExp; replacement: string }[] = [];
	const roots = [path.join(root, "packages")];
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir === undefined) {
			continue;
		}
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		if (entries.includes("package.json")) {
			const manifest = path.join(dir, "package.json");
			let name: string | undefined;
			try {
				name = JSON.parse(readFileSync(manifest, "utf8")).name;
			} catch {
				name = undefined;
			}
			const entry = ["src/index.ts", "src/index.tsx"]
				.map((candidate) => path.join(dir, candidate))
				.find((candidate) => existsSync(candidate));
			if (name?.startsWith("@hobo/") && entry !== undefined)
				aliases.push({
					find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
					replacement: entry,
				});
			continue;
		}
		for (const entry of entries)
			if (!entry.startsWith(".") && entry !== "node_modules")
				roots.push(path.join(dir, entry));
	}
	return aliases;
}

export default defineConfig({
	resolve: { alias: workspaceSrcAliases() },
	test: {
		environment: "node",
		/**
		 * Isolated, unlike the fast lanes. `isolate: false` was a speed
		 * optimization, and in this lane it bought nondeterminism: two
		 * consecutive full runs of the same commit produced 253 and then 66
		 * failures, with cross-file pathologies like one test fetching another
		 * test file's server out of the shared module registry. A measurement
		 * lane whose failure set is a coin flip corrupts both signals it exists
		 * to produce — the failures are noise, and every flaked file's source
		 * drags the coverage number it was supposed to certify. Package-scoped
		 * runs pass with and without isolation, so the sharing only ever paid
		 * at full scale, which is exactly where it broke. The ordinary lanes
		 * keep their speed; this one buys back determinism.
		 */
		isolate: true,
		fileParallelism: true,
		pool: "threads",
		globalSetup: [
			// The run's root of throwaway HOBO_HOMEs (test/setup/hobo-test-homes.ts).
			fileURLToPath(new URL("./test/setup/hobo-test-homes.ts", import.meta.url)),
			fileURLToPath(
				new URL(
					"./packages/runtimes/runtime-wasm/test/wasmtime-global-setup.ts",
					import.meta.url,
				),
			),
		],
		// Every test file gets a throwaway HOBO_HOME, so a test that omits an
		// explicit one cannot write into the developer's real ~/.hobo -- and, for
		// this lane especially, cannot *read* state an earlier file left there.
		// See test/setup/isolate-hobo-home.ts for the incident that prompted it: a
		// clean run left 33 files under ~/.hobo/durable, including an auth session
		// written by a test whose whole assertion was that `auth --help` prints a
		// help page.
		//
		// Even isolated, files race through one real ~/.hobo unless each gets
		// its own -- and, until this line came back, this was the only lane
		// without the guard.
		setupFiles: [
			fileURLToPath(new URL("./test/setup/isolate-hobo-home.ts", import.meta.url)),
		],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		reporters: ["dot"],
		include: ["packages/**/test/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.optimizexp/**",
			// Live lanes: these fail by design when their binary or toolchain is
			// absent, which is a deliberate "no silent skip" policy, not coverage.
			"**/test/live-*.test.ts",
			"**/*.integration.test.ts",
			// Asserts that a bindle importing an *uninstalled* workspace package
			// surfaces BindleImportError rather than a confusing "no bindle". Its
			// premise is a module that cannot resolve, and this lane's alias map
			// (above) deliberately makes every workspace package resolvable from
			// anywhere — so the import succeeds and the expected throw never
			// happens. Excluded here only; it runs in every other lane, which is
			// where that behaviour actually needs proving.
			"packages/cli/test/loader.test.ts",
		],
		coverage: {
			enabled: true,
			provider: "v8",
			all: true,
			include: ["packages/*/src/**/*.ts", "packages/*/*/src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/dist/**",
				"**/node_modules/**",
				"**/*.d.ts",
				"**/_generated/**",
			],
			reporter: ["text-summary", "json-summary"],
			/**
			 * Write the report even when tests fail.
			 *
			 * The default is `false`, which means a single failing test anywhere in
			 * the workspace suppresses the coverage report entirely -- not the
			 * thresholds, the *report*. That is backwards for a ratchet: the moment
			 * you most need to know where coverage stands is when something is
			 * broken, and a lane that answers "no number" is indistinguishable from
			 * one that was never run.
			 *
			 * It cost this campaign five full runs, each ~25 minutes, that produced
			 * no summary at all. The thresholds below still fail the build; this
			 * only stops the measurement being thrown away with it.
			 */
			reportOnFailure: true,
			reportsDirectory: "./.coverage",
			/**
			 * A ratchet, not a target.
			 *
			 * Measured 2026-08-20 with the workspace src alias map above in place:
			 * statements 80.00%, branches 67.83%, functions 84.80%, lines 81.40%.
			 *
			 * Where those points came from, in order:
			 *   77.74 / 65.84 / 82.27 / 79.12  starting point
			 *   79.57 / 67.29 / 84.50 / 80.96  after the alias map — same tests,
			 *                                  corrected attribution, no new assertions
			 *   80.00 / 67.83 / 84.80 / 81.40  after new suites for genuinely
			 *                                  untested modules (layout-model,
			 *                                  netbird-api, ci-guard parse/
			 *                                  fixture-runner/workflows)
			 *
			 * Re-measured 2026-08-25 under the isolated lane (isolate: true, see
			 * above): statements 89.40%, branches 81.90%, functions 91.60%, lines
			 * 90.41%. Every repo-wide metric now clears the 80% goal, branches
			 * included; the floors below are re-baselined to that run.
			 *
			 * Set at the measured line rather than at the goal deliberately, for the
			 * reason the Stryker configs already give: a gate nobody can pass gets
			 * deleted, not met. Raise each number as the real one improves; never
			 * lower one to make a red build green.
			 *
			 * The remaining sub-80 package is runtime-wasm (shells out to
			 * jco/wasmtime) — it needs a harness, not more of the same tests.
			 */
			thresholds: {
				statements: 87,
				branches: 79,
				functions: 89,
				lines: 88,

				/**
				 * Per-package floors, so the repo-wide aggregate cannot hide a
				 * package sitting at 40%.
				 *
				 * Without these, adding well-covered code to a healthy package
				 * offsets a regression in a weak one and the single global number
				 * never moves. Each floor is that package's own measured coverage
				 * under the isolated lane on 2026-08-25, minus two points -- enough
				 * slack to absorb harmless churn, tight enough to catch a real drop.
				 *
				 * The 2026-08-25 re-baseline moved twelve metrics *down* (adapters,
				 * ci-guard, dispatcher, kv-redis-compatible and packs functions;
				 * manifest-plan statements/branches/lines; mcp branches; yards
				 * statements/functions/lines). Those floors were set from the
				 * shared-state lane, where files inherited coverage from modules
				 * other test files had loaded into the same worker; isolate: true
				 * attributes coverage to what each file actually exercises. This is
				 * a recalibration of the instrument, not a shed -- the same tests
				 * assert the same behaviour.
				 *
				 * These are a ratchet, not a target. The goal remains 80% on every
				 * metric everywhere; the floors below record where each package
				 * actually stands so the climb is monotonic. Raise one when its real
				 * number improves. Never lower one to make a red build green -- if a
				 * package genuinely needs to shed coverage, that is a conversation,
				 * not a config edit.
				 *
				 * Packages under 50 statements are not gated: the percentages swing
				 * too far on a single line to mean anything.
				 */
				"packages/adapters/**": { statements: 87, branches: 85, functions: 84, lines: 89 },
				"packages/auth-md/**": { statements: 85, branches: 79, functions: 81, lines: 86 },
				"packages/bindings/**": { statements: 94, branches: 89, functions: 95, lines: 94 },
				"packages/bindles/**": { statements: 85, branches: 79, functions: 88, lines: 85 },
				"packages/broker/**": { statements: 85, branches: 79, functions: 89, lines: 86 },
				"packages/camps/**": { statements: 97, branches: 96, functions: 98, lines: 98 },
				"packages/capability-matrix/**": { statements: 95, branches: 81, functions: 95, lines: 97 },
				"packages/capability-profiles/**": { statements: 92, branches: 84, functions: 98, lines: 93 },
				"packages/ci-guard/**": { statements: 91, branches: 88, functions: 90, lines: 91 },
				"packages/claims/**": { statements: 87, branches: 81, functions: 96, lines: 90 },
				"packages/cli/**": { statements: 89, branches: 79, functions: 93, lines: 89 },
				"packages/cloud/**": { statements: 90, branches: 79, functions: 92, lines: 91 },
				"packages/componentize/**": { statements: 91, branches: 83, functions: 93, lines: 91 },
				"packages/conformance/**": { statements: 89, branches: 78, functions: 92, lines: 89 },
				"packages/connectivity/**": { statements: 85, branches: 78, functions: 87, lines: 87 },
				"packages/connectors/**": { statements: 88, branches: 80, functions: 88, lines: 88 },
				"packages/contract-harness/**": { statements: 86, branches: 85, functions: 98, lines: 85 },
				"packages/contracts/**": { statements: 87, branches: 79, functions: 86, lines: 87 },
				"packages/control-api/**": { statements: 94, branches: 89, functions: 98, lines: 94 },
				"packages/control-yard/**": { statements: 91, branches: 85, functions: 89, lines: 91 },
				"packages/convex/**": { statements: 98, branches: 94, functions: 98, lines: 98 },
				"packages/core/**": { statements: 91, branches: 83, functions: 95, lines: 91 },
				"packages/data/**": { statements: 89, branches: 84, functions: 83, lines: 91 },
				"packages/data-postgres/**": { statements: 94, branches: 92, functions: 95, lines: 94 },
				"packages/dispatcher/**": { statements: 92, branches: 85, functions: 89, lines: 92 },
				"packages/evals/**": { statements: 90, branches: 89, functions: 94, lines: 91 },
				"packages/events/**": { statements: 90, branches: 80, functions: 87, lines: 92 },
				"packages/fuzz/**": { statements: 89, branches: 78, functions: 92, lines: 91 },
				"packages/hobo/**": { statements: 87, branches: 78, functions: 88, lines: 88 },
				"packages/iac/**": { statements: 84, branches: 80, functions: 88, lines: 84 },
				"packages/identity/**": { statements: 88, branches: 79, functions: 90, lines: 89 },
				"packages/junctions/**": { statements: 95, branches: 90, functions: 98, lines: 95 },
				"packages/kv-redis-compatible/**": { statements: 86, branches: 78, functions: 80, lines: 92 },
				"packages/management/**": { statements: 97, branches: 87, functions: 94, lines: 96 },
				"packages/manifest-capability/**": { statements: 93, branches: 89, functions: 96, lines: 93 },
				"packages/manifest-declaration/**": { statements: 96, branches: 94, functions: 98, lines: 96 },
				"packages/manifest-plan/**": { statements: 88, branches: 84, functions: 98, lines: 92 },
				"packages/manifest-request/**": { statements: 96, branches: 92, functions: 98, lines: 96 },
				"packages/manifest-round-trip/**": { statements: 94, branches: 91, functions: 98, lines: 98 },
				"packages/mcp/**": { statements: 95, branches: 82, functions: 96, lines: 97 },
				"packages/packs/**": { statements: 83, branches: 80, functions: 85, lines: 83 },
				"packages/patterns/**": { statements: 88, branches: 80, functions: 93, lines: 89 },
				"packages/policy/**": { statements: 92, branches: 92, functions: 91, lines: 92 },
				"packages/providers/provider-aws/**": { statements: 91, branches: 79, functions: 96, lines: 91 },
				"packages/providers/provider-ax/**": { statements: 95, branches: 79, functions: 98, lines: 98 },
				"packages/providers/provider-azure/**": { statements: 91, branches: 78, functions: 97, lines: 92 },
				"packages/providers/provider-browser-wasm/**": { statements: 83, branches: 79, functions: 91, lines: 84 },
				"packages/providers/provider-cloudflare/**": { statements: 89, branches: 79, functions: 92, lines: 90 },
				"packages/providers/provider-convex/**": { statements: 87, branches: 78, functions: 93, lines: 87 },
				"packages/providers/provider-digitalocean/**": { statements: 90, branches: 78, functions: 96, lines: 91 },
				"packages/providers/provider-flux/**": { statements: 96, branches: 96, functions: 98, lines: 96 },
				"packages/providers/provider-gcp/**": { statements: 89, branches: 78, functions: 94, lines: 90 },
				"packages/providers/provider-hetzner/**": { statements: 93, branches: 80, functions: 95, lines: 93 },
				"packages/providers/provider-hostinger/**": { statements: 88, branches: 78, functions: 95, lines: 89 },
				"packages/providers/provider-kafka/**": { statements: 87, branches: 81, functions: 91, lines: 88 },
				"packages/providers/provider-kubernetes/**": { statements: 87, branches: 79, functions: 94, lines: 88 },
				"packages/providers/provider-lakebed/**": { statements: 85, branches: 84, functions: 80, lines: 85 },
				"packages/providers/provider-neon/**": { statements: 87, branches: 78, functions: 93, lines: 88 },
				"packages/providers/provider-netlify/**": { statements: 83, branches: 78, functions: 81, lines: 83 },
				"packages/providers/provider-prisma-postgres/**": { statements: 90, branches: 81, functions: 96, lines: 90 },
				"packages/providers/provider-railway/**": { statements: 97, branches: 96, functions: 98, lines: 96 },
				"packages/providers/provider-ttl-sh/**": { statements: 91, branches: 87, functions: 91, lines: 91 },
				"packages/providers/provider-upstash/**": { statements: 87, branches: 78, functions: 90, lines: 88 },
				"packages/providers/provider-vercel/**": { statements: 87, branches: 79, functions: 89, lines: 88 },
				"packages/providers/provider-webernetes/**": { statements: 92, branches: 89, functions: 90, lines: 94 },
				"packages/providers/runner-blacksmith/**": { statements: 88, branches: 79, functions: 98, lines: 88 },
				"packages/providers/runner-depot/**": { statements: 93, branches: 87, functions: 94, lines: 93 },
				"packages/providers/runner-github/**": { statements: 87, branches: 82, functions: 87, lines: 87 },
				"packages/recipes/**": { statements: 89, branches: 82, functions: 95, lines: 90 },
				"packages/registry/**": { statements: 93, branches: 87, functions: 98, lines: 94 },
				"packages/replay/**": { statements: 86, branches: 80, functions: 82, lines: 88 },
				"packages/rift/**": { statements: 86, branches: 82, functions: 81, lines: 88 },
				"packages/runtime/**": { statements: 86, branches: 78, functions: 85, lines: 86 },
				"packages/runtimes/**": { statements: 86, branches: 83, functions: 87, lines: 87 },
				"packages/schema-tools/**": { statements: 88, branches: 83, functions: 92, lines: 90 },
				"packages/sdk/**": { statements: 96, branches: 89, functions: 98, lines: 96 },
				"packages/stage-gate/**": { statements: 86, branches: 89, functions: 89, lines: 86 },
				"packages/stations/**": { statements: 91, branches: 85, functions: 94, lines: 91 },
				"packages/status-page/**": { statements: 92, branches: 82, functions: 91, lines: 93 },
				"packages/storage-sqlite/**": { statements: 90, branches: 82, functions: 94, lines: 91 },
				"packages/testing/**": { statements: 89, branches: 81, functions: 94, lines: 91 },
				"packages/trails/**": { statements: 86, branches: 78, functions: 91, lines: 87 },
				"packages/training/**": { statements: 93, branches: 83, functions: 98, lines: 96 },
				"packages/training-pipeline/**": { statements: 92, branches: 85, functions: 94, lines: 93 },
				"packages/trust/**": { statements: 89, branches: 87, functions: 87, lines: 89 },
				"packages/wasp/**": { statements: 88, branches: 81, functions: 93, lines: 90 },
				"packages/wit/**": { statements: 89, branches: 82, functions: 92, lines: 89 },
				"packages/yard-world/**": { statements: 91, branches: 81, functions: 98, lines: 93 },
				"packages/yards/**": { statements: 83, branches: 84, functions: 78, lines: 83 },
			},
		},
	},
});
