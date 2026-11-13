/**
 * O25: the command line is complete (design §6.15, §10.1). Every command of
 * the CLI table parses, calls exactly the `FleetClient` methods and local
 * functions its "Calls" cell names, in that order (asserted with a recording
 * fake client and recording local functions against the copy of the table
 * below), and has help text; a token on the command line is refused.
 */
import { describe, expect, it } from "vitest";
import { FLEET_COMMANDS, runFleetCommand } from "../src/fleet-command.js";
import { fakeDeps, TOKEN_TEXT } from "./support/fleet-fakes.js";

/** A copy of the "Command" and "Calls" columns of the CLI table of §6.15. */
const CALLS_TABLE = [
	[
		"login",
		"`signInStart`, then `signInComplete` (browser) or `signInPoll` until it answers (device code)",
	],
	["logout", "local: deletes the stored person token"],
	[
		"enroll --token-file / --oidc",
		"local key generation, then `enroll` (through `createFleetAgent.enroll`)",
	],
	[
		"enroll --fleet",
		"`signInStart`, `signInComplete` or `signInPoll`, then `enroll`",
	],
	[
		"run [--fleets]",
		"local: `createFleetAgent(...).start()`; the agent itself calls `credentials`",
	],
	["service install|uninstall|status", "local: `installService`"],
	[
		"status [--fleet]",
		"`listFleets` (when no `--fleet`), then `fleetView` per fleet",
	],
	[
		"doctor",
		"`authorityDiscovery`, `discovery`, `jwks`; local: key store load, `sandboxDrivers`, a bus connect, a transport self-dial",
	],
	["token create|list|revoke", "`issueToken`, `listTokens`, `revokeToken`"],
	["member list|show", "`listMembers`, `getMember`"],
	["member declare", "`declare`"],
	["member approve", "`approveKey`"],
	[
		"member accept|reject|suspend|resume|unlock|revoke",
		"the method of the same name",
	],
	["member assign", "`assign`"],
	["member rotate", "`rotateKeys`"],
	[
		"fleet list|show|apply|verdict",
		"`listFleets`, `getFleet`, `defineFleet`, `fleetVerdict`",
	],
	[
		"connect <member> [--order] [--forward L:R]",
		"`grantSession`, then local `FleetTransport.dial`",
	],
	[
		"cp <src> <dst>",
		"`grantSession`, then local `FleetTransport.dial` and blob fetch",
	],
	["submit --fleet --image --digest -- <args>", "`submitWork`"],
	["work show|logs", "`workStatus`, `workLogs`"],
	[
		"audit verify",
		"`auditCheckpoints`, `auditEntries`, then local `verifyAuditChain`",
	],
	["audit export", "`auditCheckpoints`, `auditEntries`"],
	["leave", "`leave`, then local key deletion"],
	[
		"ops provision|ceremony|rotate-key|backup|restore",
		"local: `provisionTopology`, `runCeremony`, `rotateKey`, `backup`, `restore`",
	],
] as const;

type Row = (typeof CALLS_TABLE)[number][0];
type Case = Readonly<{
	row: Row;
	argv: readonly string[];
	calls: readonly string[];
	pollPending?: number;
}>;

const DIGEST = `sha256:${"a".repeat(64)}`;

