import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { readOwnerTurn } from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createComposedHoboCli } from "../src/cli.js";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { handleMcpMessage, localOperatorAuth } from "../src/mcp-stdio.js";

const textResult = z.object({
	result: z.object({
		content: z.array(z.object({ text: z.string() })).min(1),
		isError: z.boolean(),
	}),
});

function fixture(limited = false) {
	const cli = createComposedHoboCli();
	const run = vi.fn(cli.run).mockResolvedValue({
		exitCode: 0,
		stdout: JSON.stringify({ ok: true, status: "deployed", code: "HOBO_OK" }),
		stderr: "",
	});
	const serverOptions = { cli: { ...cli, run } };
	const server = createHoboMcpServer(
		limited
			? {
					...serverOptions,
					rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 },
				}
			: serverOptions,
	);
	const owner = composeHoboMcp({
		output: new PassThrough(),
		projectDir: tmpdir(),
		remote: true,
	});
	const call = async (name: string, args: string[], tools?: string) => {
		const response = textResult.parse(
			await handleMcpMessage(
				server,
				localOperatorAuth(tools === undefined ? {} : { HOBO_MCP_TOOLS: tools }),
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: { args } },
				}),
				owner.session,
			),
		);
		return {
			response,
			body: z
				.record(z.string(), z.json())
				.parse(JSON.parse(response.result.content[0]?.text ?? "null")),
		};
	};
	return { run, call, owner };
}

