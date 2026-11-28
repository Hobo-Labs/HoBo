import { AuthExpiredError, type Item, ItemCategory } from "@1password/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	onePasswordVaultScope,
	parseOnePasswordServiceAccountToken,
	provisionOnePasswordAccess,
	validateOnePasswordServiceAccount,
} from "../../src/onepassword-access.js";
import type { OwnerChannel } from "../../src/owner-channel.js";
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
const PROXY = "http://127.0.0.1:1";
const CA_BUNDLE = "/fixture/egress-ca.pem";
const EGRESS_VARIABLES = [
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"REQUESTS_CA_BUNDLE",
] as const;

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

function validationSdk() {
	const calls: string[] = [];
	const item: Item = {
		id: "b".repeat(26),
		title: "HoBo access attestation",
		category: ItemCategory.SecureNote,
		vaultId: VAULT,
		fields: [],
		sections: [],
		notes: "",
		tags: [],
		websites: [],
		version: 1,
		files: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const client = {
		vaults: { list: async () => [{ id: VAULT }] },
		items: {
			list: async () => {
				calls.push("read");
				return [];
			},
			create: async () => {
				calls.push("create");
				return item;
			},
			put: async () => {
				calls.push("update");
				return item;
			},
			delete: async () => {
				calls.push("delete");
			},
		},
	};
	const createClient = vi.fn(async () => client);
	return {
		calls,
		client,
		createClient,
		sdk: {
			AuthExpiredError,
			ItemCategory,
			createClient,
		},
	};
}

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
	beforeEach(() => {
		for (const variable of EGRESS_VARIABLES) vi.stubEnv(variable, "");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("creates a short-lived service account for the one vault, read and write", async () => {
		const machine = fakeMachine({ opOnPath: true, signedIn: true });
		const result = await provisionOnePasswordAccess(base(machine));
		expect(machine.ran).toContainEqual(
			`op service-account create hobo-cd --vault ${VAULT}:read_items,write_items --expires-in 24h --raw`,
		);
		expect(result).toMatchObject({ kind: "ready", token: TOKEN });
	});

	it("refuses a created service account the vault-scope validation rejects", async () => {
		const machine = fakeMachine({ opOnPath: true, signedIn: true });
		const result = await provisionOnePasswordAccess({
			...base(machine),
			validateServiceAccount: async () => false,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT",
		});
	});

	it("keeps the credential off every command line and progress line", async () => {
		lines.length = 0;
		const machine = fakeMachine({ opOnPath: true, signedIn: false });
		const result = await provisionOnePasswordAccess(base(machine));
		expect(result.kind).toBe("ready");
		expect(machine.ran.join("\n")).not.toContain(TOKEN);
		expect(lines.join("\n")).not.toContain(TOKEN);
	});

	it("refuses an owner-captured token the vault-scope validation rejects", async () => {
		const owner: OwnerChannel = {
			privateCaptureAllowed: true,
			openUrl: async () => undefined,
			captureSecret: async () => TOKEN,
			holds: () => true,
		};
		const machine = fakeMachine({});
		const result = await provisionOnePasswordAccess({
			...base(machine, false),
			owner,
			validateServiceAccount: async () => false,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT",
		});
		expect(machine.ran).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it.each([
		["HTTPS_PROXY", PROXY],
		["https_proxy", PROXY],
		["ALL_PROXY", PROXY],
		["all_proxy", PROXY],
		["NODE_EXTRA_CA_CERTS", CA_BUNDLE],
		["SSL_CERT_FILE", CA_BUNDLE],
		["REQUESTS_CA_BUNDLE", CA_BUNDLE],
	])("does not authenticate with required egress through %s", async (name, value) => {
		vi.stubEnv(name, value);
		const token = parseOnePasswordServiceAccountToken(TOKEN);
		if (token === undefined) throw new Error("Invalid fixture token.");
		const fixture = validationSdk();
		await expect(
			validateOnePasswordServiceAccount(token, VAULT, fixture.sdk),
		).resolves.toBe("unverifiable");
		expect(fixture.createClient).not.toHaveBeenCalled();
		expect(fixture.calls).toEqual([]);
	});

	it.each([
		["HTTPS_PROXY", PROXY],
		["SSL_CERT_FILE", CA_BUNDLE],
	])("imports the SDK to attest only without required egress through %s", async (name, value) => {
		const token = parseOnePasswordServiceAccountToken(TOKEN);
		if (token === undefined) throw new Error("Invalid fixture token.");
		const fixture = validationSdk();
		const loadSdk = vi.fn(async () => fixture.sdk);
		vi.stubEnv(name, value);
		await expect(
			validateOnePasswordServiceAccount(token, VAULT, undefined, loadSdk),
		).resolves.toBe("unverifiable");
		expect(loadSdk).not.toHaveBeenCalled();
		expect(fixture.createClient).not.toHaveBeenCalled();

		vi.stubEnv(name, "");
		await expect(
			validateOnePasswordServiceAccount(token, VAULT, undefined, loadSdk),
		).resolves.toBe(true);
		expect(loadSdk).toHaveBeenCalledOnce();
		expect(fixture.createClient).toHaveBeenCalledOnce();
		expect(fixture.calls).toEqual(["read", "create", "update", "delete"]);
	});

	it("refuses validation and removes the probe note when the attestation write fails", async () => {
		const token = parseOnePasswordServiceAccountToken(TOKEN);
		if (token === undefined) throw new Error("Invalid fixture token.");
		const fixture = validationSdk();
		fixture.client.items.put = async () => {
			fixture.calls.push("update");
			throw new Error("write refused");
		};
		await expect(
			validateOnePasswordServiceAccount(token, VAULT, fixture.sdk),
		).resolves.toBe("unverifiable");
		expect(fixture.calls).toEqual(["read", "create", "update", "delete"]);
	});

	it("refuses validation when attestation cleanup fails", async () => {
		const token = parseOnePasswordServiceAccountToken(TOKEN);
		if (token === undefined) throw new Error("Invalid fixture token.");
		const fixture = validationSdk();
		fixture.client.items.delete = async () => {
			fixture.calls.push("delete");
			throw new Error("cleanup refused");
		};
		await expect(
			validateOnePasswordServiceAccount(token, VAULT, fixture.sdk),
		).resolves.toBe("unverifiable");
		expect(fixture.calls).toEqual(["read", "create", "update", "delete"]);
	});

	it("refuses a service account that cannot write to the configured vault", async () => {
		const token = parseOnePasswordServiceAccountToken(TOKEN);
		if (token === undefined) throw new Error("Invalid fixture token.");
		const fixture = validationSdk();
		fixture.client.items.create = async () => {
			fixture.calls.push("create");
			throw new Error("read-only fixture");
		};
		await expect(
			validateOnePasswordServiceAccount(token, VAULT, fixture.sdk),
		).resolves.toBe("unverifiable");
		expect(fixture.calls).toEqual(["read", "create"]);
	});

	it("accepts exactly the configured vault and nothing wider", () => {
		expect(onePasswordVaultScope([{ id: VAULT }], VAULT)).toBe(true);
		expect(onePasswordVaultScope([{ id: "z".repeat(26) }], VAULT)).toBe(false);
		expect(
			onePasswordVaultScope([{ id: VAULT }, { id: "z".repeat(26) }], VAULT),
		).toBe(false);
		expect(onePasswordVaultScope([], VAULT)).toBe(false);
	});

	it("parses only a well-formed service account token", () => {
		expect(parseOnePasswordServiceAccountToken(TOKEN)).toBeDefined();
		for (const bad of [
			"",
			"not-a-service-account",
			`ops_${Buffer.from("not json").toString("base64url")}`,
			`ops_${Buffer.from(
				JSON.stringify({ email: "service-account@example.invalid" }),
			).toString("base64url")}`,
			`ops_${Buffer.from(
				JSON.stringify({
					email: "service-account@example.invalid",
					muk: "not-an-object",
					secretKey: "A3-FIXTURE-SECRET-KEY",
					srpX: "fixture-srp",
					signInAddress: "example.1password.com",
					userAuth: {},
				}),
			).toString("base64url")}`,
			`ops_${Buffer.from("fixture").toString("base64")}`,
			`ops_${"A".repeat(65_537)}`,
		])
			expect(parseOnePasswordServiceAccountToken(bad)).toBeUndefined();
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