/** Each row's commands, run, with the calls its cell names, in order. */
const CASES: readonly Case[] = [
	{
		row: "login",
		argv: ["login"],
		calls: ["client.signInStart", "client.signInComplete"],
	},
	{
		row: "login",
		argv: ["login", "--device"],
		pollPending: 2,
		calls: [
			"client.signInStart",
			"client.signInPoll",
			"client.signInPoll",
			"client.signInPoll",
		],
	},
	{ row: "logout", argv: ["logout"], calls: ["local.deletePersonToken"] },
	{
		row: "enroll --token-file / --oidc",
		argv: ["enroll", "--token-file", "token.txt"],
		calls: ["local.generateKeys", "client.enroll"],
	},
	{
		row: "enroll --token-file / --oidc",
		argv: ["enroll", "--token-file", "-", "--class", "dedicated"],
		calls: ["local.generateKeys", "client.enroll"],
	},
	{
		row: "enroll --token-file / --oidc",
		argv: ["enroll", "--oidc", "assertion.jwt", "--fleet", "builds"],
		calls: ["local.generateKeys", "client.enroll"],
	},
	{
		row: "enroll --fleet",
		argv: ["enroll", "--fleet", "builds"],
		calls: [
			"local.generateKeys",
			"client.signInStart",
			"client.signInComplete",
			"client.enroll",
		],
	},
	{
		row: "enroll --fleet",
		argv: ["enroll", "--fleet", "builds", "--device"],
		pollPending: 1,
		calls: [
			"local.generateKeys",
			"client.signInStart",
			"client.signInPoll",
			"client.signInPoll",
			"client.enroll",
		],
	},
	{ row: "run [--fleets]", argv: ["run"], calls: ["local.startAgent"] },
	{
		row: "run [--fleets]",
		argv: ["run", "--fleets", "builds,cache"],
		calls: ["local.startAgent"],
	},
	...(["install", "uninstall", "status"] as const).map(
		(action): Case => ({
			row: "service install|uninstall|status",
			argv: ["service", action],
			calls: ["local.installService"],
		}),
	),
	{
		row: "status [--fleet]",
		argv: ["status"],
		calls: ["client.listFleets", "client.fleetView", "client.fleetView"],
	},
	{
		row: "status [--fleet]",
		argv: ["status", "--fleet", "builds"],
		calls: ["client.fleetView"],
	},
	{
		row: "doctor",
		argv: ["doctor"],
		calls: [
			"client.authorityDiscovery",
			"client.discovery",
			"client.jwks",
			"local.loadKeyStore",
			"local.sandboxDrivers",
			"local.busConnect",
			"local.transportSelfDial",
		],
	},
	{
		row: "token create|list|revoke",
		argv: ["token", "create", "--fleet", "builds", "--role", "executor"],
		calls: ["client.issueToken"],
	},
	{
		row: "token create|list|revoke",
		argv: ["token", "list"],
		calls: ["client.listTokens"],
	},
	{
		row: "token create|list|revoke",
		argv: ["token", "revoke", "f".repeat(64)],
		calls: ["client.revokeToken"],
	},
	{
		row: "member list|show",
		argv: ["member", "list", "--fleet", "builds"],
		calls: ["client.listMembers"],
	},
	{
		row: "member list|show",
		argv: ["member", "show", "m_device"],
		calls: ["client.getMember"],
	},
	{
		row: "member declare",
		argv: [
			"member",
			"declare",
			"--fleet",
			"cache",
			"--kind",
			"backend",
			"--name",
			"redis-eu",
		],
		calls: ["client.declare"],
	},
	{
		row: "member approve",
		argv: ["member", "approve", "m_device"],
		calls: ["client.approveKey"],
	},
	...(
		["accept", "reject", "suspend", "resume", "unlock", "revoke"] as const
	).map(
		(method): Case => ({
			row: "member accept|reject|suspend|resume|unlock|revoke",
			argv: ["member", method, "m_device", "--reason", "test"],
			calls: [`client.${method}`],
		}),
	),
	{
		row: "member assign",
		argv: [
			"member",
			"assign",
			"m_device",
			"--fleet",
			"cache",
			"--name",
			"laptop",
			"--role",
			"observer",
		],
		calls: ["client.assign"],
	},
	{
		row: "member rotate",
		argv: ["member", "rotate"],
		calls: ["client.rotateKeys"],
	},
	{
		row: "fleet list|show|apply|verdict",
		argv: ["fleet", "list"],
		calls: ["client.listFleets"],
	},
	{
		row: "fleet list|show|apply|verdict",
		argv: ["fleet", "show", "builds"],
		calls: ["client.getFleet"],
	},
	{
		row: "fleet list|show|apply|verdict",
		argv: ["fleet", "apply", "policy.json"],
		calls: ["client.defineFleet"],
	},
	{
		row: "fleet list|show|apply|verdict",
		argv: ["fleet", "verdict", "builds", "--label", "hobo"],
		calls: ["client.fleetVerdict"],
	},
	{
		row: "connect <member> [--order] [--forward L:R]",
		argv: ["connect", "m_box", "--order", "o1"],
		calls: ["client.grantSession", "local.dial"],
	},
	{
		row: "connect <member> [--order] [--forward L:R]",
		argv: ["connect", "m_box", "--order", "o1", "--forward", "8080:80"],
		calls: ["client.grantSession", "local.dial"],
	},
	{
		row: "cp <src> <dst>",
		argv: ["cp", `m_box:${DIGEST}`, "out.bin", "--order", "o1"],
		calls: ["client.grantSession", "local.dial", "local.fetchBlob"],
	},
	{
		row: "submit --fleet --image --digest -- <args>",
		argv: [
			"submit",
			"--fleet",
			"builds",
			"--image",
			"alpine",
			"--digest",
			DIGEST,
			"--",
			"echo",
			"--fleet",
		],
		calls: ["client.submitWork"],
	},
	{
		row: "work show|logs",
		argv: ["work", "show", "s1"],
		calls: ["client.workStatus"],
	},
	{
		row: "work show|logs",
		argv: ["work", "logs", "s1"],
		calls: ["client.workLogs"],
	},
	{
		row: "audit verify",
		argv: ["audit", "verify"],
		calls: [
			"client.auditCheckpoints",
			"client.auditEntries",
			"local.verifyAuditChain",
		],
	},
	{
		row: "audit export",
		argv: ["audit", "export"],
		calls: ["client.auditCheckpoints", "client.auditEntries"],
	},
	{
		row: "leave",
		argv: ["leave"],
		calls: ["client.leave", "local.deleteKeys"],
	},
	{
		row: "ops provision|ceremony|rotate-key|backup|restore",
		argv: ["ops", "provision", "--config", "fleet.json", "--replicas", "3"],
		calls: ["local.provisionTopology"],
	},
	{
		row: "ops provision|ceremony|rotate-key|backup|restore",
		argv: ["ops", "ceremony", "--config", "fleet.json"],
		calls: ["local.runCeremony"],
	},
	{
		row: "ops provision|ceremony|rotate-key|backup|restore",
		argv: ["ops", "rotate-key", "witness", "--config", "fleet.json"],
		calls: ["local.rotateKey"],
	},
	{
		row: "ops provision|ceremony|rotate-key|backup|restore",
		argv: ["ops", "backup", "out.tar", "--config", "fleet.json"],
		calls: ["local.backup"],
	},
	{
		row: "ops provision|ceremony|rotate-key|backup|restore",
		argv: ["ops", "restore", "out.tar", "--config", "fleet.json"],
		calls: ["local.restore"],
	},
];

