import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { afterEach, expect, it } from "vitest";
import pact from "../contracts/ci-github-device.pact.json";
import { createCiCommand } from "../src/ci-command.js";

const accountToken = "account-token-".repeat(4);
const userToken = "ghu_test_user_token_do_not_print";
const homes: string[] = [];
afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});

async function fixture(options: {
	fetch: typeof fetch;
	answers?: string[];
	interactive?: boolean;
}) {
	const home = await mkdtemp(join(tmpdir(), "hobo-ci-github-"));
	homes.push(home);
	const opened: string[] = [];
	const progress: string[] = [];
	const waits: number[] = [];
	let now = 1_000_000;
	const answers = [...(options.answers ?? [])];
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: home, HOBO_CI_ACCOUNT_TOKEN: accountToken },
				interactive: options.interactive ?? true,
				fetch: options.fetch,
				git: async (args) =>
					args[0] === "rev-parse"
						? home
						: args.length === 1
							? "origin"
							: "git@github.com:example/project.git",
				prompt: async () => answers.shift() ?? "",
				openBrowser: (url) => {
					opened.push(url);
				},
				sleep: async (ms) => {
					waits.push(ms);
					now += ms;
				},
				now: () => now,
			}),
		},
	});
	const run = (extra: string[] = []) =>
		cli.run(
			[
				"ci",
				"connect",
				"github",
				"--relay",
				"https://relay.example",
				"--yes",
				"--accept-all-matching-jobs",
				...extra,
			],
			{ cwd: home, onProgress: (message) => progress.push(message) },
		);
	return { home, opened, progress, waits, run };
}

const device = pact.interactions[0]?.response.body;
if (!device || !("device_code" in device))
	throw new Error("missing device contract");
const authorize = () =>
	Response.json({
		authorizeUrl:
			"https://github.com/login/oauth/authorize?client_id=Iv1.test-client&state=secret-state",
	});

it("registers, verifies device flow, waits for installation, and connects the repository without exposing tokens", async () => {
	let starts = 0;
	let deviceStarts = 0;
	let polls = 0;
	let installs = 0;
	let connected = false;
	const send: typeof fetch = async (url, init) => {
		const target = new URL(String(url));
		expect(init?.redirect).toBe("error");
		if (target.origin === "https://relay.example")
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer ${accountToken}`,
			);
		if (target.pathname === "/v1/app-registration/oauth/start") {
			starts++;
			return starts < 3
				? Response.json({ error: "not ready" }, { status: 503 })
				: authorize();
		}
		if (target.href === "https://github.com/login/device/code") {
			const contract = pact.interactions[0];
			expect(init?.method).toBe(contract?.request.method);
			expect(String(init?.body)).toBe(contract?.request.body);
			expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
				Object.fromEntries(new Headers(contract?.request.headers)),
			);
			deviceStarts++;
			return deviceStarts === 1
				? Response.json({ error: "device_flow_disabled" })
				: Response.json(device);
		}
		if (target.href === "https://github.com/login/oauth/access_token") {
			const contract = pact.interactions[1];
			expect(init?.method).toBe(contract?.request.method);
			expect(String(init?.body)).toBe(contract?.request.body);
			expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
				Object.fromEntries(new Headers(contract?.request.headers)),
			);
			polls++;
			if (polls === 1) return Response.json(contract?.response.body);
			if (polls === 2)
				return Response.json({ error: "slow_down", interval: 10 });
			return Response.json({ access_token: userToken, token_type: "bearer" });
		}
		if (target.pathname.endsWith("/installations")) {
			installs++;
			return Response.json({
				accountId: "account-test",
				installationIds: installs < 3 ? [] : [42],
			});
		}
		if (target.pathname.endsWith("/policy"))
			return Response.json({
				revision: 1,
				account: { id: "account-test" },
				connections: [],
			});
		if (target.pathname.endsWith("/isolated-connect")) {
			connected = true;
			return Response.json({
				accountId: "account-test",
				repository: "example/project",
				installationId: 42,
				isolatedOnly: true,
				acceptAllMatchingRepositoryJobs: true,
			});
		}
		throw new Error("unexpected request");
	};
	const f = await fixture({ fetch: send, answers: ["y", ""] });
	const result = await f.run();
	expect(result.exitCode).toBe(0);
	expect(connected).toBe(true);
	expect(f.opened).toEqual([
		"https://relay.example/v1/app-bootstrap/setup",
		"https://github.com/settings/apps",
		"https://github.com/settings/apps",
		"https://github.com/login/device",
		"https://relay.example/v1/app-registration/setup",
	]);
	expect(f.waits).toContain(10_000);
	const saved = await readFile(
		join(
			f.home,
			"ci/links",
			(await readdir(join(f.home, "ci/links")))[0] ?? "",
		),
		"utf8",
	);
	const output = `${result.stdout}${result.stderr}${f.progress.join("\n")}${saved}`;
	expect(output).toContain("ABCD-EFGH");
	for (const secret of [
		accountToken,
		userToken,
		device.device_code,
		"secret-state",
	])
		expect(output).not.toContain(secret);
});

it("stops when device authorization is denied, without opening installation or changing policy", async () => {
	const requests: string[] = [];
	const f = await fixture({
		fetch: async (url) => {
			const target = String(url);
			requests.push(target);
			if (target.endsWith("/oauth/start")) return authorize();
			if (target.endsWith("/device/code")) return Response.json(device);
			if (target.endsWith("/oauth/access_token"))
				return Response.json({ error: "access_denied" });
			throw new Error("unexpected request");
		},
	});
	const result = await f.run();
	expect(result.exitCode).toBe(1);
	expect(result.stdout + result.stderr).toContain("device authorization");
	expect(requests.some((url) => url.includes("isolated-connect"))).toBe(false);
	expect(f.opened).toEqual(["https://github.com/login/device"]);
});

it("rejects an untrusted authorization URL before sending anything to GitHub", async () => {
	const requests: string[] = [];
	const f = await fixture({
		fetch: async (url) => {
			requests.push(String(url));
			return Response.json({
				authorizeUrl:
					"https://github.com.evil.example/login/oauth/authorize?client_id=stolen",
			});
		},
	});
	const result = await f.run();
	expect(result.exitCode).toBe(1);
	expect(requests).toHaveLength(1);
	expect(f.opened).toEqual([]);
});

it("requires an interactive, visible session before contacting the relay", async () => {
	let calls = 0;
	const f = await fixture({
		interactive: false,
		fetch: async () => {
			calls++;
			return authorize();
		},
	});
	const result = await f.run();
	expect(result.exitCode).toBe(2);
	expect(calls).toBe(0);
});

it("does not start registration when account authorization is rejected", async () => {
	const f = await fixture({
		fetch: async () => Response.json({ error: "no" }, { status: 403 }),
	});
	const result = await f.run();
	expect(result.exitCode).toBe(1);
	expect(f.opened).toEqual([]);
});
