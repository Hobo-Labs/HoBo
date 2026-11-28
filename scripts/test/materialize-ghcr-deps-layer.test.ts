import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, it } from "node:test";
import { createZstdCompress } from "node:zlib";

import {
	choosePayloadDirectory,
	decideDepsRecovery,
	depsLayerUnavailableReason,
	extractDepsTar,
	ghcrDepsImageRef,
	localDepsImageRef,
	materializePublishedDepsLayer,
	runMaterializeCli,
	warmPnpmStore,
	type DepsDocker,
	type ManifestProbe,
} from "../ci/materialize-ghcr-deps-layer.mts";

const key = "v0123456789ab-0123456789abcdef";
const otherKey = "v0123456789ab-fedcba9876543210";
const repository = "Hobo-Labs/HoBo";
const script = join(
	import.meta.dirname,
	"..",
	"ci",
	"materialize-ghcr-deps-layer.mts",
);
const workflow = join(
	import.meta.dirname,
	"..",
	"..",
	".github",
	"workflows",
	"hobo-ci.yml",
);
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const GZIP_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const ZSTD_LAYER = "application/vnd.oci.image.layer.v1.tar+zstd";
const TAR_LAYER = "application/vnd.oci.image.layer.v1.tar";

function sha256(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hostArchitecture(): string {
	if (process.arch === "x64") return "amd64";
	if (process.arch === "arm64") return "arm64";
	return process.arch;
}

function gnuTar(
	root: string,
	paths: readonly string[],
	gzip: boolean,
	extra: readonly string[] = [],
): Buffer {
	const file = join(dirname(root), gzip ? "layer.tgz" : "layer.tar");
	execFileSync("tar", [
		"--format=pax",
		...extra,
		"-C",
		root,
		...(gzip ? ["-czf"] : ["-cf"]),
		file,
		...paths,
	]);
	const bytes = readFileSync(file);
	rmSync(file, { force: true });
	return bytes;
}

function execFileSync(command: string, args: readonly string[]): Buffer {
	const result = spawnSync(command, args, { maxBuffer: 16 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed: ${result.stderr?.toString() ?? ""}`,
		);
	}
	return result.stdout ?? Buffer.alloc(0);
}

async function zstd(bytes: Buffer): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await pipeline(
		Readable.from([bytes]),
		createZstdCompress(),
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				callback();
			},
		}),
	);
	return Buffer.concat(chunks);
}

type LayerSpec = {
	mediaType: string;
	body: Buffer;
	digest?: string;
	size?: number;
};

type Registry = {
	base: string;
	hits: string[];
	authorizations: string[];
	close: () => Promise<void>;
};

function manifestDocument(layers: readonly LayerSpec[]): Buffer {
	return Buffer.from(
		JSON.stringify({
			schemaVersion: 2,
			mediaType: OCI_MANIFEST,
			layers: layers.map((layer) => ({
				mediaType: layer.mediaType,
				digest: layer.digest ?? sha256(layer.body),
				size: layer.size ?? layer.body.length,
			})),
		}),
	);
}

async function startRegistry(input: {
	token: string;
	bearer: string;
	key: string;
	layers?: readonly LayerSpec[];
	indexPlatforms?: readonly {
		architecture: string;
		layers: readonly LayerSpec[];
	}[];
	manifestStatus?: number;
	tokenStatus?: number;
	cutOffManifest?: boolean;
	refuseBlobs?: boolean;
}): Promise<Registry> {
	const hits: string[] = [];
	const authorizations: string[] = [];
	const blobs = new Map<string, Buffer>();
	const manifests = new Map<string, Buffer>();
	let manifest: Buffer = Buffer.from("{}");
	if (input.indexPlatforms) {
		const entries = input.indexPlatforms.map((platform) => {
			const document = manifestDocument(platform.layers);
			const digest = sha256(document);
			manifests.set(digest, document);
			for (const layer of platform.layers) {
				blobs.set(layer.digest ?? sha256(layer.body), layer.body);
			}
			return {
				mediaType: OCI_MANIFEST,
				digest,
				size: document.length,
				platform: { os: "linux", architecture: platform.architecture },
			};
		});
		manifest = Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: OCI_INDEX,
				manifests: entries,
			}),
		);
	} else if (input.layers) {
		manifest = manifestDocument(input.layers);
		for (const layer of input.layers) {
			blobs.set(layer.digest ?? sha256(layer.body), layer.body);
		}
	}
	const repositoryPath = "hobo-labs/hobo/hobo-ci-deps";
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		hits.push(url.pathname);
		const authorization = request.headers.authorization ?? "";
		authorizations.push(authorization);
		const send = (status: number, body: Buffer, type = "application/json") => {
			response.writeHead(status, {
				"content-type": type,
				"content-length": String(body.length),
			});
			response.end(body);
		};
		const cutOff = (body: Buffer, type: string): void => {
			response.writeHead(200, {
				"content-type": type,
				"content-length": String(body.length),
				connection: "close",
			});
			response.end(body.subarray(0, Math.floor(body.length / 2)));
		};
		if (url.pathname === "/token") {
			const expected = `Basic ${Buffer.from(`ci-actor:${input.token}`).toString("base64")}`;
			if ((input.tokenStatus ?? 200) !== 200 || authorization !== expected) {
				send(input.tokenStatus ?? 401, Buffer.from("{}"));
				return;
			}
			if (
				url.searchParams.get("scope") !== `repository:${repositoryPath}:pull`
			) {
				send(403, Buffer.from("{}"));
				return;
			}
			send(200, Buffer.from(JSON.stringify({ token: input.bearer })));
			return;
		}
		const manifestPath = `/v2/${repositoryPath}/manifests/${input.key}`;
		if (url.pathname === manifestPath) {
			if ((input.manifestStatus ?? 200) !== 200) {
				send(input.manifestStatus ?? 500, Buffer.from("{}"));
				return;
			}
			if (authorization !== `Bearer ${input.bearer}`) {
				send(401, Buffer.from("{}"));
				return;
			}
			const type = input.indexPlatforms ? OCI_INDEX : OCI_MANIFEST;
			if (input.cutOffManifest) cutOff(manifest, type);
			else send(200, manifest, type);
			return;
		}
		if (url.pathname.startsWith(`/v2/${repositoryPath}/manifests/`)) {
			const digest = decodeURIComponent(
				url.pathname.split("/manifests/")[1] ?? "",
			);
			const document = manifests.get(digest);
			if (!document) {
				send(404, Buffer.from("{}"));
				return;
			}
			send(200, document, OCI_MANIFEST);
			return;
		}
		if (url.pathname.startsWith(`/v2/${repositoryPath}/blobs/`)) {
			if (input.refuseBlobs) {
				request.socket.destroy();
				return;
			}
			const digest = decodeURIComponent(url.pathname.split("/blobs/")[1] ?? "");
			const body = blobs.get(digest);
			if (!body) {
				send(404, Buffer.from("{}"));
				return;
			}
			send(200, body, "application/octet-stream");
			return;
		}
		send(404, Buffer.from("{}"));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || !(address instanceof Object)) {
		throw new Error("registry test server has no port");
	}
	return {
		base: `http://127.0.0.1:${address.port}`,
		hits,
		authorizations,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

function localFetch(base: string): typeof fetch {
	const allowed = new URL(base);
	return async (input, init) => {
		const url =
			input instanceof URL
				? input
				: new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname !== allowed.hostname || url.port !== allowed.port) {
			throw new Error(`refused registry host ${url.host}`);
		}
		return fetch(input, init);
	};
}

function snapshotTree(directory: string): string {
	const lines: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const rel = prefix === "" ? name : `${prefix}/${name}`;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				lines.push(`${rel} -> ${readlinkSync(path)}`);
				continue;
			}
			if (stat.isDirectory()) {
				lines.push(`${rel}/`);
				walk(path, rel);
				continue;
			}
			lines.push(`${rel} ${stat.nlink} ${readFileSync(path, "utf8")}`);
		}
	};
	walk(directory, "");
	return lines.join("\n");
}

