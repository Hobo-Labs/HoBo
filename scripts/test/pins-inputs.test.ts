/**
 * What an operator or the environment hands the pin code is read exactly:
 * two repository URLs are the same only when git would treat them so (the
 * scheme and host fold case, the path does not), and a URL that names the
 * pin's own repository is not announced or rewritten as a move.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { PinsError } from "../lib/pins.ts";
import { refuseOverridesInCi } from "../lib/pins-asset-ops.ts";
import { sameRepo } from "../lib/pins-git.ts";
import {
	type FileServer,
	runBootstrapAsync,
	scratch,
	sha256Hex,
	startServer,
	writeManifest,
} from "./support/pins-support.ts";

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const OLD = Buffer.from("old build\n");
const NEW = Buffer.from("new build, longer\n");

/** A one-target pin of `mirror` at v1.0.0, and v2.0.0 published by the same server. */
async function released(): Promise<{
	root: string;
	srv: FileServer;
	repo: string;
	manifest: string;
}> {
	const srv = await startServer();
	server = srv;
	const root = scratch("inputs");
	const repo = `${srv.origin}/example/mirror`;
	const file = {
		url: `${srv.origin}/old`,
		sha256: sha256Hex(OLD),
		size: OLD.byteLength,
		entry: "mirror",
	};
	writeManifest(
		root,
		`{"mirror":{"repo":"${repo}","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(file)}}}}`,
	);
	const base = "/example/mirror/releases/download/v2.0.0";
	srv.setFile(`${base}/mirror-linux-x64`, NEW);
	srv.setFile(`${base}/SHA256SUMS`, `${sha256Hex(NEW)}  mirror-linux-x64\n`);
	return { root, srv, repo, manifest: join(root, "tools/pins/siblings.json") };
}

describe("sameRepo", () => {
	it("folds the case of the scheme and the host, never of the path", () => {
		assert.equal(
			sameRepo(
				"HTTPS://Git.Example.com/Org/Repo.git/",
				"https://git.example.com/Org/Repo",
			),
			true,
		);
		assert.equal(
			sameRepo(
				"https://git.example.com/Org/Repo",
				"https://git.example.com/org/repo",
			),
			false,
			"a case-sensitive host serves these as two repositories",
		);
		assert.equal(sameRepo("/srv/A/r", "/srv/a/r"), false);
	});
});

describe("bump --repo naming the pin's own repository", () => {
	for (const spelling of ["/", ".git"]) {
		it(`with a trailing ${spelling} is not a move: nothing announced, the text kept`, async () => {
			const { root, repo, manifest } = await released();
			const run = await runBootstrapAsync(root, [
				"--bump",
				"mirror",
				"v2.0.0",
				"--repo",
				`${repo}${spelling}`,
			]);
			assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
			assert.doesNotMatch(run.stdout, /repo:/u);
			assert.equal(
				JSON.parse(readFileSync(manifest, "utf8")).assets.mirror.repo,
				repo,
			);
		});
	}
});

describe("bump checks a name it was given before any request", () => {
	for (const [label, entry] of [
		["longer than 200 bytes", "e".repeat(201)],
		["a path", "bin/mirror"],
		["a backslash", "bin\\mirror"],
		["a control character", "mir\tror"],
	] as const) {
		it(`--entry ${label} is a usage error, and nothing is requested`, async () => {
			const { root, srv } = await released();
			srv.hits.length = 0;
			const run = await runBootstrapAsync(root, [
				"--bump",
				"mirror",
				"v2.0.0",
				"--entry",
				entry,
			]);
			assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
			assert.match(run.stderr, /--entry .* is not a plain file name/u);
			assert.deepEqual(srv.hits, []);
		});
	}

	it("--entry of exactly 200 bytes is accepted", async () => {
		const { root, manifest } = await released();
		const entry = "e".repeat(200);
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--entry",
			entry,
		]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		const pin = JSON.parse(readFileSync(manifest, "utf8")).assets.mirror;
		assert.equal(pin.files["linux-x64"].entry, entry);
	});

	it("--drop of a target the pin never had is refused before SHA256SUMS is read", async () => {
		const { root, srv } = await released();
		srv.hits.length = 0;
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--drop",
			"linux-arm64",
		]);
		assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, /--drop linux-arm64: the pin has no such target/u);
		assert.deepEqual(srv.hits, []);
	});
});

describe("an override in CI", () => {
	const refused = (env: NodeJS.ProcessEnv): boolean => {
		try {
			refuseOverridesInCi(["mirror"], { MIRROR_BIN: "/opt/mirror", ...env });
			return false;
		} catch (error) {
			return error instanceof PinsError && error.code === "OVERRIDE_IN_CI";
		}
	};

	it("is refused when CI, GITHUB_ACTIONS or TF_BUILD says this is CI", () => {
		for (const env of [
			{ CI: "true" },
			{ GITHUB_ACTIONS: "true" },
			{ TF_BUILD: "True" },
			{ TF_BUILD: "true", CI: "" },
		]) {
			assert.equal(refused(env), true, JSON.stringify(env));
		}
	});

	it("is allowed outside CI, and in CI when HOBO_PINS_ALLOW_OVERRIDE=1", () => {
		for (const env of [
			{},
			{ CI: "false" },
			{ GITHUB_ACTIONS: "false" },
			{ TF_BUILD: "" },
			{ GITHUB_ACTIONS: "true", HOBO_PINS_ALLOW_OVERRIDE: "1" },
		]) {
			assert.equal(refused(env), false, JSON.stringify(env));
		}
	});
});