describe("MCP owner setup privacy", () => {
	it("rejects interactive and legacy setup before provider dispatch, including leading options", async () => {
		const f = fixture();
		try {
			for (const name of ["ci", "cd"]) {
				for (const args of [
					["up"],
					["--verbose", "up"],
					["--cwd", "/tmp", "up"],
				]) {
					const result = await f.call(name, args);
					expect(result.body.code).toBe("HOBO_MCP_HANDOFF_REQUIRED");
				}
			}
			for (const args of [
				["app", "deposit"],
				["--yes", "app", "deposit"],
				["secret-store", "connect", "--yes"],
				["--yes", "secret-store", "connect"],
			]) {
				expect((await f.call("ci", args)).body.code).toBe(
					"HOBO_MCP_LEGACY_SETUP_BLOCKED",
				);
			}
			expect(
				(await f.call("ci", ["up", "--project", "--hand-off"])).body.code,
			).toBe("HOBO_MCP_INPUT_INVALID");
			expect(
				(await f.call("cd", ["up", "--hand-off", "--help"])).body.code,
			).toBe("HOBO_MCP_SETUP_HELP");
			expect(f.run).not.toHaveBeenCalled();
		} finally {
			await f.owner.close();
		}
	});

	it("allows a command argument named up and an already-connected headless deployment", async () => {
		const f = fixture();
		try {
			expect((await f.call("ci", ["deploy", "--ref", "up"])).body.code).toBe(
				"HOBO_OK",
			);
			const completed = await f.call("cd", ["up", "--hand-off"]);
			expect(completed.body).toMatchObject({
				ok: true,
				status: "deployed",
				code: "HOBO_OK",
				action: "none",
			});
			expect(f.run).toHaveBeenCalledTimes(2);
		} finally {
			await f.owner.close();
		}
	});

	it("keeps owner information out of setup results and reports missing forms", async () => {
		const f = fixture();
		const privateValue = "private-owner-project-and-sign-in";
		try {
			f.run.mockResolvedValue({
				exitCode: 1,
				stderr: "",
				stdout: JSON.stringify({
					ok: false,
					status: "needs-connection",
					code: "HOBO_CD_INFISICAL_SIGN_IN",
					message: `https://example.test/${privateValue}`,
					remediation: [privateValue],
					data: { project: privateValue },
				}),
			});
			f.owner.session.support = {
				apps: true,
				formElicitation: true,
				urlElicitation: false,
			};
			f.owner.session.request = vi.fn(async () => undefined);
			const available = await f.call("cd", ["up", "--hand-off"]);
			expect(available.body).toMatchObject({
				ok: false,
				code: "HOBO_CD_INFISICAL_SIGN_IN",
				action: "retry-setup-when-ready",
			});
			expect(JSON.stringify(available.response)).not.toContain(privateValue);
			expect(JSON.stringify(available.response)).not.toContain("https:");
			f.owner.session.support = {
				apps: true,
				formElicitation: false,
				urlElicitation: false,
			};
			for (const code of [
				"HOBO_CD_INFISICAL_SIGN_IN",
				"HOBO_CD_BITWARDEN_NEEDS_API_KEY",
				"HOBO_CD_STORE_CHOICE",
			]) {
				f.run.mockResolvedValueOnce({
					exitCode: 1,
					stderr: "",
					stdout: JSON.stringify({
						ok: false,
						status: "needs-connection",
						code,
						data: { privateValue },
					}),
				});
				const missing = await f.call("cd", ["up", "--hand-off"]);
				expect(missing.body).toMatchObject({
					code: "HOBO_MCP_OWNER_FORM_UNAVAILABLE",
					action: "secure-owner-form-required",
				});
				expect(JSON.stringify(missing.response)).not.toContain(privateValue);
			}
			expect(f.owner.session.request).not.toHaveBeenCalled();
		} finally {
			await f.owner.close();
		}
	});

	it("does not turn authorization failures, unknown output, or raw help into setup success", async () => {
		const f = fixture();
		try {
			const denied = await f.call("cd", ["up", "--hand-off"], "plan");
			expect(denied.body).toMatchObject({
				ok: false,
				status: "denied",
				code: "MCP_SCOPE_DENIED",
				action: "authorization-required",
			});
			expect(f.run).not.toHaveBeenCalled();
			f.run.mockResolvedValueOnce({
				exitCode: 0,
				stdout: "usage with private-owner-marker",
				stderr: "",
			});
			const help = await f.call("cd", ["up", "--hand-off"]);
			expect(help.body).toMatchObject({
				ok: false,
				code: "HOBO_MCP_SETUP_NOT_COMPLETED",
			});
			expect(JSON.stringify(help.response)).not.toContain(
				"private-owner-marker",
			);
			f.run.mockResolvedValueOnce({
				exitCode: 1,
				stdout: JSON.stringify({
					ok: false,
					status: "private-owner-status",
					code: "private-owner-code",
				}),
				stderr: "",
			});
			const unknown = await f.call("cd", ["up", "--hand-off"]);
			expect(unknown.body).toMatchObject({
				status: "unknown",
				code: "HOBO_MCP_SETUP_RESULT",
			});
			expect(JSON.stringify(unknown.response)).not.toContain("private-owner");
		} finally {
			await f.owner.close();
		}
	});

	it("reports throttling without dispatching another setup", async () => {
		const f = fixture(true);
		try {
			await f.call("cd", ["up", "--hand-off"]);
			const limited = await f.call("cd", ["up", "--hand-off"]);
			expect(limited.body).toMatchObject({
				ok: false,
				status: "throttled",
				code: "MCP_RATE_LIMITED",
				action: "retry-after-throttle",
			});
			expect(f.run).toHaveBeenCalledTimes(1);
		} finally {
			await f.owner.close();
		}
	});

	it("preserves a denial and requires a private form to retry an expired approval", async () => {
		const f = fixture();
		try {
			f.owner.session.support = {
				apps: false,
				formElicitation: true,
				urlElicitation: false,
			};
			f.owner.session.request = vi.fn(async () => undefined);
			for (const code of [
				"HOBO_CD_VERCEL_DEVICE_DENIED",
				"HOBO_CD_VERCEL_DEVICE_EXPIRED",
			]) {
				f.run.mockResolvedValueOnce({
					exitCode: 1,
					stdout: JSON.stringify({
						ok: false,
						status: "needs-connection",
						code,
						message: "private-owner-value",
					}),
					stderr: "",
				});
				const result = await f.call("cd", ["up", "--hand-off"]);
				const denied = code === "HOBO_CD_VERCEL_DEVICE_DENIED";
				expect(result.body).toMatchObject({
					code,
					action: denied ? "wait-for-owner-request" : "retry-setup-when-ready",
					message: denied
						? "The owner declined Vercel approval. Retry only if they request it."
						: "Run again to request a new Vercel approval.",
				});
				expect(
					readOwnerTurn(false, [String(result.body.message)]),
				).toMatchObject({
					kind: "act",
					action: { kind: denied ? "wait-for-owner" : "run-again" },
				});
				expect(JSON.stringify(result.response)).not.toContain(
					"private-owner-value",
				);
			}
			f.owner.session.support = {
				apps: false,
				formElicitation: false,
				urlElicitation: false,
			};
			for (const code of [
				"HOBO_CD_VERCEL_DEVICE_DENIED",
				"HOBO_CD_VERCEL_DEVICE_EXPIRED",
			]) {
				f.run.mockResolvedValueOnce({
					exitCode: 1,
					stdout: JSON.stringify({
						ok: false,
						status: "needs-connection",
						code,
					}),
					stderr: "",
				});
				expect((await f.call("cd", ["up", "--hand-off"])).body).toMatchObject(
					code === "HOBO_CD_VERCEL_DEVICE_DENIED"
						? { code, action: "wait-for-owner-request" }
						: {
								code: "HOBO_MCP_OWNER_FORM_UNAVAILABLE",
								action: "secure-owner-form-required",
							},
				);
			}
		} finally {
			await f.owner.close();
		}
	});

	it("preserves an atomic journal claim refusal without private details or a retry", async () => {
		const f = fixture();
		try {
			f.run.mockResolvedValueOnce({
				exitCode: 1,
				stdout: JSON.stringify({
					ok: false,
					status: "needs-connection",
					code: "HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE",
					message: "private-owner-store",
				}),
				stderr: "",
			});
			const result = await f.call("cd", ["up", "--hand-off"]);
			expect(result.body).toMatchObject({
				code: "HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE",
				action: "atomic-claim-store-required",
			});
			expect(JSON.stringify(result.response)).not.toContain(
				"private-owner-store",
			);
		} finally {
			await f.owner.close();
		}
	});

	it("preserves a completed CI preview and points a missing connection to CD setup", async () => {
		const f = fixture();
		try {
			f.run.mockResolvedValueOnce({
				exitCode: 0,
				stdout: JSON.stringify({
					ok: true,
					status: "ok",
					code: "HOBO_CI_MANAGED_PREVIEW",
					data: { project: "private-project" },
				}),
				stderr: "",
			});
			const preview = await f.call("ci", ["up", "--hand-off"]);
			expect(preview.body).toMatchObject({
				ok: true,
				code: "HOBO_CI_MANAGED_PREVIEW",
				action: "none",
			});
			expect(JSON.stringify(preview.response)).not.toContain("private-project");
			f.run.mockResolvedValueOnce({
				exitCode: 1,
				stdout: JSON.stringify({
					ok: false,
					status: "needs-connection",
					code: "HOBO_CI_UP_VERCEL_NOT_CONNECTED",
					message: "private-project",
				}),
				stderr: "",
			});
			const missing = await f.call("ci", ["up", "--hand-off"]);
			expect(missing.body).toMatchObject({
				ok: false,
				code: "HOBO_CI_UP_VERCEL_NOT_CONNECTED",
				action: "run-cd-setup",
			});
			expect(JSON.stringify(missing.response)).not.toContain("private-project");
			f.run.mockResolvedValueOnce({
				exitCode: 1,
				stdout: JSON.stringify({
					ok: false,
					status: "needs-connection",
					code: "HOBO_CD_HANDOFF_SILENT",
				}),
				stderr: "",
			});
			const unsupported = await f.call("cd", ["up", "--hand-off"]);
			expect(unsupported.body).toMatchObject({
				ok: false,
				code: "HOBO_MCP_OWNER_APPROVAL_UNAVAILABLE",
				action: "secure-owner-approval-required",
			});
			f.run.mockResolvedValueOnce({
				exitCode: 1,
				stdout: JSON.stringify({
					ok: false,
					status: "needs-connection",
					code: "HOBO_CD_ONEPASSWORD_PRIVATE_PROCESS_UNAVAILABLE",
					data: { vault: "private-vault" },
				}),
				stderr: "",
			});
			const privateProcess = await f.call("cd", ["up", "--hand-off"]);
			expect(privateProcess.body).toMatchObject({
				ok: false,
				code: "HOBO_CD_ONEPASSWORD_PRIVATE_PROCESS_UNAVAILABLE",
				action: "private-owner-session-required",
			});
			expect(JSON.stringify(privateProcess.response)).not.toContain(
				"private-vault",
			);
		} finally {
			await f.owner.close();
		}
	});
});