function writePayloadTree(root: string, marker: string): void {
	const payload = join(root, "opt", "hobo-deps");
	mkdirSync(join(payload, "sub"), { recursive: true });
	writeFileSync(join(payload, ".hobo-ci-deps-key"), `${marker}\n`);
	writeFileSync(join(payload, "sub", "keep.txt"), "keep\n");
	writeFileSync(join(payload, "sub", "gone.txt"), "gone\n");
	writeFileSync(join(payload, "tool.sh"), "#!/bin/sh\n");
	chmodSync(join(payload, "tool.sh"), 0o755);
	symlinkSync("keep.txt", join(payload, "sub", "link.txt"));
	writeFileSync(join(payload, "hard.txt"), "hard\n");
	linkSync(join(payload, "hard.txt"), join(payload, "hard-link.txt"));
	writeFileSync(join(payload, `${"n".repeat(180)}.txt`), "long\n");
	mkdirSync(join(root, "other"), { recursive: true });
	writeFileSync(join(root, "other", "note.txt"), "skip\n");
}

function dockerCalls() {
	return { login: 0, pull: 0, manifest: 0, copy: 0 };
}

function dockerReportingMiss(): DepsDocker {
	return {
		localImage: () => false,
		remoteManifest: () => "miss",
		login: () => undefined,
		pull: () => undefined,
		copyPayload: () => undefined,
	};
}

