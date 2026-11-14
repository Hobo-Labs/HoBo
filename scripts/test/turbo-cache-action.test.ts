import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	TURBO_CACHE_API_PATTERN,
	TurboCacheSchema,
} from "../../packages/ci-gh-actions/src/project-schema.ts";

const ACTION = readFileSync(
	new URL("../../.github/actions/turbo-cache/action.yml", import.meta.url),
	"utf8",
);

/** The first `run: |` block (the restore-mode configure step), dedented. */
function configureScript(): string {
	const lines = ACTION.split("\n");
	const start = lines.findIndex((line) => /^\s+run: \|$/.test(line));
	assert.ok(start >= 0, "configure step has a run block");
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() && !line.startsWith("        ")) break;
		body.push(line.slice(8));
	}
	return body.join("\n");
}

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** What a test commits under `.hobo/ci.json`'s `turboCache`. */
type TurboCacheConfig = Readonly<{ api: string }>;

/** `.hobo/ci.json`'s text naming this cache server. */
const committing = (turboCache: TurboCacheConfig) =>
	JSON.stringify({ turboCache });

/**
 * Runs the configure step in a checkout whose `.hobo/ci.json` holds
 * `configText` (no file when it is left out).
 */
function configure(env: Record<string, string>, configText?: string) {
	const root = mkdtempSync(join(tmpdir(), "turbo-cache-action-"));
	roots.push(root);
	const githubEnv = join(root, "github-env");
	writeFileSync(githubEnv, "");
	const store = join(root, "store");
	const checkout = join(root, "checkout");
	mkdirSync(join(checkout, ".hobo"), { recursive: true });
	if (configText !== undefined)
		writeFileSync(join(checkout, ".hobo/ci.json"), configText);
	execFileSync("bash", ["-c", configureScript()], {
		cwd: checkout,
		env: {
			PATH: process.env.PATH ?? "",
			GITHUB_ENV: githubEnv,
			HOBO_CI_PNPM_STORE_MOUNTED: "1",
			npm_config_store_dir: store,
			INPUT_TOKEN: "",
			INPUT_TEAM: "",
			REMOTE_MODE: "remote:rw",
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		exported: readFileSync(githubEnv, "utf8").split("\n").filter(Boolean),
		shared: join(store, "hobo-turbo-cache"),
	};
}

describe("turbo-cache action on the box", () => {
	it("decides same-repository by head repo name, which a deleted fork lacks", () => {
		assert.match(
			ACTION,
			/SAME_REPO: \$\{\{ github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}/,
		);
	});

	it("gives same-repository jobs the shared host cache", () => {
		const { exported, shared } = configure({ SAME_REPO: "true" });
		assert.deepEqual(exported, [
			`TURBO_CACHE_DIR=${shared}`,
			"HOBO_TURBO_CACHE_SHARED=1",
			"TURBO_CACHE=local:rw",
		]);
		assert.ok(existsSync(shared));
	});

	it("keeps a pull request from another repository off the shared cache", () => {
		const { exported, shared } = configure({
			SAME_REPO: "false",
			REMOTE_MODE: "remote:ro",
		});
		assert.deepEqual(exported, []);
		assert.equal(existsSync(shared), false);
	});

	it("adds the remote cache beside the shared local cache", () => {
		const { exported } = configure({
			SAME_REPO: "true",
			INPUT_TOKEN: "token",
			INPUT_TEAM: "team",
		});
		assert.deepEqual(exported.slice(-3), [
			"TURBO_TOKEN=token",
			"TURBO_TEAM=team",
			"TURBO_CACHE=local:rw,remote:rw",
		]);
	});

	it("points Turbo at the fleet's own cache server when committed config names one", () => {
		const { exported } = configure(
			{ SAME_REPO: "true", INPUT_TOKEN: "token", INPUT_TEAM: "hobo" },
			committing({ api: "https://turbo-cache.example.internal:3000" }),
		);
		assert.deepEqual(exported.slice(-4), [
			"TURBO_TOKEN=token",
			"TURBO_TEAM=hobo",
			"TURBO_API=https://turbo-cache.example.internal:3000",
			"TURBO_CACHE=local:rw,remote:rw",
		]);
	});

	it("ignores a cache server address without a token and team", () => {
		const { exported } = configure(
			{ SAME_REPO: "true" },
			committing({ api: "https://turbo-cache.example.internal:3000" }),
		);
		assert.equal(
			exported.some((line) => line.startsWith("TURBO_API=")),
			false,
		);
	});

	it("uses Vercel's cache when the committed address is empty, missing or unreadable", () => {
		for (const configText of [
			committing({ api: "" }),
			"{}",
			"not json",
			undefined,
		]) {
			const { exported } = configure(
				{ SAME_REPO: "true", INPUT_TOKEN: "token", INPUT_TEAM: "hobo" },
				configText,
			);
			assert.deepEqual(
				exported.slice(-3),
				[
					"TURBO_TOKEN=token",
					"TURBO_TEAM=hobo",
					"TURBO_CACHE=local:rw,remote:rw",
				],
				String(configText),
			);
		}
	});

	it("holds the committed address to the same rule as the project schema", () => {
		assert.ok(
			ACTION.includes(
				`[[ "\${api}" =~ ${TURBO_CACHE_API_PATTERN.source.replaceAll("\\/", "/")} ]]`,
			),
		);
		for (const api of ["", "https://turbo-cache.example.internal:3000"])
			assert.equal(TurboCacheSchema.safeParse({ api }).success, true, api);
		for (const api of ["http://turbo.example", "https://ok.example/$(id)"])
			assert.equal(TurboCacheSchema.safeParse({ api }).success, false, api);
		assert.equal(
			TurboCacheSchema.safeParse({ api: "", extra: 1 }).success,
			false,
		);
	});

	it("matches the committed .hobo/ci.json, which names no server today", () => {
		const committed = JSON.parse(
			readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
		);
		assert.deepEqual(committed.turboCache, { api: "" });
	});

	it("refuses a cache server address that is not a plain https URL", () => {
		for (const api of [
			"turbo-cache.example.internal",
			// The token travels to this address, so plain http is refused.
			"http://turbo-cache.example.internal:3000",
			"file:///etc/passwd",
			"https://ok.example\nNODE_OPTIONS=--require=/tmp/x",
			"https://ok.example/$(id)",
		])
			assert.throws(
				() =>
					configure(
						{ SAME_REPO: "true", INPUT_TOKEN: "token", INPUT_TEAM: "hobo" },
						committing({ api }),
					),
				Error,
				api,
			);
	});

	it("takes no cache address from a repository variable at any call site", () => {
		for (const name of [
			"hobo-ci.yml",
			"pricing-ci.yml",
			"release-hobo.yml",
			"release-pricing.yml",
		]) {
			const workflow = readFileSync(
				new URL(`../../.github/workflows/${name}`, import.meta.url),
				"utf8",
			);
			const tokens = workflow.split("          turbo-token: ");
			assert.ok(tokens.length > 1, name);
			assert.doesNotMatch(workflow, /turbo-api:|HOBO_CI_TURBO_API/u, name);
		}
	});
});
