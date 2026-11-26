import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionInfisicalAccess, type RunCommand } from "@hobo/hobo-ci";
import {
	type CapturePublicKey,
	createHoboMcpServer,
	createSecretCaptureApp,
	SECRET_CAPTURE_SEAL_SOURCE,
} from "@hobo/mcp";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createComposedHoboCli } from "../../src/cli.js";
import type { JsonObject } from "../../src/json.js";
import {
	createMcpOwnerChannel,
	INFISICAL_CLI_SESSION,
	OWNER_HANDOFF_SPECS,
} from "../../src/mcp-owner-channel.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
} from "../../src/mcp-secret-capture.js";
import {
	createMcpStdioSession,
	handleMcpMessage,
	localOperatorAuth,
} from "../../src/mcp-stdio.js";

// EVAL: Infisical from a remote dev box, end to end, with no inbound
// connection, no tunnel and nothing provisioned by hand. A handed-off run
// gives the owner Infisical's sign-in link; they sign in in their own browser
// and Infisical, unable to reach a CLI, offers its session to copy; they
// hand it over in the HoBo MCP App's secret-capture form (sealed in their
// browser, opened only by this process); the next run takes it from the HoBo
// MCP server's memory and creates its own identity and access through
// Infisical's API. Neither the copied session nor the token ever appears in
// an MCP response (so never in the agent's context or chat).

type Seal = (
	subtle: SubtleCrypto,
	key: CapturePublicKey,
	value: string,
	ticketId: string,
	aad: string,
) => Promise<{ epk: CapturePublicKey; iv: string; ciphertext: string }>;
// SAFETY: the shipped page source defines exactly this function signature.
const hoboSeal = new Function(
	`return (${SECRET_CAPTURE_SEAL_SOURCE})`,
)() as Seal;

const APPS_CLIENT = {
	extensions: {
		"io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
	},
};
const PROJECT = "proj-1";
const USER_JWT = `h.${Buffer.from(JSON.stringify({ organizationId: "org-1" })).toString("base64url")}.s`;
// What Infisical's "Copy to clipboard" copies after the sign-in.
const COPIED = Buffer.from(
	JSON.stringify({
		JTWToken: USER_JWT,
		email: "owner@example.com",
		privateKey: "",
	}),
).toString("base64");

/** Infisical's API, answering only the owner's own session. */
function fakeInfisical() {
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (
			new Headers(init?.headers).get("authorization") !== `Bearer ${USER_JWT}`
		)
			return Response.json({ message: "unauthorized" }, { status: 401 });
		if (url.pathname === `/api/v1/projects/${PROJECT}`)
			return Response.json({
				project: {
					id: PROJECT,
					name: "secrets",
					type: "secret-manager",
					environments: [{ name: "Production", slug: "prod", id: "env-1" }],
				},
			});
		// Nothing provisioned yet: no identity, no project member.
		if ((init?.method ?? "GET") === "GET")
			return Response.json({ identityMemberships: [], totalCount: 0 });
		if (url.pathname === "/api/v1/identities")
			return Response.json({ identity: { id: "ident-1" } });
		if (url.pathname.endsWith("/tokens"))
			return Response.json({ accessToken: "identity-token" });
		return Response.json({});
	};
	return { calls, fetch: fetchImpl };
}

/** A remote box: no Infisical CLI, so no session to reuse. */
const noCli: RunCommand = async () => ({
	code: 127,
	stdout: "",
	stderr: "not found",
});

const capture = z.object({
	structuredContent: z.object({
		ticketId: z.string(),
		name: z.string(),
		key: z.custom<CapturePublicKey>(),
	}),
});
const submitted = z.object({
	structuredContent: z.object({
		status: z.string(),
		ref: z.string().optional(),
	}),
});

describe("EVAL remote dev box: Infisical sign-in through the HoBo MCP App, end to end", () => {
	it("refuses with the link, takes the sealed session from the form, then provisions", async () => {
		const owner = createMcpOwnerChannel();
		const app = createSecretCaptureApp({
			specs: [...RELAY_SECRET_CAPTURE_SPECS, ...OWNER_HANDOFF_SPECS],
			connector: createInfisicalCaptureConnector({
				projectDir: mkdtempSync(path.join(tmpdir(), "hobo-remote-signin-")),
			}),
			handoff: async (secret) => owner.deposit(secret.name, secret.reveal()),
		});
		const session = createMcpStdioSession(app);
		const server = createHoboMcpServer({
			cli: createComposedHoboCli({ ownerChannel: owner }),
		});
		const responses: string[] = [];
		let id = 0;
		const rpc = async (method: string, params?: JsonObject) => {
			id += 1;
			const response = await handleMcpMessage(
				server,
				localOperatorAuth({}),
				JSON.stringify({ jsonrpc: "2.0", id, method, params }),
				session,
			);
			// Over the wire: what a client receives is the JSON text.
			const wire = JSON.stringify(response);
			responses.push(wire);
			return z.object({ result: z.json().optional() }).parse(JSON.parse(wire))
				.result;
		};
		await rpc("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: APPS_CLIENT,
		});
		const api = fakeInfisical();
		const provision = () =>
			provisionInfisicalAccess({
				family: "cd",
				projectId: PROJECT,
				run: noCli,
				which: async () => undefined,
				toolsDir: "/unused",
				fetch: api.fetch,
				emit: () => undefined,
				interactive: false,
				owner,
				exists: () => false,
			});

		// 1. The run has no session: it refuses with the link and the capture.
		const first = await provision();
		if (first.kind !== "refused")
			throw new Error("expected the sign-in refusal");
		expect(first.remediation[0]).toMatch(
			new RegExp(
				`^HOBO_OWNER_SIGN_IN url=https://app\\.infisical\\.com/login\\?callback_port=\\d+ capture=${INFISICAL_CLI_SESSION}$`,
				"u",
			),
		);
		expect(api.calls).toEqual([]);

		// 2. The owner signs in and hands Infisical's copied session over in the
		// MCP App form, sealed in their browser.
		const ticket = capture.parse(
			await rpc("tools/call", {
				name: "capture_secret",
				arguments: { name: INFISICAL_CLI_SESSION },
			}),
		).structuredContent;
		const sealed = await hoboSeal(
			globalThis.crypto.subtle,
			ticket.key,
			COPIED,
			ticket.ticketId,
			`${ticket.ticketId}:${ticket.name}`,
		);
		const stored = submitted.parse(
			await rpc("tools/call", {
				name: "submit_secret_value",
				arguments: {
					ticketId: ticket.ticketId,
					sealed: { ticketId: ticket.ticketId, ...sealed },
				},
			}),
		).structuredContent;
		expect(stored).toMatchObject({
			status: "stored",
			ref: `handoff://${INFISICAL_CLI_SESSION}`,
		});

		// 3. The next run takes it and provisions through the API.
		const second = await provision();
		expect(second).toMatchObject({
			kind: "ready",
			identityId: "ident-1",
			projectId: PROJECT,
			environment: "prod",
			token: "identity-token",
		});
		expect(api.calls).toContain("POST /api/v1/identities");

		// Taken once: a later run must sign in again.
		expect(
			await owner.captureSecret({
				name: INFISICAL_CLI_SESSION,
				title: "",
				instructions: "",
			}),
		).toBeUndefined();
		// Nothing secret ever left the server in an MCP response.
		const wire = responses.join("\n");
		expect(wire).not.toContain(COPIED);
		expect(wire).not.toContain(USER_JWT);
		expect(wire).not.toContain("identity-token");
	});
});