describe("deps image refs and recovery", () => {
	it("formats the published and local refs without a local promotion tag", () => {
		assert.equal(
			ghcrDepsImageRef(repository, key),
			`ghcr.io/hobo-labs/hobo/hobo-ci-deps:${key}`,
		);
		assert.equal(localDepsImageRef(key), `hobo-ci-deps:${key}`);
		assert.equal(
			depsLayerUnavailableReason(),
			"hobo-ci-deps-layer-unavailable",
		);
		assert.throws(
			() => ghcrDepsImageRef("not a repo", key),
			/invalid GITHUB_REPOSITORY/,
		);
		assert.throws(() => localDepsImageRef("latest"), /invalid deps key/);
	});

	it("prefers a materialized layer, then a warm store, then the named failure", () => {
		assert.deepEqual(
			decideDepsRecovery({
				materialized: true,
				source: "ghcr",
				payload: "/opt/hobo-deps",
				warmStore: true,
				detail: "",
			}),
			{ action: "materialized", source: "ghcr", payload: "/opt/hobo-deps" },
		);
		assert.deepEqual(
			decideDepsRecovery({
				materialized: false,
				warmStore: true,
				detail: "manifest missing",
			}),
			{ action: "install", reason: "warm-pnpm-store" },
		);
		const failed = decideDepsRecovery({
			materialized: false,
			warmStore: false,
			detail: "manifest missing",
		});
		assert.equal(failed.action, "fail");
		if (failed.action === "fail") {
			assert.equal(failed.reason, depsLayerUnavailableReason());
		}
	});

	it("treats an empty store directory as cold", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-warm-store-"));
		try {
			const empty = join(root, "empty");
			const filled = join(root, "filled");
			mkdirSync(empty);
			mkdirSync(filled);
			writeFileSync(join(filled, "package"), "1");
			assert.equal(
				warmPnpmStore({ env: { HOBO_CI_PNPM_STORE_MOUNTED: "1" } }),
				true,
			);
			assert.equal(
				warmPnpmStore({ env: { HOBO_CI_PNPM_STORE_DIR: empty } }),
				false,
			);
			assert.equal(
				warmPnpmStore({ env: { HOBO_CI_PNPM_STORE_DIR: filled } }),
				true,
			);
			assert.equal(
				warmPnpmStore({
					env: {},
					storePath: () => empty,
				}),
				false,
			);
			assert.equal(
				warmPnpmStore({
					env: {},
					storePath: () => filled,
				}),
				true,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports the warm store to the timeout recovery wrapper", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-warm-store-cli-"));
		try {
			const empty = join(root, "empty");
			const filled = join(root, "filled");
			mkdirSync(empty);
			mkdirSync(filled);
			writeFileSync(join(filled, "package"), "1");
			const pnpm = join(root, "pnpm");
			writeFileSync(
				pnpm,
				'#!/bin/sh\nprintf "%s\\n" "$HOBO_TEST_STORE_PATH"\n',
			);
			chmodSync(pnpm, 0o755);
			for (const [store, expected] of [
				[empty, "false"],
				[filled, "true"],
			] as const) {
				const result = spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--no-warnings",
						script,
						"--check-warm-store",
					],
					{
						encoding: "utf8",
						env: {
							...process.env,
							PATH: root,
							HOBO_CI_PNPM_STORE_MOUNTED: "",
							HOBO_CI_PNPM_STORE_DIR: "",
							HOBO_TEST_STORE_PATH: store,
						},
					},
				);
				assert.equal(result.status, 0, result.stderr);
				assert.equal(result.stdout.trim(), expected);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes a runner-temp payload when the default directory is not writable", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-payload-dir-"));
		try {
			const explicit = join(root, "explicit");
			const chosen = await choosePayloadDirectory({
				HOBO_CI_DEPS_PAYLOAD: explicit,
			});
			assert.deepEqual(chosen, { directory: explicit, publish: false });
			const writable = join(root, "default");
			const created = await choosePayloadDirectory({}, writable);
			assert.equal(created.publish, false);
			assert.equal(created.directory, writable);
			assert.equal(existsSync(writable), true);
			const blocked = join(root, "file");
			writeFileSync(blocked, "not-a-directory");
			const runner = join(root, "runner");
			mkdirSync(runner);
			const fallback = await choosePayloadDirectory(
				{ RUNNER_TEMP: runner },
				join(blocked, "hobo-deps"),
			);
			assert.deepEqual(fallback, {
				directory: join(runner, "hobo-deps"),
				publish: true,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("registry materialize", () => {
	it("extracts Unicode PAX paths using their byte lengths", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-pax-unicode-"));
		try {
			const source = join(root, "source");
			const directory = join(source, "opt", "hobo-deps");
			mkdirSync(directory, { recursive: true });
			const name = `${"a".repeat(110)}-café.txt`;
			writeFileSync(join(directory, name), "unicode filename\n");
			const archive = gnuTar(source, ["opt"], false);
			const payload = join(root, "payload");
			await extractDepsTar(Readable.from([archive]), payload);
			assert.deepEqual(readdirSync(payload), [name]);
			assert.equal(
				readFileSync(join(payload, name), "utf8"),
				"unicode filename\n",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes complete files when the filesystem returns a short write", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-short-write-"));
		try {
			const source = join(root, "source");
			mkdirSync(join(source, "opt", "hobo-deps"), { recursive: true });
			const expected = Buffer.alloc(16_384, 67);
			writeFileSync(join(source, "opt", "hobo-deps", "file"), expected);
			const archive = join(root, "input.tar");
			writeFileSync(archive, gnuTar(source, ["opt"], false));
			const child = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
const [, modulePath, archivePath, payload, mode] = process.argv.slice(1);
const bytes = fs.readFileSync(archivePath);
const original = fs.writeSync;
try {
  fs.writeSync = function(fd, data, ...args) {
    if (Buffer.isBuffer(data)) {
      if (mode === "stall") return 0;
      const offset = args[0] ?? 0;
      const length = args[1] ?? data.length - offset;
      return original(fd, data, offset, Math.max(1, Math.floor(length / 2)));
    }
    return Reflect.apply(original, fs, [fd, data, ...args]);
  };
  syncBuiltinESMExports();
  const { extractDepsTar } = await import(pathToFileURL(modulePath).href);
  await extractDepsTar(Readable.from([bytes]), payload);
} finally {
  fs.writeSync = original;
  syncBuiltinESMExports();
}`;
			const run = (mode: string) =>
				spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--input-type=module",
						"-e",
						child,
						"short-write-fixture",
						script,
						archive,
						join(root, mode),
						mode,
					],
					{ encoding: "utf8" },
				);
			const short = run("short");
			assert.equal(short.status, 0, short.stderr);
			assert.ok(readFileSync(join(root, "short", "file")).equals(expected));
			const stalled = run("stall");
			assert.notEqual(stalled.status, 0);
			assert.match(stalled.stderr, /write made no progress/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts gzip and zstd layers, whiteouts, links, and long names", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-archive-"));
		const token = randomBytes(24).toString("hex");
		const bearer = randomBytes(24).toString("hex");
		const payload = join(root, "payload");
		let registry: Registry | undefined;
		try {
			const firstRoot = join(root, "first");
			writePayloadTree(firstRoot, key);
			const first = gnuTar(firstRoot, ["opt", "other"], true);
			const secondRoot = join(root, "second");
			mkdirSync(join(secondRoot, "opt", "hobo-deps", "sub"), {
				recursive: true,
			});
			writeFileSync(
				join(secondRoot, "opt", "hobo-deps", "sub", ".wh.gone.txt"),
				"",
			);
			writeFileSync(
				join(secondRoot, "opt", "hobo-deps", "sub", "next.txt"),
				"next\n",
			);
			const second = await zstd(gnuTar(secondRoot, ["opt"], false));
			registry = await startRegistry({
				token,
				bearer,
				key,
				layers: [
					{ mediaType: GZIP_LAYER, body: first },
					{ mediaType: ZSTD_LAYER, body: second },
				],
			});
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: payload,
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
				maxLayerBytes: 8 * 1024 * 1024,
			});
			assert.deepEqual(result, { ok: true, source: "ghcr" });
			assert.equal(
				readFileSync(join(payload, ".hobo-ci-deps-key"), "utf8").trim(),
				key,
			);
			assert.equal(
				readFileSync(join(payload, "sub", "keep.txt"), "utf8"),
				"keep\n",
			);
			assert.equal(existsSync(join(payload, "sub", "gone.txt")), false);
			assert.equal(existsSync(join(payload, "sub", ".wh.gone.txt")), false);
			assert.equal(
				readFileSync(join(payload, "sub", "next.txt"), "utf8"),
				"next\n",
			);
			assert.equal(readlinkSync(join(payload, "sub", "link.txt")), "keep.txt");
			assert.equal(
				lstatSync(join(payload, "hard.txt")).ino,
				lstatSync(join(payload, "hard-link.txt")).ino,
			);
			assert.equal(
				readFileSync(join(payload, `${"n".repeat(180)}.txt`), "utf8"),
				"long\n",
			);
			assert.equal(lstatSync(join(payload, "tool.sh")).mode & 0o777, 0o755);
			assert.equal(existsSync(join(payload, "other", "note.txt")), false);
			assert.equal(
				existsSync(join(dirname(payload), "other", "note.txt")),
				false,
			);
			const basic = `Basic ${Buffer.from(`ci-actor:${token}`).toString("base64")}`;
			assert.equal(registry.authorizations.includes(basic), true);
			assert.equal(registry.authorizations.includes(`Bearer ${bearer}`), true);
			assert.equal(JSON.stringify(result).includes(token), false);
		} finally {
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("selects the host platform from an index", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-index-"));
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		const payload = join(root, "payload");
		let registry: Registry | undefined;
		try {
			const hostRoot = join(root, "host");
			mkdirSync(join(hostRoot, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(hostRoot, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			writeFileSync(join(hostRoot, "opt", "hobo-deps", "arch.txt"), "host\n");
			const otherRoot = join(root, "other-arch");
			mkdirSync(join(otherRoot, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(otherRoot, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			writeFileSync(join(otherRoot, "opt", "hobo-deps", "arch.txt"), "other\n");
			const host = hostArchitecture();
			const other = host === "amd64" ? "arm64" : "amd64";
			registry = await startRegistry({
				token,
				bearer,
				key,
				indexPlatforms: [
					{
						architecture: other,
						layers: [
							{
								mediaType: GZIP_LAYER,
								body: gnuTar(otherRoot, ["opt"], true),
							},
						],
					},
					{
						architecture: host,
						layers: [
							{ mediaType: GZIP_LAYER, body: gnuTar(hostRoot, ["opt"], true) },
						],
					},
				],
			});
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: payload,
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
			});
			assert.equal(result.ok, true);
			assert.equal(readFileSync(join(payload, "arch.txt"), "utf8"), "host\n");
			assert.equal(
				registry.hits.some((path) => path.includes("/manifests/sha256:")),
				true,
			);
		} finally {
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a manifest miss without downloading a blob", async () => {
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		const registry = await startRegistry({
			token,
			bearer,
			key,
			manifestStatus: 404,
		});
		try {
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(tmpdir(), "hobo-deps-miss-unused"),
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "miss");
				assert.equal(result.detail.includes(token), false);
			}
			assert.equal(
				registry.hits.some((hit) => hit.includes("/blobs/")),
				false,
			);
		} finally {
			await registry.close();
		}
	});

	it("fails a token rejection, a digest mismatch, a byte cap, and a key mismatch", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-fail-"));
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		try {
			const denied = await startRegistry({
				token,
				bearer,
				key,
				tokenStatus: 401,
			});
			try {
				const result = await materializePublishedDepsLayer({
					repository,
					key,
					payloadDir: join(root, "denied"),
					actor: "ci-actor",
					token,
					registryBase: denied.base,
					fetchImpl: localFetch(denied.base),
				});
				assert.equal(result.ok, false);
				if (!result.ok) {
					assert.equal(result.kind, "failed");
					assert.match(result.detail, /registry token 401/);
					assert.equal(result.detail.includes(token), false);
				}
			} finally {
				await denied.close();
			}
			const tree = join(root, "tree");
			mkdirSync(join(tree, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(tree, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			const body = gnuTar(tree, ["opt"], true);
			const mismatched = await startRegistry({
				token,
				bearer,
				key,
				layers: [
					{
						mediaType: GZIP_LAYER,
						body,
						digest: sha256(Buffer.concat([body, Buffer.from("x")])),
					},
				],
			});
			try {
				const payload = join(root, "digest");
				mkdirSync(payload);
				writeFileSync(join(payload, "partial"), "x");
				const result = await materializePublishedDepsLayer({
					repository,
					key,
					payloadDir: payload,
					actor: "ci-actor",
					token,
					registryBase: mismatched.base,
					fetchImpl: localFetch(mismatched.base),
				});
				assert.equal(result.ok, false);
				if (!result.ok) assert.match(result.detail, /digest/);
				assert.equal(existsSync(payload), false);
			} finally {
				await mismatched.close();
			}
			const capped = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body, size: body.length + 10 }],
			});
			try {
				const result = await materializePublishedDepsLayer({
					repository,
					key,
					payloadDir: join(root, "capped"),
					actor: "ci-actor",
					token,
					registryBase: capped.base,
					fetchImpl: localFetch(capped.base),
					maxLayerBytes: body.length,
				});
				assert.equal(result.ok, false);
				if (!result.ok) assert.match(result.detail, /byte cap/);
				assert.equal(
					capped.hits.some((hit) => hit.includes("/blobs/")),
					false,
				);
			} finally {
				await capped.close();
			}
			const wrong = join(root, "wrong");
			mkdirSync(join(wrong, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(wrong, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${otherKey}\n`,
			);
			const keyed = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body: gnuTar(wrong, ["opt"], true) }],
			});
			try {
				const payload = join(root, "key-mismatch");
				const result = await materializePublishedDepsLayer({
					repository,
					key,
					payloadDir: payload,
					actor: "ci-actor",
					token,
					registryBase: keyed.base,
					fetchImpl: localFetch(keyed.base),
				});
				assert.equal(result.ok, false);
				if (!result.ok) {
					assert.equal(result.kind, "failed");
					assert.match(result.detail, /payload key/);
				}
				assert.equal(existsSync(payload), false);
			} finally {
				await keyed.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a tar member that escapes the payload and ignores trailing bytes", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-tar-"));
		try {
			const escapeRoot = join(root, "escape");
			mkdirSync(join(escapeRoot, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(join(escapeRoot, "opt", "hobo-deps", "keep.txt"), "keep\n");
			const escaped = gnuTar(escapeRoot, ["opt/hobo-deps/keep.txt"], false, [
				"--absolute-names",
				"--transform",
				"s,^opt/hobo-deps/keep.txt,opt/hobo-deps/foo/../../tmp/pwned,",
			]);
			const archive = join(root, "escape.tar");
			writeFileSync(archive, escaped);
			const payload = join(root, "payload");
			await assert.rejects(
				extractDepsTar(createReadStream(archive), payload),
				/escapes/,
			);
			assert.equal(existsSync(join(root, "tmp", "pwned")), false);
			const opaqueRoot = join(root, "opaque");
			mkdirSync(join(opaqueRoot, "opt", "hobo-deps", "sub"), {
				recursive: true,
			});
			writeFileSync(
				join(opaqueRoot, "opt", "hobo-deps", "sub", ".wh..wh..opq"),
				"",
			);
			writeFileSync(
				join(opaqueRoot, "opt", "hobo-deps", "sub", "fresh.txt"),
				"fresh\n",
			);
			const opaqueTar = join(root, "opaque.tar");
			writeFileSync(
				opaqueTar,
				gnuTar(
					opaqueRoot,
					["opt/hobo-deps/sub/.wh..wh..opq", "opt/hobo-deps/sub/fresh.txt"],
					false,
				),
			);
			const existing = join(root, "existing");
			mkdirSync(join(existing, "sub"), { recursive: true });
			writeFileSync(join(existing, "sub", "old.txt"), "old\n");
			await extractDepsTar(createReadStream(opaqueTar), existing);
			assert.equal(existsSync(join(existing, "sub", "old.txt")), false);
			assert.equal(
				readFileSync(join(existing, "sub", "fresh.txt"), "utf8"),
				"fresh\n",
			);
			assert.equal(existsSync(join(existing, "sub", ".wh..wh..opq")), false);
			const tailRoot = join(root, "tail");
			mkdirSync(join(tailRoot, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(tailRoot, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			const tail = join(root, "tail.tar");
			writeFileSync(
				tail,
				Buffer.concat([
					gnuTar(tailRoot, ["opt"], false),
					Buffer.alloc(600, 0x61),
				]),
			);
			const tailPayload = join(root, "tail-payload");
			await extractDepsTar(createReadStream(tail), tailPayload);
			assert.equal(
				readFileSync(join(tailPayload, ".hobo-ci-deps-key"), "utf8").trim(),
				key,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses members that descend through a payload symlink", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-symlink-"));
		try {
			const outside = join(root, "outside");
			mkdirSync(join(outside, "nested"), { recursive: true });
			writeFileSync(join(outside, "keep.txt"), "keep\n");
			writeFileSync(join(outside, "nested", "inner.txt"), "inner\n");
			const before = snapshotTree(outside);
			const linkTree = join(root, "link-only");
			mkdirSync(join(linkTree, "opt", "hobo-deps"), { recursive: true });
			symlinkSync(outside, join(linkTree, "opt", "hobo-deps", "evil"));
			const linkArchive = join(root, "link-only.tar");
			writeFileSync(
				linkArchive,
				gnuTar(linkTree, ["opt/hobo-deps/evil"], false),
			);
			const linkPayload = join(root, "link-payload");
			await extractDepsTar(createReadStream(linkArchive), linkPayload);
			assert.equal(readlinkSync(join(linkPayload, "evil")), outside);
			assert.equal(snapshotTree(outside), before);

			const rejectThrough = async (
				label: string,
				prepare: (payload: string) => {
					paths: string[];
					extra?: string[];
				},
			): Promise<void> => {
				const tree = join(root, label);
				const payload = join(tree, "opt", "hobo-deps");
				mkdirSync(payload, { recursive: true });
				symlinkSync(outside, join(payload, "evil"));
				const spec = prepare(payload);
				const archive = join(root, `${label}.tar`);
				writeFileSync(
					archive,
					gnuTar(tree, spec.paths, false, spec.extra ?? []),
				);
				await assert.rejects(
					extractDepsTar(
						createReadStream(archive),
						join(root, `${label}-payload`),
					),
					/through a symlink/,
				);
				assert.equal(snapshotTree(outside), before);
				assert.equal(existsSync(join(outside, "sub")), false);
				assert.equal(existsSync(join(outside, "pwned")), false);
			};

			await rejectThrough("file", (payload) => {
				writeFileSync(join(payload, "pwned-src"), "pwned\n");
				return {
					paths: ["opt/hobo-deps/evil", "opt/hobo-deps/pwned-src"],
					extra: [
						"--transform",
						"s,^opt/hobo-deps/pwned-src$,opt/hobo-deps/evil/sub/pwned,",
					],
				};
			});
			await rejectThrough("dir", (payload) => {
				mkdirSync(join(payload, "newdir"));
				return {
					paths: ["opt/hobo-deps/evil", "opt/hobo-deps/newdir"],
					extra: [
						"--transform",
						"s,^opt/hobo-deps/newdir$,opt/hobo-deps/evil/newdir,",
					],
				};
			});
			await rejectThrough("symlink", (payload) => {
				symlinkSync("keep.txt", join(payload, "link-src"));
				return {
					paths: ["opt/hobo-deps/evil", "opt/hobo-deps/link-src"],
					extra: [
						"--transform",
						"s,^opt/hobo-deps/link-src$,opt/hobo-deps/evil/link,",
					],
				};
			});
			await rejectThrough("whiteout", (payload) => {
				writeFileSync(join(payload, "opq"), "");
				return {
					paths: ["opt/hobo-deps/evil", "opt/hobo-deps/opq"],
					extra: [
						"--transform",
						"s,^opt/hobo-deps/opq$,opt/hobo-deps/evil/.wh..wh..opq,",
					],
				};
			});
			await rejectThrough("hardlink", (payload) => {
				writeFileSync(join(payload, "target.txt"), "target\n");
				linkSync(join(payload, "target.txt"), join(payload, "alias"));
				return {
					paths: [
						"opt/hobo-deps/target.txt",
						"opt/hobo-deps/alias",
						"opt/hobo-deps/evil",
					],
					extra: [
						"--transform",
						"s,^opt/hobo-deps/alias$,opt/hobo-deps/evil/sub/pwned,",
					],
				};
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("docker materialize", () => {
	function payloadCopy(directory: string, marker: string): void {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, ".hobo-ci-deps-key"), `${marker}\n`);
	}

	it("copies a local image without pulling or contacting the registry", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-docker-local-"));
		const calls = dockerCalls();
		let fetched = 0;
		try {
			const docker: DepsDocker = {
				localImage: (ref) => ref === localDepsImageRef(key),
				remoteManifest: () => {
					calls.manifest += 1;
					return "hit";
				},
				login: () => {
					calls.login += 1;
				},
				pull: () => {
					calls.pull += 1;
				},
				copyPayload: (_ref, directory) => {
					calls.copy += 1;
					payloadCopy(directory, key);
				},
			};
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(root, "payload"),
				token: randomBytes(12).toString("hex"),
				docker,
				fetchImpl: async () => {
					fetched += 1;
					throw new Error("registry fetch");
				},
			});
			assert.deepEqual(result, { ok: true, source: "local" });
			assert.deepEqual(calls, { login: 1, pull: 0, manifest: 0, copy: 1 });
			assert.equal(fetched, 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("confirms a docker manifest miss with the registry and downloads no blob on a registry miss", async () => {
		const calls = dockerCalls();
		const token = randomBytes(12).toString("hex");
		const bearer = randomBytes(12).toString("hex");
		const registry = await startRegistry({
			token,
			bearer,
			key,
			manifestStatus: 404,
		});
		const docker: DepsDocker = {
			localImage: () => false,
			remoteManifest: () => {
				calls.manifest += 1;
				return "miss";
			},
			login: () => {
				calls.login += 1;
			},
			pull: () => {
				calls.pull += 1;
			},
			copyPayload: () => {
				calls.copy += 1;
			},
		};
		try {
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(tmpdir(), "hobo-docker-miss"),
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
				docker,
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "miss");
				assert.equal(result.detail.includes(token), false);
			}
			assert.equal(calls.manifest, 1);
			assert.equal(calls.pull, 0);
			assert.equal(calls.copy, 0);
			assert.equal(
				registry.hits.some((hit) => hit.includes("/blobs/")),
				false,
			);
		} finally {
			await registry.close();
		}
	});

	it("keeps a docker manifest miss a miss when the registry cannot be read", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-docker-miss-unreadable-"));
		const token = randomBytes(12).toString("hex");
		let fetched = 0;
		try {
			const payload = join(root, "payload");
			mkdirSync(payload);
			writeFileSync(join(payload, "stale"), "stale\n");
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: payload,
				token,
				docker: dockerReportingMiss(),
				fetchImpl: async () => {
					fetched += 1;
					throw new Error(`registry fetch ${token}`);
				},
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "miss");
				assert.equal(result.detail.includes(token), false);
			}
			assert.equal(fetched, 1);
			assert.equal(readFileSync(join(payload, "stale"), "utf8"), "stale\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a docker manifest miss a miss when the registry stops mid-manifest", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-docker-cut-"));
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		const payload = join(root, "payload");
		mkdirSync(payload);
		writeFileSync(join(payload, "stale"), "stale\n");
		let registry: Registry | undefined;
		try {
			registry = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body: Buffer.from("unused layer") }],
				cutOffManifest: true,
			});
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: payload,
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
				docker: dockerReportingMiss(),
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "miss");
				assert.equal(result.detail.includes(token), false);
			}
			assert.equal(readFileSync(join(payload, "stale"), "utf8"), "stale\n");
			assert.equal(
				registry.hits.some((hit) => hit.includes("/blobs/")),
				false,
			);
		} finally {
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a registry rejection after a docker manifest miss", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-docker-fail-"));
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		const tree = join(root, "tree");
		mkdirSync(join(tree, "opt", "hobo-deps"), { recursive: true });
		writeFileSync(
			join(tree, "opt", "hobo-deps", ".hobo-ci-deps-key"),
			`${key}\n`,
		);
		const body = gnuTar(tree, ["opt"], true);
		const escape = join(root, "escape");
		mkdirSync(join(escape, "opt", "hobo-deps"), { recursive: true });
		writeFileSync(join(escape, "opt", "hobo-deps", "keep.txt"), "keep\n");
		const escaped = gnuTar(escape, ["opt/hobo-deps/keep.txt"], false, [
			"--absolute-names",
			"--transform",
			"s,^opt/hobo-deps/keep.txt,opt/hobo-deps/foo/../../tmp/pwned,",
		]);
		const wrong = join(root, "wrong");
		mkdirSync(join(wrong, "opt", "hobo-deps"), { recursive: true });
		writeFileSync(
			join(wrong, "opt", "hobo-deps", ".hobo-ci-deps-key"),
			`${otherKey}\n`,
		);
		const uncapped = 8 * 1024 * 1024;
		const attempts: {
			name: string;
			registry: Parameters<typeof startRegistry>[0];
			maxLayerBytes: number;
			detail: RegExp;
		}[] = [
			{
				name: "token-rejection",
				registry: { token, bearer, key, tokenStatus: 401 },
				maxLayerBytes: uncapped,
				detail: /registry token 401/,
			},
			{
				name: "digest-mismatch",
				registry: {
					token,
					bearer,
					key,
					layers: [
						{
							mediaType: GZIP_LAYER,
							body,
							digest: sha256(Buffer.concat([body, Buffer.from("x")])),
						},
					],
				},
				maxLayerBytes: uncapped,
				detail: /digest/,
			},
			{
				name: "byte-cap",
				registry: {
					token,
					bearer,
					key,
					layers: [{ mediaType: GZIP_LAYER, body, size: body.length + 10 }],
				},
				maxLayerBytes: body.length,
				detail: /byte cap/,
			},
			{
				name: "tar-escape",
				registry: {
					token,
					bearer,
					key,
					layers: [{ mediaType: TAR_LAYER, body: escaped }],
				},
				maxLayerBytes: uncapped,
				detail: /escapes/,
			},
			{
				name: "payload-key",
				registry: {
					token,
					bearer,
					key,
					layers: [
						{ mediaType: GZIP_LAYER, body: gnuTar(wrong, ["opt"], true) },
					],
				},
				maxLayerBytes: uncapped,
				detail: /payload key/,
			},
		];
		try {
			for (const attempt of attempts) {
				const registry = await startRegistry(attempt.registry);
				try {
					const payload = join(root, attempt.name);
					mkdirSync(payload);
					writeFileSync(join(payload, "stale"), "stale\n");
					const result = await materializePublishedDepsLayer({
						repository,
						key,
						payloadDir: payload,
						actor: "ci-actor",
						token,
						registryBase: registry.base,
						fetchImpl: localFetch(registry.base),
						maxLayerBytes: attempt.maxLayerBytes,
						docker: dockerReportingMiss(),
					});
					assert.equal(result.ok, false, attempt.name);
					if (!result.ok) {
						assert.equal(result.kind, "failed", attempt.name);
						assert.match(result.detail, attempt.detail);
						assert.equal(result.detail.includes(token), false, attempt.name);
					}
					assert.equal(existsSync(payload), false, attempt.name);
				} finally {
					await registry.close();
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a transport failure after a docker manifest miss once extraction has begun", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-docker-blob-refused-"));
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		const tree = join(root, "tree");
		mkdirSync(join(tree, "opt", "hobo-deps"), { recursive: true });
		writeFileSync(
			join(tree, "opt", "hobo-deps", ".hobo-ci-deps-key"),
			`${key}\n`,
		);
		const payload = join(root, "payload");
		mkdirSync(payload);
		writeFileSync(join(payload, "stale"), "stale\n");
		let registry: Registry | undefined;
		try {
			registry = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body: gnuTar(tree, ["opt"], true) }],
				refuseBlobs: true,
			});
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: payload,
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
				docker: dockerReportingMiss(),
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "failed");
				assert.doesNotMatch(result.detail, /manifest missing/);
				assert.equal(result.detail.includes(token), false);
			}
			assert.equal(
				registry.hits.some((hit) => hit.includes("/blobs/")),
				true,
			);
			assert.equal(existsSync(payload), false);
		} finally {
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails an unreadable registry when docker did not report a miss", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-unreadable-"));
		const token = randomBytes(12).toString("hex");
		const docker: DepsDocker = {
			localImage: () => false,
			remoteManifest: () => "unavailable",
			login: () => undefined,
			pull: () => undefined,
			copyPayload: () => undefined,
		};
		try {
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(root, "payload"),
				token,
				docker,
				fetchImpl: async () => {
					throw new Error(`registry fetch ${token}`);
				},
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "failed");
				assert.match(result.detail, /\[redacted\]/);
				assert.equal(result.detail.includes(token), false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes from the registry when docker reports a miss the registry does not", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-docker-false-miss-"));
		const token = randomBytes(16).toString("hex");
		const bearer = randomBytes(16).toString("hex");
		const calls = dockerCalls();
		let registry: Registry | undefined;
		try {
			const tree = join(root, "tree");
			mkdirSync(join(tree, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(tree, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			registry = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body: gnuTar(tree, ["opt"], true) }],
			});
			const docker: DepsDocker = {
				localImage: () => false,
				remoteManifest: () => {
					calls.manifest += 1;
					return "miss";
				},
				login: () => {
					calls.login += 1;
				},
				pull: () => {
					calls.pull += 1;
				},
				copyPayload: () => {
					calls.copy += 1;
				},
			};
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(root, "payload"),
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
				docker,
			});
			assert.deepEqual(result, { ok: true, source: "ghcr" });
			assert.equal(calls.manifest, 1);
			assert.equal(calls.pull, 0);
			assert.equal(calls.copy, 0);
		} finally {
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a pull failure failed and redacts the token", async () => {
		const token = randomBytes(16).toString("hex");
		const docker: DepsDocker = {
			localImage: () => false,
			remoteManifest: () => "hit" satisfies ManifestProbe,
			login: () => undefined,
			pull: () => {
				throw new Error(`docker pull failed ${token}`);
			},
			copyPayload: () => undefined,
		};
		const result = await materializePublishedDepsLayer({
			repository,
			key,
			payloadDir: join(tmpdir(), "hobo-docker-pull"),
			token,
			docker,
			fetchImpl: async () => {
				throw new Error("registry fetch");
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.kind, "failed");
			assert.match(result.detail, /\[redacted\]/);
			assert.equal(result.detail.includes(token), false);
		}
		const recovery = decideDepsRecovery({
			materialized: false,
			warmStore: false,
			detail: result.ok ? "" : result.detail,
		});
		assert.equal(recovery.action, "fail");
	});

	it("uses the registry when login fails and no local image exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-docker-login-"));
		const token = randomBytes(16).toString("hex");
		const bearer = randomBytes(16).toString("hex");
		const calls = dockerCalls();
		let registry: Registry | undefined;
		try {
			const tree = join(root, "tree");
			mkdirSync(join(tree, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(tree, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			registry = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body: gnuTar(tree, ["opt"], true) }],
			});
			const docker: DepsDocker = {
				localImage: () => false,
				remoteManifest: () => {
					calls.manifest += 1;
					return "hit";
				},
				login: () => {
					calls.login += 1;
					throw new Error(`login refused ${token}`);
				},
				pull: () => {
					calls.pull += 1;
				},
				copyPayload: () => {
					calls.copy += 1;
				},
			};
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(root, "payload"),
				actor: "ci-actor",
				token,
				registryBase: registry.base,
				fetchImpl: localFetch(registry.base),
				docker,
			});
			assert.deepEqual(result, { ok: true, source: "ghcr" });
			assert.equal(calls.login, 1);
			assert.equal(calls.pull, 0);
			assert.equal(calls.manifest, 0);
			assert.equal(JSON.stringify(result).includes(token), false);
		} finally {
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("copies the local image when login fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-docker-login-local-"));
		const token = randomBytes(12).toString("hex");
		const calls = dockerCalls();
		let fetched = 0;
		try {
			const docker: DepsDocker = {
				localImage: (ref) => ref === localDepsImageRef(key),
				remoteManifest: () => "miss",
				login: () => {
					calls.login += 1;
					throw new Error(`login refused ${token}`);
				},
				pull: () => {
					calls.pull += 1;
				},
				copyPayload: (_ref, directory) => payloadCopy(directory, key),
			};
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: join(root, "payload"),
				token,
				docker,
				fetchImpl: async () => {
					fetched += 1;
					throw new Error("registry fetch");
				},
			});
			assert.deepEqual(result, { ok: true, source: "local" });
			assert.equal(calls.pull, 0);
			assert.equal(fetched, 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deletes a payload whose key does not match the checkout", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-docker-key-"));
		const payload = join(root, "payload");
		try {
			const docker: DepsDocker = {
				localImage: (ref) => ref === localDepsImageRef(key),
				remoteManifest: () => "miss",
				login: () => undefined,
				pull: () => undefined,
				copyPayload: (_ref, directory) => payloadCopy(directory, otherKey),
			};
			const result = await materializePublishedDepsLayer({
				repository,
				key,
				payloadDir: payload,
				docker,
			});
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.kind, "failed");
			assert.equal(existsSync(payload), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("materialize CLI and main build cache job", () => {
	function outputFiles(root: string) {
		const output = join(root, "output");
		const githubEnv = join(root, "github-env");
		writeFileSync(output, "");
		writeFileSync(githubEnv, "");
		return {
			output,
			githubEnv,
			env: {
				GITHUB_OUTPUT: output,
				GITHUB_ENV: githubEnv,
			},
		};
	}

	function pnpmOnPath(root: string, body: string): string {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		const pnpm = join(bin, "pnpm");
		writeFileSync(pnpm, body);
		chmodSync(pnpm, 0o755);
		return bin;
	}

	async function runCli(
		root: string,
		extra: NodeJS.ProcessEnv,
	): Promise<{
		status: number | null;
		stdout: string;
		stderr: string;
		output: string;
		githubEnv: string;
	}> {
		mkdirSync(root, { recursive: true });
		const files = outputFiles(root);
		const token = extra.GITHUB_TOKEN ?? randomBytes(18).toString("hex");
		const result = await runMaterializeCli(
			{
				...extra,
				GITHUB_REPOSITORY: extra.GITHUB_REPOSITORY ?? repository,
				GITHUB_ACTOR: "ci-actor",
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_DOCKER: "0",
				HOBO_CI_DEPS_IMAGE_REF: extra.HOBO_CI_DEPS_IMAGE_REF ?? key,
				HOBO_CI_DEPS_PAYLOAD:
					extra.HOBO_CI_DEPS_PAYLOAD ?? join(root, "payload"),
				GITHUB_OUTPUT: files.output,
				GITHUB_ENV: files.githubEnv,
				PATH: extra.PATH ?? process.env.PATH,
			},
			root,
		);
		return {
			status: result,
			stdout: "",
			stderr: "",
			output: readFileSync(files.output, "utf8"),
			githubEnv: readFileSync(files.githubEnv, "utf8"),
		};
	}

	it("writes layer outputs after a registry hit and fails a cold miss", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-cli-"));
		const token = randomBytes(18).toString("hex");
		const bearer = randomBytes(18).toString("hex");
		let registry: Registry | undefined;
		const previous = { log: console.log, error: console.error };
		const logs: string[] = [];
		const errors: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			const tree = join(root, "tree");
			mkdirSync(join(tree, "opt", "hobo-deps"), { recursive: true });
			writeFileSync(
				join(tree, "opt", "hobo-deps", ".hobo-ci-deps-key"),
				`${key}\n`,
			);
			registry = await startRegistry({
				token,
				bearer,
				key,
				layers: [{ mediaType: GZIP_LAYER, body: gnuTar(tree, ["opt"], true) }],
			});
			const payload = join(root, "payload");
			const hit = await runCli(root, {
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_REGISTRY_BASE: registry.base,
				HOBO_CI_DEPS_PAYLOAD: payload,
				PATH: pnpmOnPath(join(root, "hit"), "#!/bin/sh\nexit 1\n"),
			});
			assert.equal(hit.status, 0);
			assert.match(hit.output, /materialized=true/);
			assert.match(hit.output, /source=ghcr/);
			assert.match(hit.output, /install=false/);
			assert.match(hit.githubEnv, new RegExp(`HOBO_CI_DEPS_LAYER=${key}`));
			assert.equal(hit.githubEnv.includes("HOBO_CI_DEPS_PAYLOAD"), false);
			const missRoot = join(root, "miss");
			mkdirSync(join(missRoot, "empty"), { recursive: true });
			const missing = await startRegistry({
				token,
				bearer,
				key,
				manifestStatus: 404,
			});
			try {
				const cold = await runCli(missRoot, {
					GITHUB_TOKEN: token,
					HOBO_CI_DEPS_REGISTRY_BASE: missing.base,
					HOBO_CI_PNPM_STORE_DIR: join(missRoot, "empty"),
					PATH: `${pnpmOnPath(missRoot, "#!/bin/sh\nexit 1\n")}${delimiter}${process.env.PATH ?? ""}`,
				});
				assert.equal(cold.status, 1);
			} finally {
				await missing.close();
			}
			const text = `${logs.join("\n")}\n${errors.join("\n")}`;
			assert.match(text, /::error title=hobo-ci-deps-layer-unavailable::/);
			assert.match(text, /hobo-ci-deps-layer-unavailable:/);
			assert.equal(text.includes(token), false);
			assert.equal(text.includes(bearer), false);
		} finally {
			console.log = previous.log;
			console.error = previous.error;
			await registry?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows install only when a warm store is actually present", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-warm-cli-"));
		const token = randomBytes(12).toString("hex");
		const bearer = randomBytes(12).toString("hex");
		const registry = await startRegistry({
			token,
			bearer,
			key,
			manifestStatus: 404,
		});
		const previous = { log: console.log, error: console.error };
		console.log = () => undefined;
		console.error = () => undefined;
		try {
			const filled = join(root, "filled");
			mkdirSync(filled);
			writeFileSync(join(filled, "entry"), "1");
			const mounted = await runCli(join(root, "mounted"), {
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_REGISTRY_BASE: registry.base,
				HOBO_CI_PNPM_STORE_MOUNTED: "1",
				PATH: pnpmOnPath(join(root, "mounted-bin"), "#!/bin/sh\nexit 1\n"),
			});
			assert.equal(mounted.status, 0);
			assert.match(mounted.output, /install=true/);
			assert.match(mounted.output, /reason=warm-pnpm-store/);
			assert.match(mounted.output, /source=miss/);
			const shared = await runCli(join(root, "shared"), {
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_REGISTRY_BASE: registry.base,
				HOBO_CI_PNPM_STORE_DIR: filled,
				PATH: pnpmOnPath(join(root, "shared-bin"), "#!/bin/sh\nexit 1\n"),
			});
			assert.equal(shared.status, 0);
			assert.match(shared.output, /install=true/);
			const reported = join(root, "reported");
			mkdirSync(reported);
			writeFileSync(join(reported, "entry"), "1");
			const store = await runCli(join(root, "store"), {
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_REGISTRY_BASE: registry.base,
				PATH: pnpmOnPath(
					join(root, "store-bin"),
					`#!/bin/sh\necho ${JSON.stringify(reported)}\n`,
				),
			});
			assert.equal(store.status, 0);
			assert.match(store.output, /reason=warm-pnpm-store/);
		} finally {
			console.log = previous.log;
			console.error = previous.error;
			await registry.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("installs from a warm store when the repository or key is rejected", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-pre-attempt-"));
		const token = randomBytes(18).toString("hex");
		const previous = { log: console.log, error: console.error };
		const logs: string[] = [];
		const errors: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			const filled = join(root, "filled");
			const empty = join(root, "empty");
			mkdirSync(filled);
			mkdirSync(empty);
			writeFileSync(join(filled, "entry"), "1");
			const path = `${pnpmOnPath(join(root, "bin"), "#!/bin/sh\nexit 1\n")}${delimiter}${process.env.PATH ?? ""}`;
			const ref = `ghcr.io/hobo-labs/hobo/hobo-ci-deps:${key}`;
			const warmRepo = await runCli(join(root, "warm-repo"), {
				GITHUB_TOKEN: token,
				GITHUB_REPOSITORY: "not a repo",
				HOBO_CI_PNPM_STORE_DIR: filled,
				PATH: path,
			});
			assert.equal(warmRepo.status, 0);
			assert.match(warmRepo.output, /materialized=false/);
			assert.equal(warmRepo.output.includes("materialized=true"), false);
			assert.match(warmRepo.output, /install=true/);
			assert.match(warmRepo.output, /reason=warm-pnpm-store/);
			assert.match(warmRepo.output, /source=failed/);
			const coldRepo = await runCli(join(root, "cold-repo"), {
				GITHUB_TOKEN: token,
				GITHUB_REPOSITORY: "not a repo",
				HOBO_CI_PNPM_STORE_DIR: empty,
				PATH: path,
			});
			assert.equal(coldRepo.status, 1);
			assert.equal(coldRepo.output.includes("install=true"), false);
			const warmKey = await runCli(join(root, "warm-key"), {
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_IMAGE_REF: ref,
				HOBO_CI_PNPM_STORE_DIR: filled,
				PATH: path,
			});
			assert.equal(warmKey.status, 0);
			assert.match(warmKey.output, /materialized=false/);
			assert.match(warmKey.output, /install=true/);
			assert.match(warmKey.output, /reason=warm-pnpm-store/);
			const coldKey = await runCli(join(root, "cold-key"), {
				GITHUB_TOKEN: token,
				HOBO_CI_DEPS_IMAGE_REF: ref,
				HOBO_CI_PNPM_STORE_DIR: empty,
				PATH: path,
			});
			assert.equal(coldKey.status, 1);
			assert.equal(coldKey.output.includes("install=true"), false);
			const text = `${logs.join("\n")}\n${errors.join("\n")}\n${warmRepo.output}\n${warmKey.output}\n${coldRepo.output}\n${coldKey.output}`;
			assert.equal(text.includes(token), false);
			assert.match(
				errors.join("\n"),
				/::error title=hobo-ci-deps-layer-unavailable::/,
			);
		} finally {
			console.log = previous.log;
			console.error = previous.error;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins the main build cache job to a published layer or a warm store", () => {
		const source = readFileSync(script, "utf8");
		assert.equal(source.includes("build-deps.sh"), false);
		assert.equal(source.includes("hobo-ci-deps:local"), false);
		assert.equal(source.includes("docker tag"), false);
		const text = readFileSync(workflow, "utf8");
		const start = text.indexOf("\n  main_build_cache:\n");
		const end = text.indexOf("\n  main_gate_finish:\n", start);
		assert.ok(start > 0 && end > start);
		const job = text.slice(start, end);
		assert.deepEqual(
			[...job.matchAll(/timeout-minutes:\s*(\d+)/g)].map((match) => match[1]),
			["20", "8", "15"],
		);
		assert.match(job, /packages: read/);
		assert.equal(job.includes("build-deps.sh"), false);
		assert.equal(job.includes("hobo-ci-deps:local"), false);
		assert.match(job, /scripts\/ci\/materialize-ghcr-deps-layer\.mts/);
		assert.match(job, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
		assert.match(
			job,
			/steps\.deps-materialize\.outputs\.install == 'true' && steps\.deps-layer-ghcr\.outputs\.match != 'true'/,
		);
		assert.match(job, /title=hobo-ci-deps-layer-unavailable/);
		const order = [
			"name: Link deps layer",
			"id: deps-layer",
			"uses: $/.github/actions/pnpm-store",
			"id: deps-materialize",
			"name: Link published GHCR deps layer",
			"id: deps-layer-ghcr",
			"name: Verify deps layer sibling links",
			"name: Install dependencies",
			"name: Require a deps layer or a warm pnpm store",
			"name: Build every package",
		];
		let cursor = 0;
		for (const marker of order) {
			const at = job.indexOf(marker, cursor);
			assert.ok(at > cursor, marker);
			cursor = at + marker.length;
		}
		assert.equal(job.split("pnpm-store").length, 2);
		const docs = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				"docs",
				"maintenance",
				"ci-performance.md",
			),
			"utf8",
		);
		assert.match(docs, /hobo-ci-deps-layer-unavailable/);
		assert.match(docs, /hobo-ci-deps:<checkout-key>/);
		assert.match(docs, /continue-on-error/);
		assert.match(docs, /token` input/);
	});

	it("passes the packages token into ci-deps-recovery instead of the env context", () => {
		const action = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/actions/ci-deps-recovery/action.yml",
			),
			"utf8",
		);
		assert.match(action, /GITHUB_TOKEN: \$\{\{ inputs\.token \}\}/);
		assert.equal(action.includes("${{ env.GITHUB_TOKEN }}"), false);
		const release = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const start = release.indexOf("\n  release-pages-browser-wit-smoke:\n");
		const end = release.indexOf("\n  release-realize:\n", start);
		assert.ok(start > 0 && end > start);
		const job = release.slice(start, end);
		const recovery = job.indexOf("uses: $/.github/actions/ci-deps-recovery");
		const install = job.indexOf("Install Pages dependencies");
		assert.ok(recovery > 0 && install > recovery);
		const step = job.slice(recovery, install);
		assert.match(step, /continue-on-error: true/);
		assert.match(step, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
		assert.equal(step.includes("env.GITHUB_TOKEN"), false);
	});

	it("recovers release OCI image builds from the published deps layer", () => {
		const release = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const job = (id: string, next: string) => {
			const start = release.indexOf(`\n  ${id}:\n`);
			const end = release.indexOf(`\n  ${next}:\n`, start);
			assert.ok(start > 0 && end > start, id);
			return release.slice(start, end);
		};
		for (const [id, next] of [
			["release-oci-build-tag", "release-oci-build-cli"],
			["release-oci-build-cli", "release-oci-build-mcp"],
			["release-oci-build-mcp", "release-images"],
		] as const) {
			const block = job(id, next);
			const fetchAt = block.indexOf("pnpm run pins:fetch ts-autocode");
			const recoveryAt = block.indexOf(
				"uses: $/.github/actions/ci-deps-recovery",
			);
			assert.ok(fetchAt > 0 && recoveryAt > fetchAt, id);
			const step = block.slice(
				recoveryAt,
				block.indexOf("\n      - ", recoveryAt + 1),
			);
			assert.match(step, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
			assert.equal(step.includes("continue-on-error"), false, id);
			assert.equal(step.includes("env.GITHUB_TOKEN"), false, id);
			assert.equal(block.includes("Link deps layer or install"), false, id);
			assert.match(block, /packages: read/);
		}
	});
});
