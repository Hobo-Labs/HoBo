import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	ONE_PASSWORD_SIGN_IN_CAPTURES,
	provisionOnePasswordAccess,
	type RunCommand,
} from "../../src/index.js";
import { driveRemoteOwner, heldOwnerChannel } from "../support/remote-owner.js";

// SPEC: 1Password from a remote dev box. There is no 1Password app on the
// box to approve a sign-in, so the owner hands their email, Secret Key and
// password to the waiting run in the HoBo MCP App's form; the CLI signs in
// with them in a throwaway configuration, HoBo creates its own vault-scoped
// service account, and the configuration is deleted. `op` is a fake that
// checks what the real one reads: the Secret Key from OP_SECRET_KEY, the
// password from standard input, the session from OP_SESSION_<shorthand>.

const ACCOUNT = {
	ONEPASSWORD_EMAIL: "owner@example.com",
	ONEPASSWORD_SECRET_KEY: "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ1-23456",
	ONEPASSWORD_PASSWORD: "correct horse battery staple",
};

function fakeOp(
	options: { readonly acceptPassword?: (pw: string) => boolean } = {},
) {
	const argv: string[] = [];
	const configDirs: string[] = [];
	const run: RunCommand = async (_bin, args, runOptions) => {
		argv.push(args.join(" "));
		const env = new Map(runOptions?.env ?? []);
		if (args[0] === "whoami")
			return { code: 1, stdout: "", stderr: "not signed in" };
		if (args[0] === "account" && args[1] === "add") {
			configDirs.push(env.get("OP_CONFIG_DIR") ?? "");
			const password = (runOptions?.input ?? "").replace(/\n$/u, "");
			const ok =
				env.get("OP_SECRET_KEY") === ACCOUNT.ONEPASSWORD_SECRET_KEY &&
				args.includes(ACCOUNT.ONEPASSWORD_EMAIL) &&
				(
					options.acceptPassword ??
					((pw) => pw === ACCOUNT.ONEPASSWORD_PASSWORD)
				)(password);
			return ok
				? { code: 0, stdout: "session-token\n", stderr: "" }
				: { code: 1, stdout: "", stderr: "Couldn't sign in." };
		}
		if (args[0] === "service-account")
			return env.get("OP_SESSION_hobo") === "session-token"
				? { code: 0, stdout: "ops_service_account_token\n", stderr: "" }
				: { code: 1, stdout: "", stderr: "not signed in" };
		return { code: 1, stdout: "", stderr: "unexpected" };
	};
	return { run, argv, configDirs };
}

function provisioner(
	op: ReturnType<typeof fakeOp>,
	owner?: ReturnType<typeof heldOwnerChannel>,
) {
	return () =>
		provisionOnePasswordAccess({
			family: "cd",
			vaultId: "vault-1",
			run: op.run,
			which: async (bin) => bin,
			toolsDir: "/unused",
			emit: () => undefined,
			interactive: false,
			exists: () => false,
			tempDir: () => mkdtemp(path.join(tmpdir(), "hobo-op-spec-")),
			...(owner !== undefined ? { owner } : undefined),
		});
}

const turn = (access: Awaited<ReturnType<ReturnType<typeof provisioner>>>) => ({
	ready: access.kind === "ready",
	lines:
		access.kind === "ready"
			? []
			: [access.code, access.message, ...access.remediation],
});

const handsOver =
	(
		owner: ReturnType<typeof heldOwnerChannel>,
		values: Readonly<Record<string, string>> = ACCOUNT,
	) =>
	async (name: string) => {
		owner.deposit(name, values[name] ?? "");
	};

describe("SPEC remote 1Password: signed in through the HoBo form", () => {
	it("happy path: three values in the form, then HoBo's own service account", async () => {
		const op = fakeOp();
		const owner = heldOwnerChannel();
		const provision = provisioner(op, owner);
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			hands: { capture: handsOver(owner) },
		});
		expect(result).toMatchObject({ kind: "ready", trail: ["capture"] });
		// No secret on any command line, where other processes could read it.
		const argv = op.argv.join("\n");
		expect(argv).not.toContain(ACCOUNT.ONEPASSWORD_SECRET_KEY);
		expect(argv).not.toContain(ACCOUNT.ONEPASSWORD_PASSWORD);
		expect(argv).not.toContain("session-token");
		// The throwaway configuration is gone.
		expect(op.configDirs).toHaveLength(1);
		expect(existsSync(op.configDirs[0] ?? "")).toBe(false);
	});

	it("asks for every value it needs, and spends none until all are there", async () => {
		const op = fakeOp();
		const owner = heldOwnerChannel();
		owner.deposit("ONEPASSWORD_EMAIL", ACCOUNT.ONEPASSWORD_EMAIL);
		const first = turn(await provisioner(op, owner)());
		for (const name of ONE_PASSWORD_SIGN_IN_CAPTURES)
			expect(first.lines.join("\n")).toContain(`name=${name}`);
		// The email given early is still waiting for the others.
		expect(owner.holds("ONEPASSWORD_EMAIL")).toBe(true);
	});

	it("a wrong password: asked again, then ready, with nothing left behind", async () => {
		const op = fakeOp();
		const owner = heldOwnerChannel();
		const provision = provisioner(op, owner);
		let attempts = 0;
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			hands: {
				capture: async (name) => {
					if (name === "ONEPASSWORD_EMAIL") attempts += 1;
					await handsOver(
						owner,
						attempts === 1
							? { ...ACCOUNT, ONEPASSWORD_PASSWORD: "typo" }
							: ACCOUNT,
					)(name);
				},
			},
		});
		expect(result).toMatchObject({
			kind: "ready",
			trail: ["capture", "capture"],
		});
		for (const dir of op.configDirs) expect(existsSync(dir)).toBe(false);
	});

	it("with no owner channel, it names the route that reaches the owner", async () => {
		const result = await driveRemoteOwner({
			run: async () => turn(await provisioner(fakeOp())()),
			hands: {},
		});
		expect(result).toMatchObject({
			kind: "dead-end",
			reason: expect.stringMatching(/use-mcp/u),
		});
	});
});
