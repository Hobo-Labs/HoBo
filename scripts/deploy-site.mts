/**
 * Publish `site/` to the `gh-pages` branch.
 *
 * GitHub Pages for this repo serves the **`gh-pages` branch at `/`** (legacy
 * build type, https://tyler-r-kendrick.github.io/HoBo/). There was no script
 * for it: the previous deploy was made by hand, which is why the live site sat
 * on a stale commit long after `main` moved — nothing recorded how to redo it,
 * so nobody did.
 *
 * HoBo delivers its own site through HoBo CD: the exact tree is recorded as
 * release Freight (a `hobo.static-site-tree/v1` index plus its file blobs in
 * the CD artifact store) and promoted hobo-release/pages-candidate ->
 * hobo-release/pages-stable through `hobo deploy`
 * (scripts/ci/create-github-release.mts). The candidate Camp's realizer,
 * @hobo/provider-github, publishes it: missing blobs, the tree (whose id it
 * computed before uploading), and one commit on gh-pages whose parent is the
 * observed head (a compare-and-swap ref move, never a force push), named
 * `deploy: <source sha>` so the freshness gate reads it back. Stable
 * re-observes the same tree live. GITHUB_TOKEN (contents: write) is the
 * credential the Camp declares (`env://GITHUB_TOKEN`).
 *
 * Usage:
 *   pnpm run site:deploy              # build, then publish (GITHUB_TOKEN)
 *   pnpm run site:deploy -- --dry-run # build and show what would publish
 *   node scripts/deploy-site.mts --release-freight <dir>  # record, promote, publish
 *     (the release workflow; HOBO_RELEASE_CD_HOME, HOBO_RELEASE_REVISION)
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	promoteReleaseStable,
	qualifyReleaseCandidate,
	type ReleaseCdSeams,
	releaseSource,
	siteTree,
} from "./ci/create-github-release.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SITE_DIR = join(REPO_ROOT, "site");
const DIST_DIR = join(SITE_DIR, "dist");
const MEDIA_DIR = join(REPO_ROOT, "media");
const MEDIA_DIST = join(MEDIA_DIR, "dist");
/** Where the art catalogue is nested inside the published tree. */
const MEDIA_SUBPATH = "media";
const BRANCH = "gh-pages";

const dryRun = process.argv.includes("--dry-run");

