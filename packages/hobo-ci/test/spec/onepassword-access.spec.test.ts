import { describe, expect, it } from "vitest";

import { provisionOnePasswordAccess } from "../../src/onepassword-access.js";
import type { CommandResult, RunCommand } from "../../src/store-cli.js";
import { ONE_PASSWORD_TEST_TOKEN } from "../support/onepassword-service-account.js";

const TOKEN = ONE_PASSWORD_TEST_TOKEN;

// SPEC: connecting 1Password with as little manual provisioning as 1Password
// allows. HoBo installs the 1Password CLI (`op`) when it is missing, reuses
// an existing `op` session, or has the owner sign in once (their 1Password
// app approves it), then creates its own service account scoped to the one
// vault, through the CLI. The owner never creates a service account, Connect
// server or token by hand, sets an environment variable, or uses a terminal.
// (1Password has no OIDC sign-in for service accounts: its Credential Broker
// is for CI workloads; a short-lived, vault-scoped service account is the
// least standing credential available here.)

const TOOLS = "/home/owner/.local/share/hobo/tools";
const VAULT = "abcdefghijklmnopqrstuvwxyz";
const OP = `${TOOLS}/bin/op`;

function fakeMachine(options: { opOnPath?: boolean; signedIn?: boolean }) {
	const ran: string[] = [];
	let signedIn = options.signedIn ?? false;
	const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
	const run: RunCommand = async (command, args) => {
		ran.push([command, ...args].join(" "));
		if (command === "curl" || command === "unzip") return ok();
		if (command !== "op" && command !== OP)
			return { code: 127, stdout: "", stderr: "not found" };
		const line = args.join(" ");
		if (line === "whoami")
			return signedIn
				? ok("URL: my.1password.com")
				: { code: 1, stdout: "", stderr: "not signed in" };
		if (line === "signin") {
			signedIn = true; // the owner's 1Password app approved it
			return ok();
		}
		if (line.startsWith("service-account create")) return ok(`${TOKEN}\n`);
		return { code: 2, stdout: "", stderr: `unexpected ${line}` };
	};
	const which = async (bin: string) =>
		options.opOnPath && bin === "op" ? "/usr/bin/op" : undefined;
	return { ran, run, which };
}

const lines: string[] = [];
const base = (machine: ReturnType<typeof fakeMachine>, interactive = true) => ({
	family: "cd" as const,
	vaultId: VAULT,
	run: machine.run,
	which: machine.which,
	toolsDir: TOOLS,
	platform: { os: "linux" as const, arch: "amd64" as const },
	emit: (line: string) => lines.push(line),
	interactive,
	exists: () => false,
	validateServiceAccount: async () => true,
});

describe("SPEC R7: choosing 1Password installs its CLI when missing", () => {
	it("installs op from 1Password's official download into HoBo's tools directory", async () => {
		const machine = fakeMachine({ signedIn: true });
		await provisionOnePasswordAccess(base(machine));
		const download = machine.ran.find((c) => c.startsWith("curl"));
		expect(download).toMatch(
			/https:\/\/cache\.agilebits\.com\/dist\/1P\/op2\/pkg\/v[\d.]+\/op_linux_amd64_v[\d.]+\.zip/u,
		);
		expect(machine.ran.find((c) => c.startsWith("unzip"))).toContain(
			`${TOOLS}/bin`,
		);
		expect(machine.ran).toContain(`${OP} whoami`);
	});

	it("uses op already on the machine and downloads nothing", async () => {
		const machine = fakeMachine({ opOnPath: true, signedIn: true });
		await provisionOnePasswordAccess(base(machine));
		expect(machine.ran.some((c) => c.startsWith("curl"))).toBe(false);
	});
});

describe("SPEC R3 + R5: an existing session is used; otherwise one sign-in", () => {
	it("uses an existing op session without signing in or asking anything", async () => {
		lines.length = 0;
		const machine = fakeMachine({ opOnPath: true, signedIn: true });
		const result = await provisionOnePasswordAccess(base(machine));
		expect(result.kind).toBe("ready");
		expect(machine.ran).not.toContain("op signin");
		expect(lines).toEqual([]);
	});

	it("signs in once (the 1Password app approves) when there is no session", async () => {
		const machine = fakeMachine({ opOnPath: true, signedIn: false });
		const result = await provisionOnePasswordAccess(base(machine));
		expect(machine.ran.filter((c) => c === "op signin")).toHaveLength(1);
		expect(result.kind).toBe("ready");
	});

	it("a remote run with no op and no session says to sign in once, installing nothing", async () => {
		const machine = fakeMachine({});
		const result = await provisionOnePasswordAccess(base(machine, false));
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(machine.ran).toEqual([]);
	});
});

describe("SPEC R1: HoBo creates its own vault-scoped service account", () => {
	it("creates a short-lived service account for the one vault, read and write", async () => {
		const machine = fakeMachine({ opOnPath: true, signedIn: true });
		const result = await provisionOnePasswordAccess(base(machine));
		expect(machine.ran).toContainEqual(
			`op service-account create hobo-cd --vault ${VAULT}:read_items,write_items --expires-in 24h --raw`,
		);
		expect(result).toMatchObject({ kind: "ready", token: TOKEN });
	});

	it("never tells the owner to create anything, set env vars or use a terminal", async () => {
		lines.length = 0;
		await provisionOnePasswordAccess(base(fakeMachine({ opOnPath: true })));
		const refused = await provisionOnePasswordAccess(
			base(fakeMachine({}), false),
		);
		const text = [
			...lines,
			...(refused.kind === "refused"
				? [refused.message, ...refused.remediation]
				: []),
		];
		for (const line of text) {
			expect(line).not.toMatch(
				/\b(create|issue|generate)\b[^.]{0,80}\b(service account|token|connect server)\b/iu,
			);
			expect(line).not.toMatch(/environment variable|terminal/iu);
		}
	});
});
