/**
 * Service installers (design §6.15 `hobo fleet service install`, O36): the
 * systemd user unit, the launchd agent and the Windows scheduled task each
 * equal their fixture, and an unsafe command line is refused.
 */
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installService } from "../../src/install/index.js";
import {
	renderLaunchdPlist,
	renderSystemdUnit,
	renderWindowsTask,
	serviceEnvironment,
} from "../../src/install/render.js";

const fixture = (name: string) =>
	readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const POSIX_ARGV = [
	"/usr/local/bin/node",
	"/opt/hobo/bin/hobo.js",
	"fleet",
	"run",
	"--fleets",
	"build,deploy",
] as const;
const WINDOWS_ARGV = [
	"C:\\Program Files\\nodejs\\node.exe",
	"C:\\Users\\dev\\My Tools\\hobo.js",
	"fleet",
	"run",
	"--fleets",
	"build,deploy",
] as const;
const ENVIRONMENT = {
	HOBO_FLEET_KEYSTORE: "file",
	HOBO_FLEET_AUTHORITY_URL: "https://fleet.example.test",
} as const;

describe("the rendered definitions", () => {
	it("systemd: equals the fixture", async () => {
		expect(renderSystemdUnit(POSIX_ARGV, ENVIRONMENT)).toBe(
			await fixture("hobo-fleet.service"),
		);
	});

	it("launchd: equals the fixture", async () => {
		expect(renderLaunchdPlist(POSIX_ARGV, ENVIRONMENT)).toBe(
			await fixture("dev.hobo.fleet.plist"),
		);
	});

	it("Windows: equals the fixture", async () => {
		expect(renderWindowsTask(WINDOWS_ARGV)).toBe(
			await fixture("hobo-fleet.xml"),
		);
	});

	it("systemd: quotes and escapes what systemd would expand", () => {
		const unit = renderSystemdUnit(
			["/bin/run", 'say "hi"', "100%", "$HOME", "back\\slash"],
			{},
		);
		expect(unit).toContain(
			'ExecStart="/bin/run" "say \\"hi\\"" "100%%" "$$HOME" "back\\\\slash"',
		);
		expect(unit).not.toContain("Environment=");
	});

	it("launchd: escapes XML", () => {
		const plist = renderLaunchdPlist(["/bin/run", "<a&b>"], {});
		expect(plist).toContain("<string>&lt;a&amp;b&gt;</string>");
		expect(plist).not.toContain("EnvironmentVariables");
	});

	it("Windows: quotes arguments the way CommandLineToArgvW reads them", () => {
		const task = renderWindowsTask([
			"C:\\node.exe",
			"",
			'say "hi"',
			"C:\\dir with space\\",
			"plain",
		]);
		expect(task).toContain(
			'<Arguments>"" "say \\"hi\\"" "C:\\dir with space\\\\" plain</Arguments>',
		);
	});

	it("passes on only the HOBO_FLEET_ variables the agent reads, never a test-only one", () => {
		expect(
			serviceEnvironment({
				HOBO_FLEET_AUTHORITY_URL: "https://a.test",
				HOBO_FLEET_TENANT: "acme",
				HOBO_FLEET_NATS_SERVER_BIN: "/bin/nats-server",
				HOBO_FLEET_UNKNOWN: "x",
				PATH: "/bin",
			}),
		).toEqual({
			HOBO_FLEET_AUTHORITY_URL: "https://a.test",
			HOBO_FLEET_TENANT: "acme",
		});
	});
});

describe("installService", () => {
	const saved = new Map<string, string | undefined>();
	let home = "";

	const setEnv = (name: string, value: string | undefined) => {
		if (!saved.has(name)) saved.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "hobo-fleet-install-"));
		setEnv("HOME", home);
		setEnv("USERPROFILE", home);
		setEnv("XDG_CONFIG_HOME", undefined);
		for (const name of Object.keys(process.env))
			if (name.startsWith("HOBO_FLEET_")) setEnv(name, undefined);
		for (const [name, value] of Object.entries(ENVIRONMENT))
			setEnv(name, value);
	});

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	it("writes the systemd user unit and answers its path", async () => {
		const installed = await installService("linux", POSIX_ARGV);
		expect(installed).toEqual({
			ok: true,
			value: join(home, ".config", "systemd", "user", "hobo-fleet.service"),
		});
		if (!installed.ok) return;
		expect(await readFile(installed.value, "utf8")).toBe(
			await fixture("hobo-fleet.service"),
		);
		expect((await stat(installed.value)).mode & 0o777).toBe(0o644);
	});

	it("honours XDG_CONFIG_HOME for the systemd unit", async () => {
		const config = join(home, "xdg");
		setEnv("XDG_CONFIG_HOME", config);
		const installed = await installService("linux", POSIX_ARGV);
		expect(installed.ok && installed.value).toBe(
			join(config, "systemd", "user", "hobo-fleet.service"),
		);
	});

	it("writes the launchd agent", async () => {
		const installed = await installService("darwin", POSIX_ARGV);
		expect(installed.ok && installed.value).toBe(
			join(home, "Library", "LaunchAgents", "dev.hobo.fleet.plist"),
		);
		if (!installed.ok) return;
		expect(await readFile(installed.value, "utf8")).toBe(
			await fixture("dev.hobo.fleet.plist"),
		);
	});

	it("writes the Windows scheduled task", async () => {
		const installed = await installService("win32", WINDOWS_ARGV);
		expect(installed.ok && installed.value).toBe(
			join(home, "AppData", "Local", "hobo", "hobo-fleet.xml"),
		);
		if (!installed.ok) return;
		expect(await readFile(installed.value, "utf8")).toBe(
			await fixture("hobo-fleet.xml"),
		);
	});

	it("replaces an earlier installation", async () => {
		await installService("linux", [...POSIX_ARGV, "--old"]);
		const installed = await installService("linux", POSIX_ARGV);
		if (!installed.ok) throw new Error(installed.error.message);
		expect(await readFile(installed.value, "utf8")).toBe(
			await fixture("hobo-fleet.service"),
		);
	});

	it("refuses a platform with no service manager it knows", async () => {
		const refused = await installService("freebsd", POSIX_ARGV);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.code).toBe("invalid-request");
	});

	it("refuses an empty command, a relative program and a control character", async () => {
		for (const argv of [
			[],
			["node", "hobo.js"],
			["/bin/node", "line\nbreak"],
			["/bin/node", "nul\u0000"],
		]) {
			const refused = await installService("linux", argv);
			expect(refused.ok, JSON.stringify(argv)).toBe(false);
		}
		const windows = await installService("win32", ["/usr/bin/node"]);
		expect(windows.ok).toBe(false);
	});

	it("refuses a bootstrap token on the command line, and never writes it", async () => {
		const refused = await installService("linux", [
			"/bin/node",
			"fleet",
			"enroll",
			"hft_secret-token",
		]);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.message).not.toContain("hft_secret");
		await expect(
			stat(join(home, ".config", "systemd", "user", "hobo-fleet.service")),
		).rejects.toThrow();
	});
});