function run(cmd: string, args: readonly string[], cwd = REPO_ROOT): string {
	return execFileSync(cmd, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function git(args: readonly string[], cwd = REPO_ROOT): string {
	return run("git", args, cwd).trim();
}

/** Refuse to publish a tree that does not match a recorded commit. */
function assertClean(): string {
	const dirty = git(["status", "--porcelain", "--", "site", "media"]);
	if (dirty.length > 0) {
		throw new Error(
			`site/ or media/ has uncommitted changes; publish only what is committed so the deploy commit's "@ <sha>" is true:\n${dirty}`,
		);
	}
	return git(["rev-parse", "HEAD"]);
}

function build(): void {
	// The Examples catalog build imports workspace packages (@hobo/bindles,
	// @hobo/wasp, …) through their built dist/, so a fresh clone must compile
	// them first — otherwise `prebuild` dies on the first example app.
	console.log("building site workspace dependencies…");
	execFileSync(
		"pnpm",
		[
			"exec",
			"turbo",
			"run",
			"build",
			"--filter",
			"hobo-site^...",
			"--concurrency=100%",
		],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
	console.log("building site…");
	execFileSync("pnpm", ["run", "build"], { cwd: SITE_DIR, stdio: "inherit" });
	if (!existsSync(DIST_DIR) || readdirSync(DIST_DIR).length === 0) {
		throw new Error(`build produced no output at ${DIST_DIR}`);
	}

	// The art catalogue publishes as a subdirectory of the same Pages origin
	// rather than a second deploy, so one commit always describes the whole
	// published tree. Its base is /HoBo/media/, which has to agree with
	// MEDIA_SUBPATH or every asset 404s.
	console.log("building media catalogue…");
	execFileSync("pnpm", ["run", "build"], { cwd: MEDIA_DIR, stdio: "inherit" });
	if (!existsSync(MEDIA_DIST) || readdirSync(MEDIA_DIST).length === 0) {
		throw new Error(`media build produced no output at ${MEDIA_DIST}`);
	}

	// Gate the publish on the artifact actually working as deployed: serve
	// dist/ statically (what Pages does) and drive the Examples console
	// end-to-end in a real browser. Skippable only explicitly.
	if (process.env.HOBO_SKIP_DIST_VERIFY === "1") {
		console.log("skipping dist verification (HOBO_SKIP_DIST_VERIFY=1)…");
	} else {
		console.log("verifying built site (examples run as deployed)…");
		execFileSync("pnpm", ["run", "examples:verify-dist"], {
			cwd: SITE_DIR,
			stdio: "inherit",
		});
		// The landing page's trail fills one screen per stop: check every stop
		// still reads at laptop sizes and on a phone before it ships.
		console.log("verifying built site (the landing trail at every size)…");
		execFileSync("pnpm", ["run", "landing:verify-dist"], {
			cwd: SITE_DIR,
			stdio: "inherit",
		});
	}
}

/**
 * Record the tree as `hobo-release-pages` Freight and promote it
 * candidate -> stable; the candidate Camp's realizer publishes gh-pages.
 * Throws unless both qualify.
 */
export async function qualifySiteRelease(input: {
	readonly dist: string;
	readonly home: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly seams?: ReleaseCdSeams;
}): Promise<void> {
	const env = input.env ?? process.env;
	const tree = siteTree(input.dist);
	if (tree.files.length === 0)
		throw new Error(`${input.dist} holds no files to publish`);
	await qualifyReleaseCandidate({
		home: input.home,
		family: "pages",
		env,
		stored: [
			{
				name: "site",
				kind: "ARTIFACT_KIND_STATIC_ASSETS",
				mediaType: "application/vnd.hobo.static-site-tree+json",
				bytes: tree.index,
			},
		],
		blobs: tree.files.map((file) => file.bytes),
		// The freshness gate (check-release-pages-stale) reads this back.
		labels: {
			"hobo.cd/github.commit-message": `deploy: ${releaseSource(env).commit}`,
		},
		...(input.seams ? { seams: input.seams } : undefined),
	});
	if (!(await promoteReleaseStable(input.home, env, input.seams)))
		throw new Error(
			"release Freight pages blocked at hobo-release/pages-stable",
		);
}

function releaseCdHome(): string {
	return (
		process.env.HOBO_RELEASE_CD_HOME ||
		process.env.HOBO_HOME ||
		join(homedir(), ".hobo")
	);
}

async function publish(sha: string): Promise<void> {
	// A throwaway staging tree: exactly what publishes, site and catalogue.
	const staging = mkdtempSync(join(tmpdir(), "hobo-pages-"));
	try {
		run("cp", ["-a", `${DIST_DIR}/.`, staging]);
		// Nested, not merged: the catalogue is a second Astro build with its own
		// hashed `_astro/` bundle, and flattening the two into one root would let
		// them fight over that directory.
		const mediaTarget = join(staging, MEDIA_SUBPATH);
		mkdirSync(mediaTarget, { recursive: true });
		run("cp", ["-a", `${MEDIA_DIST}/.`, mediaTarget]);
		// Astro output is already built; Jekyll must not touch it, and without
		// this file GitHub silently drops every `_astro/*` asset.
		run("touch", [join(staging, ".nojekyll")], staging);

		// The browser WIT runtime (~25MB wasm) ships by default: it is what lets
		// visitors actually run hello-world / todo-api in-page on Pages. The
		// earlier "Pages legacy builds fail / hang on the wasm" belief traced to
		// runner starvation on 2026-08-06 (build jobs cancelled at 15m with no
		// runner assigned, runner_id=0), not to payload size — and a failed
		// branch build leaves the previous deployment live, so shipping it is
		// safe to attempt. HOBO_PAGES_STRIP_WIT=1 restores the old strip as an
		// escape hatch if a Pages build ever genuinely chokes on it.
		if (process.env.HOBO_PAGES_STRIP_WIT === "1") {
			const runtimeDir = join(staging, "examples/runtime");
			if (existsSync(runtimeDir)) {
				rmSync(runtimeDir, { recursive: true, force: true });
				mkdirSync(runtimeDir, { recursive: true });
				writeFileSync(
					join(runtimeDir, "PAGES.md"),
					[
						"# Browser WIT runtime stripped from this deploy",
						"",
						"This deploy ran with HOBO_PAGES_STRIP_WIT=1, so the",
						"`examples/runtime/` WIT bundle (~25MB wasm) is omitted.",
						"",
						"Examples HTML + `index.json` still ship. Working Pages path:",
						"`pnpm --filter hobo-site run examples:bridge` then open",
						"`/HoBo/examples/?bridge=http://127.0.0.1:8787` (OpenSaaS /",
						"Swaghaus). Browser-WIT hello-world needs local",
						"`pnpm --filter hobo-site run dev` (prebuild runs",
						"`examples:runtime`).",
						"",
					].join("\n"),
					"utf8",
				);
			}
		} else if (!existsSync(join(staging, "examples/runtime/manifest.json"))) {
			throw new Error(
				"examples/runtime/manifest.json missing from the built site — the browser WIT runtime did not build; refusing to publish a demo site whose examples cannot run (set HOBO_PAGES_STRIP_WIT=1 to publish without it deliberately)",
			);
		}

		const files = siteTree(staging).files.length;
		if (dryRun) {
			console.log(
				`[dry run] would publish ${files} files to ${BRANCH} through hobo-release/pages-candidate (deploy: ${sha})`,
			);
			return;
		}
		await qualifySiteRelease({
			dist: staging,
			home: releaseCdHome(),
			env: { ...process.env, HOBO_RELEASE_REVISION: sha },
		});
		console.log(`published ${files} files to ${BRANCH}: deploy: ${sha}`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const at = process.argv.indexOf("--release-freight");
		if (at !== -1) {
			const dist = process.argv[at + 1];
			if (!dist)
				throw new Error("--release-freight needs the built site directory");
			await qualifySiteRelease({ dist: resolve(dist), home: releaseCdHome() });
		} else {
			const sha = assertClean();
			build();
			await publish(sha);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
