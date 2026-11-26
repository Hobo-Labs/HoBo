/**
 * Nothing the pin code asks of the network can hang: every git call that
 * touches it and every download is bounded by HOBO_PINS_NET_TIMEOUT_MS
 * (default 120 s, at most 600 s), git is told to give up on a link slower
 * than 1000 bytes/s for 30 s, and running out is a NET_TIMEOUT that names
 * the call, with nothing staged or kept.
 *
 * The other side is a server that accepts every connection and never says a
 * word; the tests set a short bound and kill a run that outlives it by far.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	type AddressInfo,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { PinsError } from "../lib/pins.ts";
import { netArgs } from "../lib/pins-git-net.ts";
import {
	DEFAULT_NET_TIMEOUT_MS,
	MAX_NET_TIMEOUT_MS,
	netTimeoutMs,
} from "../lib/pins-net.ts";
import {
	type FileServer,
	git,
	makeRemote,
	makeWork,
	runBootstrap,
	type ScriptRun,
	scratch,
	sha256Hex,
	spawnBootstrap,
	startServer,
	writeManifest,
} from "./support/pins-support.ts";

const SHORT = { HOBO_PINS_NET_TIMEOUT_MS: "1500" };
/** Far past the short bound: a run still alive then is hanging. */
const KILL_AFTER_MS = 25_000;

let tarpit: { server: Server; sockets: Socket[] } | undefined;
let files: FileServer | undefined;
afterEach(async () => {
	for (const socket of tarpit?.sockets ?? []) socket.destroy();
	await new Promise((resolve) => tarpit?.server.close(resolve) ?? resolve(0));
	tarpit = undefined;
	await files?.close();
	files = undefined;
});

/** A TCP server that accepts and never answers; the URL of a repository on it. */
async function silentRepo(): Promise<string> {
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	tarpit = { server, sockets };
	// SAFETY: listen(0, host) binds a TCP socket, so address() is an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}/o/r.git`;
}

/** The real script, killed if it is still running long after the bound. */
async function bounded(
	root: string,
	args: readonly string[],
): Promise<ScriptRun & { readonly ms: number; readonly killed: boolean }> {
	const started = Date.now();
	const running = spawnBootstrap(root, args, SHORT);
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		running.child.kill("SIGKILL");
		// A git it started may outlive it and hold the pipes open; the sockets
		// are closed in afterEach, which ends that git too.
		running.child.stdout?.destroy();
		running.child.stderr?.destroy();
	}, KILL_AFTER_MS);
	const ended = await running.done;
	clearTimeout(timer);
	return { ...ended, ms: Date.now() - started, killed };
}

interface Pointed {
	readonly work: string;
	/** The commit the submodule is checked out at. */
	readonly head: string;
}

/** An initialised work tree whose manifest, .gitmodules and config all name `url`. */
function pointedAt(url: string): Pointed {
	const dir = scratch("timeout-git");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 0);
	const init = runBootstrap(work, []);
	assert.equal(init.status, 0, init.stderr);
	const file = join(work, "tools/pins/siblings.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	manifest.git.lib.repo = url;
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(
		join(work, ".gitmodules"),
		`[submodule "external/lib"]\n\tpath = external/lib\n\turl = ${url}\n`,
	);
	git(work, ["config", "submodule.external/lib.url", url]);
	return { work, head: git(join(work, "external/lib"), ["rev-parse", "HEAD"]) };
}

