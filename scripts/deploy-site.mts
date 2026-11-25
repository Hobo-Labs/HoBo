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
	RELEASE_PROMOTION_TIMEOUT,
	type ReleaseCdSeams,
	releaseChannelVerdict,
	releaseSource,
	siteTree,
	startReleasePagesWall,
} from "./ci/create-github-release.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SITE_DIR = join(REPO_ROOT, "site");
const DIST_DIR = join(SITE_DIR, "dist");
const MEDIA_DIR = join(REPO_ROOT, "media");
const MEDIA_DIST = join(MEDIA_DIR, "dist");
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

	console.log("building media catalogue…");
	execFileSync("pnpm", ["run", "build"], { cwd: MEDIA_DIR, stdio: "inherit" });
	if (!existsSync(MEDIA_DIST) || readdirSync(MEDIA_DIST).length === 0) {
		throw new Error(`media build produced no output at ${MEDIA_DIST}`);
	}

	if (process.env.HOBO_SKIP_DIST_VERIFY === "1") {
		console.log("skipping dist verification (HOBO_SKIP_DIST_VERIFY=1)…");
	} else {
		console.log("verifying built site (examples run as deployed)…");
		execFileSync("pnpm", ["run", "examples:verify-dist"], {
			cwd: SITE_DIR,
			stdio: "inherit",
		});
		console.log("verifying built site (the landing trail at every size)…");
		execFileSync("pnpm", ["run", "landing:verify-dist"], {
			cwd: SITE_DIR,
			stdio: "inherit",
		});
	}
}

export async function qualifySiteRelease(input: {
	readonly dist: string;
	readonly home: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly seams?: ReleaseCdSeams;
}): Promise<void> {
	const env = input.env ?? process.env;
	const wall = startReleasePagesWall(env);
	const tree = siteTree(input.dist);
	if (tree.files.length === 0)
		throw new Error(`${input.dist} holds no files to publish`);
	await qualifyReleaseCandidate({
		home: input.home,
		family: "pages",
		env,
		wall,
		stored: [
			{
				name: "site",
				kind: "ARTIFACT_KIND_STATIC_ASSETS",
				mediaType: "application/vnd.hobo.static-site-tree+json",
				bytes: tree.index,
			},
		],
		blobs: tree.files.map((file) => file.bytes),
		labels: {
			"hobo.cd/github.commit-message": `deploy: ${releaseSource(env).commit}`,
		},
		...(input.seams ? { seams: input.seams } : undefined),
	});
	if (!(await promoteReleaseStable(input.home, env, input.seams, wall))) {
		const stable = releaseChannelVerdict(input.home, "pages", "stable");
		throw new Error(
			`release Freight pages blocked at hobo-release/pages-stable${stable ? `: ${stable.codes.join(", ")}` : ""}`,
		);
	}
}

function releaseCdHome(): string {
	return (
		process.env.HOBO_RELEASE_CD_HOME ||
		process.env.HOBO_HOME ||
		join(homedir(), ".hobo")
	);
}

async function publish(sha: string): Promise<void> {
	const staging = mkdtempSync(join(tmpdir(), "hobo-pages-"));
	try {
		run("cp", ["-a", `${DIST_DIR}/.`, staging]);
		const mediaTarget = join(staging, MEDIA_SUBPATH);
		mkdirSync(mediaTarget, { recursive: true });
		run("cp", ["-a", `${MEDIA_DIST}/.`, mediaTarget]);
		run("touch", [join(staging, ".nojekyll")], staging);

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
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			message.includes(RELEASE_PROMOTION_TIMEOUT)
				? `::error::${message}`
				: message,
		);
		process.exit(1);
	}
}
