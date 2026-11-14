/**
 * `hobo fleet` parsing and output against the recording fake client: what
 * each command prints, how it refuses bad arguments, and that failures from
 * the authority come back as `HOBO_FLEET_<CODE>` results.
 */
import { describe, expect, it } from "vitest";
import { exitCodeOf, runFleetCli } from "../src/fleet-cli.js";
import {
	exchange,
	runFleetCommand,
	tokenOnCommandLine,
} from "../src/fleet-command.js";
import { fakeDeps, scriptedStream, TOKEN_TEXT } from "./support/fleet-fakes.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("hobo fleet parsing", () => {
	it("prints the command list for no command and refuses an unknown one", async () => {
		const { deps } = fakeDeps();
		expect((await runFleetCommand([], deps)).message).toContain("hobo fleet");
		const unknown = await runFleetCommand(["frobnicate"], deps);
		expect(unknown.status).toBe("usage");
		expect(unknown.message).toContain("Unknown fleet command frobnicate");
	});

	it.each([
		[["login", "--bogus"]],
		[["enroll"]],
		[["enroll", "--token-file", "a", "--oidc", "b"]],
		[["enroll", "--token-file", "a", "--class", "huge"]],
		[["enroll", "--token-file", "a", "--role", "king"]],
		[["service", "restart"]],
		[["service"]],
		[["token", "create"]],
		[["token", "create", "--fleet", "f", "--ttl", "soon"]],
		[["token", "melt"]],
		[["member", "show"]],
		[["member", "declare", "--fleet", "f", "--kind", "device", "--name", "n"]],
		[["member", "assign", "m", "--fleet", "f"]],
		[["member", "list", "--fleet", "NOT A FLEET"]],
		[["member", "dance"]],
		[["fleet", "verdict", "builds"]],
		[["fleet", "launch"]],
		[["connect", "m_box"]],
		[["connect", "m_box", "--order", "o", "--forward", "99999:1"]],
		[["cp", "m_box:not-a-digest", "out", "--order", "o"]],
		[["cp", "only-one"]],
		[
			[
				"submit",
				"--fleet",
				"f",
				"--image",
				"i",
				"--digest",
				"sha256:zz",
				"--",
				"x",
			],
		],
		[["submit", "--fleet", "f", "--image", "i", "--digest", DIGEST]],
		[["work", "tail", "s1"]],
		[["audit", "rewrite"]],
		[["ops", "ceremony"]],
		[["ops", "provision", "--config", "c", "--replicas", "2"]],
		[["ops", "rotate-key", "everything", "--config", "c"]],
		[["ops", "explode", "--config", "c"]],
		[["logout", "extra"]],
	])("refuses %j with its usage and calls nothing", async (argv) => {
		const { deps, calls } = fakeDeps();
		const result = await runFleetCommand(argv, deps);
		expect(result.ok).toBe(false);
		expect(result.status).toBe("usage");
		expect(result.message).toContain("Usage: hobo fleet");
		expect(calls.filter((call) => call.startsWith("client."))).toEqual([]);
	});

	it("finds a token anywhere on the command line, and nothing else", () => {
		expect(tokenOnCommandLine(["enroll", "--token-file", "t.txt"])).toBe(
			undefined,
		);
		expect(tokenOnCommandLine(["x", `--name=${TOKEN_TEXT}`])).toContain(
			"--token-file",
		);
		expect(tokenOnCommandLine(["x", `a:${TOKEN_TEXT}`])).toContain(
			"--token-file",
		);
	});
});