describe("HOBO_PINS_NET_TIMEOUT_MS", () => {
	it("is 120 s unless set, and must be a whole number of ms from 1 to 600000", () => {
		assert.equal(netTimeoutMs({}), DEFAULT_NET_TIMEOUT_MS);
		assert.equal(DEFAULT_NET_TIMEOUT_MS, 120_000);
		assert.equal(netTimeoutMs({ HOBO_PINS_NET_TIMEOUT_MS: "" }), 120_000);
		assert.equal(netTimeoutMs({ HOBO_PINS_NET_TIMEOUT_MS: "1" }), 1);
		assert.equal(
			netTimeoutMs({ HOBO_PINS_NET_TIMEOUT_MS: "600000" }),
			MAX_NET_TIMEOUT_MS,
		);
		for (const bad of [
			"0",
			"600001",
			"-5",
			"1.5",
			"1e3",
			" 5",
			"abc",
			"0x10",
			"9999999",
		]) {
			assert.throws(
				() => netTimeoutMs({ HOBO_PINS_NET_TIMEOUT_MS: bad }),
				(error: Error) => error instanceof PinsError && error.code === "USAGE",
				bad,
			);
		}
	});

	it("an invalid value is a usage error before anything runs", () => {
		const root = scratch("timeout-usage");
		writeManifest(root, '{"tool":null}');
		const run = runBootstrap(root, ["--status"], {
			HOBO_PINS_NET_TIMEOUT_MS: "soon",
		});
		assert.equal(run.status, 2, run.stderr);
		assert.match(run.stderr, /HOBO_PINS_NET_TIMEOUT_MS=soon must be/u);
	});

	it("every network git call gives up on a link slower than 1000 bytes/s for 30 s", () => {
		const args = netArgs(["fetch", "x"]);
		for (const setting of ["http.lowSpeedLimit=1000", "http.lowSpeedTime=30"]) {
			const at = args.indexOf(setting);
			assert.ok(at > 0 && args[at - 1] === "-c", setting);
		}
	});
});

describe("a server that never answers", () => {
	it("bump times out naming the call, and stages nothing", async () => {
		const { work, head } = pointedAt(await silentRepo());
		const run = await bounded(work, ["--bump", "lib", head]);
		assert.equal(run.killed, false, `still running after ${KILL_AFTER_MS} ms`);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/NET_TIMEOUT: git fetch .*127\.0\.0\.1.* got no answer within 1500 ms/u,
		);
		assert.equal(
			git(work, ["diff", "--cached", "--name-only"]),
			"",
			"nothing staged",
		);
	});

	it("status --online times out naming the call", async () => {
		const { work } = pointedAt(await silentRepo());
		const run = await bounded(work, ["--status", "--online"]);
		assert.equal(run.killed, false, `still running after ${KILL_AFTER_MS} ms`);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/NET_TIMEOUT: git ls-remote .* got no answer within 1500 ms/u,
		);
	});

	it("init times out naming the call, and leaves the gitlink alone", async () => {
		const url = await silentRepo();
		const dir = scratch("timeout-init");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1, { repo: url });
		writeFileSync(
			join(work, ".gitmodules"),
			`[submodule "external/lib"]\n\tpath = external/lib\n\turl = ${url}\n`,
		);
		const run = await bounded(work, []);
		assert.equal(run.killed, false, `still running after ${KILL_AFTER_MS} ms`);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/NET_TIMEOUT: git submodule update .* got no answer/u,
		);
		assert.match(
			git(work, ["ls-files", "-s", "external/lib"]),
			new RegExp(remote.shas[1] ?? "-"),
		);
	});

	it("a download times out naming the URL, and the cache keeps nothing", async () => {
		files = await startServer();
		files.setHang("/hang");
		const root = scratch("timeout-download");
		const bytes = Buffer.from("pinned build\n");
		const file = {
			url: `${files.origin}/hang`,
			sha256: sha256Hex(bytes),
			size: bytes.byteLength,
			entry: "tool",
		};
		writeManifest(
			root,
			`{"mirror":{"repo":"${files.origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(file)},"linux-arm64":${JSON.stringify(file)}}}}`,
		);
		const run = await bounded(root, ["--fetch", "mirror"]);
		assert.equal(run.killed, false, `still running after ${KILL_AFTER_MS} ms`);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/NET_TIMEOUT: .*\/hang got no answer within 1500 ms/u,
		);
		assert.equal(
			existsSync(join(root, ".cache/siblings", file.sha256)),
			false,
			"no directory, no partial file",
		);
	});
});
