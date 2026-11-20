import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { provisionOnePasswordAccess } from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";
import { describe, expect, it, vi } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { handleMcpMessage, localOperatorAuth } from "../src/mcp-stdio.js";

const TOKEN = "synthetic-service-account-credential";
const VAULT = "synthetic-private-vault";

describe("MCP 1Password owner hand-off", () => {
	it.each([
		true,
		false,
	])("keeps the credential private with owner form availability %s", async (formAvailable) => {
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
		mcp.session.support = {
			apps: false,
			formElicitation: formAvailable,
			urlElicitation: false,
		};
		mcp.session.request = vi.fn(async (_method, params) => {
			prompts.push(JSON.stringify(params));
			return { action: "accept", content: { value: TOKEN } };
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
			});
			if (access.kind === "ready") {
				selectedVault.put("OP_SERVICE_ACCOUNT_TOKEN", access.token);
			}
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
			const visible =
				JSON.stringify(response) + notifications + prompts.join("");
			expect(visible).not.toContain(TOKEN);
			expect(visible).not.toContain(VAULT);
			expect(spawned).not.toHaveBeenCalled();
			if (formAvailable) {
				expect(prompts).toHaveLength(1);
				expect(visible).toContain("existing 1Password token");
				expect(visible).toContain("HOBO_OK");
				expect(selectedVault.reveal("OP_SERVICE_ACCOUNT_TOKEN")).toBe(TOKEN);
			} else {
				expect(prompts).toEqual([]);
				expect(visible).toContain("HOBO_MCP_OWNER_FORM_UNAVAILABLE");
			}
			expect(otherVault.has("OP_SERVICE_ACCOUNT_TOKEN")).toBe(false);
		} finally {
			await mcp.close();
		}
		expect(selectedVault.names()).toEqual([]);
	});
});