describe("hobo fleet output", () => {
	it("login stores the person credential and opens the browser", async () => {
		const { deps, log, auths } = fakeDeps();
		const result = await runFleetCommand(["login"], deps);
		expect(result.message).toBe("Signed in as user:ada (tenant acme).");
		expect(log.savedPerson).toBe(1);
		expect(log.opened).toEqual(["https://idp.test/authorize"]);
		expect(auths).toEqual(["sign-in"]);
	});

	it("login refuses a redirect for another sign-in", async () => {
		const { deps, log } = fakeDeps({
			io: {
				loopback: async () => ({
					redirectUri: "http://127.0.0.1:1/callback",
					result: Promise.resolve({ state: "other", code: "c" }),
					close: () => {},
				}),
			},
		});
		const result = await runFleetCommand(["login"], deps);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_FLEET_PROOF_INVALID");
		expect(log.savedPerson).toBe(0);
	});

	it("device-code login shows the code and gives up once the code expires", async () => {
		let now = Date.parse("2999-01-01T00:00:00.000Z");
		const { deps, log } = fakeDeps({
			pollPending: 100,
			io: {
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
		});
		const result = await runFleetCommand(["login", "--device"], deps);
		expect(log.progress[0]).toContain("WXYZ-1234");
		expect(result.code).toBe("HOBO_FLEET_TOKEN_EXPIRED");
	});

	it("enroll --fleet signs in with the device identity key", async () => {
		const { deps, auths } = fakeDeps();
		const result = await runFleetCommand(["enroll", "--fleet", "builds"], deps);
		expect(result.message).toContain("Enrolled m_device as active");
		expect(auths).toEqual(["sign-in"]);
	});

	it("status prints each fleet's table and capacity", async () => {
		const { deps } = fakeDeps();
		const result = await runFleetCommand(["status", "--fleet", "builds"], deps);
		const lines = (result.message ?? "").split("\n");
		expect(lines[0]).toBe(
			"Fleet builds: 1 member(s) as of 2026-11-13T00:00:00.000Z",
		);
		expect(lines[2]).toMatch(
			/^box\s+active\s+live\s+-\s+2\/4\s+2\.0 GB\s+512 MB\s+0\.99 \(99 ok, 1 dropped\)\s+S1,S2$/,
		);
		expect(lines[3]).toContain(
			"Capacity: 2/4 slots free on 1 healthy of 1 live",
		);
	});

	it("status of a named fleet the authority refuses is an error", async () => {
		const { deps } = fakeDeps({
			failures: { fleetView: { code: "forbidden", message: "no" } },
		});
		const result = await runFleetCommand(["status", "--fleet", "x"], deps);
		expect(result.code).toBe("HOBO_FLEET_FORBIDDEN");
		const all = await runFleetCommand(["status"], deps);
		expect(all.ok).not.toBe(false);
		expect(all.message).toContain("the authority returned no view");
	});

	it("doctor reports each check and fails when one fails", async () => {
		const { deps } = fakeDeps({
			failures: { jwks: { code: "unavailable", message: "down" } },
		});
		const result = await runFleetCommand(["doctor"], deps);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_FLEET_DOCTOR");
		expect(result.message).toContain("FAIL jwks: down");
		expect(result.message).toContain("ok   sandbox: S1");
	});

	it("doctor without a tenant skips discovery and the bus", async () => {
		const { deps, calls } = fakeDeps({ io: { tenant: () => undefined } });
		const result = await runFleetCommand(["doctor"], deps);
		expect(result.message).toContain("FAIL discovery: no tenant");
		expect(calls).not.toContain("client.discovery");
		expect(calls).not.toContain("local.busConnect");
	});

	it("token create shows the token once and keeps it out of data", async () => {
		const { deps } = fakeDeps();
		const result = await runFleetCommand(
			["token", "create", "--fleet", "builds"],
			deps,
		);
		expect(result.message).toContain(TOKEN_TEXT);
		expect(JSON.stringify(result.data)).not.toContain(TOKEN_TEXT);
	});

	it("member, fleet, work and verdict print what the authority answered", async () => {
		const { deps } = fakeDeps();
		expect((await runFleetCommand(["member", "list"], deps)).message).toContain(
			"m_device  active  Laptop  builds/laptop",
		);
		expect((await runFleetCommand(["fleet", "list"], deps)).message).toBe(
			"builds  revision 3\ncache  revision 3",
		);
		expect(
			(
				await runFleetCommand(
					["fleet", "verdict", "builds", "--label", "hobo"],
					deps,
				)
			).message,
		).toContain("builds (hobo): open; 1 member(s), 2 free slot(s)");
		expect((await runFleetCommand(["work", "show", "s1"], deps)).message).toBe(
			"s1: succeeded on m_box",
		);
		expect((await runFleetCommand(["work", "logs", "s1"], deps)).message).toBe(
			"hello\n",
		);
		expect(
			(await runFleetCommand(["fleet", "apply", "policy.json"], deps)).message,
		).toBe("Applied builds (revision 3).");
		expect(
			(
				await runFleetCommand(
					[
						"member",
						"declare",
						"--fleet",
						"c",
						"--kind",
						"target",
						"--name",
						"t",
					],
					deps,
				)
			).message,
		).toContain("Declared");
	});

	it("fleet apply refuses a file that is not a FleetRecord", async () => {
		const { deps } = fakeDeps({ io: { readText: async () => "{nope" } });
		const result = await runFleetCommand(["fleet", "apply", "p.json"], deps);
		expect(result.status).toBe("usage");
	});

	it("an authority failure is HOBO_FLEET_<CODE>", async () => {
		const { deps } = fakeDeps({
			failures: {
				listMembers: { code: "unauthenticated", message: "sign in" },
				issueToken: { code: "forbidden", message: "no" },
				submitWork: { code: "quota-exceeded", message: "full" },
			},
		});
		expect((await runFleetCommand(["member", "list"], deps)).code).toBe(
			"HOBO_FLEET_UNAUTHENTICATED",
		);
		expect(
			(await runFleetCommand(["token", "create", "--fleet", "f"], deps)).code,
		).toBe("HOBO_FLEET_FORBIDDEN");
		expect(
			(
				await runFleetCommand(
					[
						"submit",
						"--fleet",
						"f",
						"--image",
						"i",
						"--digest",
						DIGEST,
						"--",
						"x",
					],
					deps,
				)
			).code,
		).toBe("HOBO_FLEET_QUOTA_EXCEEDED");
	});

	it("connect runs standard input as one batch and prints the output", async () => {
		const { deps, log } = fakeDeps();
		const result = await runFleetCommand(
			["connect", "m_box", "--order", "o1"],
			deps,
		);
		expect(result.ok).not.toBe(false);
		expect(log.stdout).toEqual(["ok\n"]);
	});

	it("cp writes the fetched blob", async () => {
		const { deps, log } = fakeDeps();
		const result = await runFleetCommand(
			["cp", `m_box:${DIGEST}`, "out.bin", "--order", "o1"],
			deps,
		);
		expect(result.message).toContain("(4 bytes) to out.bin");
		expect(log.written["out.bin"]).toBe("blob");
	});

	it("audit verify and export report the chain", async () => {
		const { deps, log } = fakeDeps();
		expect((await runFleetCommand(["audit", "verify"], deps)).message).toBe(
			"The audit chain holds: 2 entries, witnessed through 2.",
		);
		const exported = await runFleetCommand(
			["audit", "export", "--out", "chain.json"],
			deps,
		);
		expect(exported.message).toBe("Exported 2 entries to chain.json.");
		expect(
			JSON.parse(log.written["chain.json"] ?? "{}").entries.entries,
		).toHaveLength(2);
	});

	it("ops ceremony prints both shares and stores nothing", async () => {
		const { deps, log } = fakeDeps();
		const result = await runFleetCommand(
			["ops", "ceremony", "--config", "fleet.json"],
			deps,
		);
		expect(result.message).toContain("Share 1: hobo-fleet-share:1:x");
		expect(result.message).toContain("Share 2: hobo-fleet-share:2:y");
		expect(JSON.stringify(result.data)).not.toContain("hobo-fleet-share");
		expect(log.written).toEqual({});
	});

	it("ops backup, restore, rotate-key and provision report their results", async () => {
		const { deps } = fakeDeps();
		const config = ["--config", "fleet.json"];
		expect(
			(await runFleetCommand(["ops", "backup", "a", ...config], deps)).message,
		).toBe("Backed up to a (manifest d).");
		expect(
			(await runFleetCommand(["ops", "restore", "a", ...config], deps)).message,
		).toBe("Restored a; the authority is now incarnation 2.");
		expect(
			(await runFleetCommand(["ops", "rotate-key", "witness", ...config], deps))
				.message,
		).toBe("Rotated witness.");
		expect(
			(await runFleetCommand(["ops", "provision", ...config], deps)).message,
		).toBe("provisioned");
	});
});

describe("the session exchange", () => {
	it("sends INPUT and END, then reads OUTPUT until EXIT", async () => {
		const written: Uint8Array[] = [];
		const stream = {
			...scriptedStream(),
			write: async (chunk: Uint8Array) => {
				written.push(chunk);
			},
		};
		const output: string[] = [];
		const done = await exchange(
			stream,
			new TextEncoder().encode("ls\n"),
			async (chunk) => {
				output.push(Buffer.from(chunk).toString("utf8"));
			},
		);
		expect(done).toEqual({ exitCode: 0 });
		expect(output).toEqual(["ok\n"]);
		expect(written.map((chunk) => chunk[0])).toEqual([2, 3]);
	});

	it("reports an ERROR message and a stream that ends without an exit", async () => {
		const error = Buffer.concat([
			Buffer.from([6, 0, 0, 0, 4]),
			Buffer.from("nope"),
		]);
		const failing = {
			peer: "p",
			async *read() {
				yield new Uint8Array(error);
			},
			async write() {},
			async close() {
				return { bytesSent: 0, bytesReceived: 0 };
			},
		};
		expect(await exchange(failing, new Uint8Array(), async () => {})).toEqual({
			exitCode: 1,
			error: "nope",
		});
		const empty = { ...failing, async *read() {} };
		expect(
			(await exchange(empty, new Uint8Array(), async () => {})).error,
		).toBe("the session ended without an exit code");
	});
});

describe("the fleet entry of the binary", () => {
	it("prints the message, or JSON, and exits 0, 1 or 2", async () => {
		const out: string[] = [];
		const err: string[] = [];
		const output = {
			stdout: (t: string) => out.push(t),
			stderr: (t: string) => err.push(t),
		};
		const { deps } = fakeDeps();
		expect(
			await runFleetCli(["fleet", "list"], { output, deps: () => deps }),
		).toBe(0);
		expect(out.join("")).toContain("builds  revision 3");
		expect(
			await runFleetCli(["--json", "fleet", "list"], {
				output,
				deps: () => deps,
			}),
		).toBe(0);
		expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({
			ok: true,
			verb: "fleet",
		});
		expect(
			await runFleetCli(["enroll", "--token", "x"], {
				output,
				deps: () => deps,
			}),
		).toBe(2);
		expect(err.join("")).toContain("--token-file");
		expect(exitCodeOf({ ok: false, code: "HOBO_FLEET_FORBIDDEN" })).toBe(1);
	});
});