describe("O25: every command of the CLI table", () => {
	it("has at least one case per row of the table, and no case outside it", () => {
		const rows = new Set<string>(CALLS_TABLE.map(([row]) => row));
		const covered = new Set<string>(CASES.map((entry) => entry.row));
		expect([...rows].filter((row) => !covered.has(row))).toEqual([]);
		expect([...covered].filter((row) => !rows.has(row))).toEqual([]);
	});

	it("names only commands the CLI has", () => {
		const commands = new Set<string>(
			FLEET_COMMANDS.map((entry) => entry.command),
		);
		for (const [row] of CALLS_TABLE)
			expect(commands.has(row.split(" ")[0] ?? "")).toBe(true);
		for (const command of commands)
			expect(
				CALLS_TABLE.some(([row]) => (row.split(" ")[0] ?? "") === command),
			).toBe(true);
	});

	for (const entry of CASES)
		it(`hobo fleet ${entry.argv.join(" ")} calls ${entry.calls.join(", ")}`, async () => {
			const { deps, calls } = fakeDeps(
				entry.pollPending === undefined
					? {}
					: { pollPending: entry.pollPending },
			);
			const result = await runFleetCommand(entry.argv, deps);
			expect(result.ok, result.message).not.toBe(false);
			expect(calls).toEqual(entry.calls);
		});

	for (const entry of FLEET_COMMANDS)
		it(`hobo fleet ${entry.command} --help prints its usage`, async () => {
			const { deps, calls } = fakeDeps();
			const result = await runFleetCommand([entry.command, "--help"], deps);
			expect(result.ok).not.toBe(false);
			expect(result.message).toContain(`hobo fleet ${entry.command}`);
			expect(entry.does.length).toBeGreaterThan(0);
			expect(calls).toEqual([]);
		});

	it("lists every command in the top-level help", async () => {
		const { deps } = fakeDeps();
		const result = await runFleetCommand(["--help"], deps);
		for (const entry of FLEET_COMMANDS)
			expect(result.message).toContain(entry.command);
	});
});

describe("O25: a token on the command line is refused", () => {
	for (const argv of [
		["enroll", "--token", TOKEN_TEXT],
		["enroll", `--token=${TOKEN_TEXT}`],
		["enroll", "--token-file", TOKEN_TEXT],
		["member", "show", TOKEN_TEXT],
	])
		it(`hobo fleet ${argv.map((arg) => arg.replace(TOKEN_TEXT, "hft_…")).join(" ")}`, async () => {
			const { deps, calls } = fakeDeps();
			const result = await runFleetCommand(argv, deps);
			expect(result.ok).toBe(false);
			expect(result.status).toBe("usage");
			expect(result.message).toContain("--token-file");
			expect(result.message).not.toContain(TOKEN_TEXT);
			expect(calls).toEqual([]);
		});
});
