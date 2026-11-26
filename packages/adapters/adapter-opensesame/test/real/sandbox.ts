/**
 * A hermetic home for the real OpenSesame: every call runs with a cleared
 * environment and a home inside the sandbox, as a person's shell would start
 * it. The plugin is installed through `plugins install` with its sha256 pin and
 * switched on; the token is sealed with `pass insert` (stdin, never an
 * argument); the store is unlocked with OPENSESAME_STORE_PASSWORD, which the
 * run strips from the child. Nothing here reads the developer's own configuration.
 * Modelled on OpenSesame's apps/cli/tests/proxied_run_support/mod.rs.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../../src/json.js";
import type { Kit } from "./kit.js";
import { filesNaming } from "./sweep.js";
import { mintPki, type Pki, UPSTREAM_HOST, type Upstream } from "./tls.js";

export const STORE_PASSPHRASE = "store-passphrase-for-tests";

/**
 * What a person's shell would hand OpenSesame beyond the adapter's allowlist
 * (HOME, PATH, XDG_* and NODE_* already pass): where the store is, how to unlock
 * it, the test build's upstream, and git's isolation.
 */
export const SANDBOX_PASS_ENV: readonly string[] = [
	"OPENSESAME_STORE_DIR",
	"OPENSESAME_TOMBS_CONFIG",
	"OPENSESAME_STORE_PASSWORD",
	"OPENSESAME_SURROGATE_TEST_UPSTREAM",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
];
export const CONNECTION_ENTRY = "connections/acme/vercel";
const SEED = createHash("sha256").update(String(process.pid)).digest("hex");
let sequence = 0;

export type Cli = Readonly<{
	status: number | null;
	stdout: string;
	stderr: string;
}>;

export class Sandbox {
	readonly root: string;
	readonly pki: Pki;
	/** This sandbox's dummy token; no other sandbox shares it. */
	readonly token: string;
	private installed: string | undefined;

	private constructor(
		readonly kit: Kit,
		root: string,
	) {
		this.root = root;
		sequence += 1;
		this.token = `vtok_dummy_marker_${SEED.slice(0, 8)}${sequence.toString(16).padStart(8, "0")}`;
		for (const dir of ["home", "work", "out", "pki"]) {
			mkdirSync(join(root, dir), { recursive: true });
		}
		this.pki = mintPki(join(root, "pki"));
	}

	static create(kit: Kit): Sandbox {
		return new Sandbox(
			kit,
			mkdtempSync(join(tmpdir(), "hobo-opensesame-real-")),
		);
	}

	path(name: string): string {
		return join(this.root, name);
	}

	/** The environment of a person's shell, in the sandbox. */
	env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
		const home = this.path("home");
		return {
			PATH: process.env.PATH ?? "",
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local/share"),
			XDG_STATE_HOME: join(home, ".local/state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			OPENSESAME_STORE_DIR: this.path("store"),
			OPENSESAME_TOMBS_CONFIG: this.path("tombs.json"),
			OPENSESAME_ENV_PARSE: this.kit.bridge,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			NODE_NO_WARNINGS: "1",
			...extra,
		};
	}

	/** The environment of a proxied run: this one, unlocked, aimed at `upstream`. */
	runEnv(upstream: Upstream, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
		return this.env({
			OPENSESAME_STORE_PASSWORD: STORE_PASSPHRASE,
			OPENSESAME_SURROGATE_TEST_UPSTREAM: `${UPSTREAM_HOST}=127.0.0.1:${upstream.port},ca=${this.pki.caPem}`,
			...extra,
		});
	}

	cli(
		args: readonly string[],
		env: NodeJS.ProcessEnv = this.env(),
		input?: string,
	): Cli {
		const result = spawnSync(this.kit.opensesame, [...args], {
			env,
			input,
			encoding: "utf8",
			cwd: this.path("work"),
			timeout: 120_000,
		});
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}

	private ok(
		args: readonly string[],
		env?: NodeJS.ProcessEnv,
		input?: string,
	): Cli {
		const result = this.cli(args, env, input);
		if (result.status !== 0) {
			throw new Error(
				`opensesame ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
			);
		}
		return result;
	}

	init(): void {
		this.ok(
			["pass", "init", "--path", this.path("store")],
			this.env({ OPENSESAME_STORE_PASSWORD: STORE_PASSPHRASE }),
		);
	}

	/** `pass insert <name>` with `secret` on stdin, as a pipe does it. */
	seal(name: string, secret: string): void {
		this.ok(
			["pass", "insert", name],
			this.env({ OPENSESAME_STORE_PASSWORD: STORE_PASSPHRASE }),
			`${secret}\n`,
		);
	}

	/** Install the plugin pinned by the sha256 of its bytes, then switch it on. */
	installPlugin(): string {
		const pin = createHash("sha256")
			.update(readFileSync(this.kit.plugin))
			.digest("hex");
		const installed = this.ok([
			"plugins",
			"install",
			"surrogate-proxy",
			"--from",
			this.kit.plugin,
			"--sha256",
			pin,
			"--version",
			"0.1.0",
		]);
		const location = locationOf(installed.stdout);
		this.ok(["plugins", "enable", "surrogate-proxy"]);
		this.installed = location;
		return location;
	}

	disablePlugin(): void {
		this.ok(["plugins", "disable", "surrogate-proxy"]);
	}

	installedPlugin(): string {
		if (this.installed === undefined)
			throw new Error("the plugin was not installed");
		return this.installed;
	}

	/** init, seal the dummy token under the connection's entry, install and enable the plugin. */
	setUp(): void {
		this.init();
		this.seal(CONNECTION_ENTRY, this.token);
		this.installPlugin();
	}

	/** The plugin's recorded notices, as event types. */
	noticeKinds(): string[] {
		const listed = parseJsonValue(
			this.ok(["plugins", "notices", "surrogate-proxy"]).stdout,
		);
		const notices = isJsonObject(listed) ? listed.notices : null;
		if (!isJsonArray(notices)) return [];
		return notices.flatMap((notice) => {
			const kind = isJsonObject(notice) ? notice.event_type : null;
			return isJsonString(kind) ? [kind] : [];
		});
	}

	/** Everything under the sandbox that holds `needle`: the sealed store included. */
	filesNaming(needle: string): string[] {
		return filesNaming(this.root, needle);
	}

	cleanup(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}

function locationOf(stdout: string): string {
	const parsed = parseJsonValue(stdout);
	const location = isJsonObject(parsed) ? parsed.location : null;
	if (!isJsonString(location))
		throw new Error("plugins install printed no location");
	return location;
}
