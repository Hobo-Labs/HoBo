import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
	type OnePasswordAccessOptions,
	provisionOnePasswordAccess,
} from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";
import { describe, expect, it, vi } from "vitest";
import { ONE_PASSWORD_TEST_TOKEN } from "../../hobo-ci/test/support/onepassword-service-account.js";
import { createComposedHoboCli } from "../src/cli.js";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { handleMcpMessage, localOperatorAuth } from "../src/mcp-stdio.js";

const TOKEN = ONE_PASSWORD_TEST_TOKEN;
const VAULT = "synthetic-private-vault";

async function runHandOff(options: {
	readonly formAvailable: boolean;
	readonly token: string;
	readonly validateServiceAccount: OnePasswordAccessOptions["validateServiceAccount"];
}) {
	const output = new PassThrough();
	let notifications = "";
	output.on("data", (chunk: Buffer) => {
		notifications += chunk.toString();
	});
	const mcp = composeHoboMcp({ output, projectDir: tmpdir(), remote: true });
	const selectedVault = mcp.owner.vaultFor?.("cd", tmpdir());
	const otherVault = mcp.owner.vaultFor?.("ci", tmpdir());
	if (!selectedVault || !otherVault) throw new Error("No scoped vaults.");
	const prompts: string[] = [];
	const spawned = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
	const validate = vi.fn(options.validateServiceAccount);
	mcp.session.support = {
		apps: false,
		formElicitation: options.formAvailable,
		urlElicitation: false,
	};
	mcp.session.request = vi.fn(async (_method, params) => {
		prompts.push(JSON.stringify(params));
		return { action: "accept", content: { value: options.token } };
	});
	const cli = createComposedHoboCli();
	const run = vi.fn(cli.run).mockImplementation(async () => {
		const owner = mcp.owner.forScope?.("cd", tmpdir());
		if (!owner) throw new Error("No scoped owner channel.");
		const access = await provisionOnePasswordAccess({
			family: "cd",
			vaultId: VAULT,
			run: spawned,
			which: async () => undefined,
			toolsDir: "/unused",
			emit: () => undefined,
			interactive: false,
			owner,
			validateServiceAccount: validate,
		});
		if (access.kind === "ready")
			selectedVault.put("OP_SERVICE_ACCOUNT_TOKEN", access.token);
		return access.kind === "ready"
			? {
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify({
						ok: true,
						status: "deployed",
						code: "HOBO_OK",
						data: { token: access.token, vault: VAULT },
					}),
				}
			: {
					exitCode: 1,
					stderr: "",
					stdout: JSON.stringify({
						ok: false,
						status: "needs-connection",
						code: access.code,
						message: access.message,
						remediation: access.remediation,
					}),
				};
	});
	const server = createHoboMcpServer({ cli: { ...cli, run } });
	let visible = "";
	let stored: string | undefined;
	let otherStored = false;
	try {
		const response = await handleMcpMessage(
			server,
			localOperatorAuth({}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "cd", arguments: { args: ["up", "--hand-off"] } },
			}),
			mcp.session,
		);
		visible = JSON.stringify(response) + notifications + prompts.join("");
		stored = selectedVault.reveal("OP_SERVICE_ACCOUNT_TOKEN");
		otherStored = otherVault.has("OP_SERVICE_ACCOUNT_TOKEN");
	} finally {
		await mcp.close();
	}
	return {
		visible,
		prompts,
		spawned,
		validate,
		stored,
		otherStored,
		cleared: selectedVault.names(),
	};
}

describe("MCP 1Password owner hand-off", () => {
	it.each([
		true,
		false,
	])("keeps the credential private with owner form availability %s", async (formAvailable) => {
		const result = await runHandOff({
			formAvailable,
			token: TOKEN,
			validateServiceAccount: async () => true,
		});
		expect(result.visible).not.toContain(TOKEN);
		expect(result.visible).not.toContain(VAULT);
		expect(result.spawned).not.toHaveBeenCalled();
		if (formAvailable) {
			expect(result.prompts).toHaveLength(1);
			expect(result.visible).toContain("existing 1Password token");
			expect(result.visible).toContain("HOBO_OK");
			expect(result.stored).toBe(TOKEN);
			expect(result.validate).toHaveBeenCalledWith(TOKEN, VAULT);
		} else {
			expect(result.prompts).toEqual([]);
			expect(result.visible).toContain("HOBO_MCP_OWNER_FORM_UNAVAILABLE");
			expect(result.validate).not.toHaveBeenCalled();
		}
		expect(result.otherStored).toBe(false);
		expect(result.cleared).toEqual([]);
	});

	it("refuses a structurally invalid token without storing it", async () => {
		const result = await runHandOff({
			formAvailable: true,
			token: "synthetic-service-account-credential",
			validateServiceAccount: async () => true,
		});
		expect(result.visible).toContain("HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT");
		expect(result.visible).not.toContain(
			"synthetic-service-account-credential",
		);
		expect(result.stored).toBeUndefined();
		expect(result.validate).not.toHaveBeenCalled();
		expect(result.spawned).not.toHaveBeenCalled();
		expect(result.cleared).toEqual([]);
	});

	it.each([
		false,
		true,
	])("refuses validation failure or rejection without storing the token (%s)", async (rejects) => {
		const result = await runHandOff({
			formAvailable: true,
			token: TOKEN,
			validateServiceAccount: async () => {
				if (rejects) throw new Error("private validation failure");
				return false;
			},
		});
		expect(result.visible).toContain("HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT");
		expect(result.visible).not.toContain(TOKEN);
		expect(result.visible).not.toContain("private validation failure");
		expect(result.stored).toBeUndefined();
		expect(result.validate).toHaveBeenCalledWith(TOKEN, VAULT);
		expect(result.spawned).not.toHaveBeenCalled();
		expect(result.cleared).toEqual([]);
	});

	it("refuses an unverifiable validation result without storing the token", async () => {
		const result = await runHandOff({
			formAvailable: true,
			token: TOKEN,
			validateServiceAccount: async () => "unverifiable",
		});
		expect(result.visible).toContain(
			"HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT_UNREACHABLE",
		);
		expect(result.visible).not.toContain(TOKEN);
		expect(result.stored).toBeUndefined();
		expect(result.validate).toHaveBeenCalledWith(TOKEN, VAULT);
		expect(result.spawned).not.toHaveBeenCalled();
		expect(result.cleared).toEqual([]);
	});
});
