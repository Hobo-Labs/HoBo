import { describe, expect, it, vi } from "vitest";

import { createMcpOwnerChannel } from "../src/mcp-owner-channel.js";
import type { OwnerPages } from "../src/mcp-owner-page.js";
import {
	CHOOSE_SECRET_STORE_TOOL,
	createStoreChoiceApp,
	NO_STORE_CHOICE_SUPPORT,
	SUBMIT_OWNER_PAGE_TOOL,
} from "../src/mcp-store-choice.js";
import { createOwnerStoreSessions } from "../src/owner-store-session.js";

describe("owner page sign-in scope", () => {
	it("does not pass credentials from a stale page to a later sign-in", async () => {
		let next = 0;
		const signIn = vi.fn(async () => ({
			kind: "refused" as const,
			code: "TEST_SIGN_IN",
			message: "Synthetic refusal",
			remediation: [],
		}));
		const sessions = createOwnerStoreSessions({ signIn });
		const pages: OwnerPages = {
			open: async () => ({
				page: `page-${++next}`,
				fingerprint: "test",
				html: "",
			}),
			unseal: async (page) => ({
				page,
				cwd: "/project-a",
				answers: { store: "infisical", INFISICAL_TOKEN: `token-${page}` },
			}),
			openRelay: async () => {
				throw new Error("unused");
			},
			unsealRelay: async () => {
				throw new Error("unused");
			},
		};
		const app = createStoreChoiceApp({
			cwd: "/project-a",
			locatorFor: () => ({
				assertCurrent: () => {},
				onOwnerChoice: () => {},
				selectionRevision: () => 0,
				read: async () => ({}),
				write: async () => {},
			}),
			sessions,
			pages,
		});
		try {
			await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{},
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{},
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			await app.callTool(
				SUBMIT_OWNER_PAGE_TOOL,
				{ sealed: "page-2" },
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			const stale = await app.callTool(
				SUBMIT_OWNER_PAGE_TOOL,
				{ sealed: "page-1" },
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			expect(stale.structuredContent).toMatchObject({ status: "stale" });
			expect(signIn).toHaveBeenCalledOnce();
			expect(JSON.stringify(stale)).not.toContain("token-page-1");
		} finally {
			await sessions.close();
		}
	});

	it("hands credentials only to the selected project's sign-in after its choice is saved", async () => {
		const other = createMcpOwnerChannel({ requireScope: true });
		const waiting = other.forScope?.("ci", "/project-b");
		if (!waiting) throw new Error("No scoped owner channel.");
		waiting.reserveCaptures?.(["INFISICAL_TOKEN"]);
		const legacyDeposit = vi.fn((name: string, value: string) =>
			other.deposit(name, value),
		);
		const steps: string[] = [];
		const signIn = vi.fn(async ({ cwd, vault, infisicalSession }) => {
			steps.push("sign-in");
			expect(cwd).toBe("/project-a");
			expect(vault.reveal("INFISICAL_TOKEN")).toBe("synthetic-token-a");
			expect(vault.reveal("OP_CONNECT_TOKEN")).toBeUndefined();
			expect(infisicalSession).toBe("synthetic-copied-session");
			return {
				kind: "refused" as const,
				code: "TEST_SIGN_IN",
				message: "Synthetic refusal",
				remediation: [],
			};
		});
		const sessions = createOwnerStoreSessions({ signIn });
		const pages: OwnerPages = {
			open: async () => ({ page: "page-a", fingerprint: "test", html: "" }),
			unseal: async () => ({
				page: "page-a",
				cwd: "/project-a",
				answers: {
					store: "infisical",
					INFISICAL_TOKEN: "synthetic-token-a",
					INFISICAL_CLI_SESSION: "synthetic-copied-session",
					OP_CONNECT_TOKEN: "different-provider-token",
				},
			}),
			openRelay: async () => {
				throw new Error("unused");
			},
			unsealRelay: async () => {
				throw new Error("unused");
			},
		};
		const config = {
			cwd: "/project-a",
			locatorFor: () => ({
				assertCurrent: () => {},
				onOwnerChoice: () => {
					steps.push("choice");
				},
				selectionRevision: () => 0,
				read: async () => ({}),
				write: async () => {
					steps.push("write");
				},
			}),
			sessions,
			pages,
			deposit: legacyDeposit,
		};
		const app = createStoreChoiceApp(config);
		try {
			await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{},
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			const result = await app.callTool(
				SUBMIT_OWNER_PAGE_TOOL,
				{ sealed: "synthetic-envelope" },
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			expect(steps).toEqual(["choice", "write", "sign-in"]);
			expect(signIn).toHaveBeenCalledOnce();
			expect(legacyDeposit).not.toHaveBeenCalled();
			expect(waiting.holds("INFISICAL_TOKEN")).toBe(false);
			expect(JSON.stringify(result)).not.toContain("synthetic-token-a");
			expect(JSON.stringify(result)).not.toContain("synthetic-copied-session");
		} finally {
			other.close();
			await sessions.close();
		}
	});
});
