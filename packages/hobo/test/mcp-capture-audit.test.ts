import {
	createCipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import {
	CAPTURE_SECRET_TOOL,
	type CapturePublicKey,
	createHoboMcpServer,
	createSecretCaptureApp,
	SECRET_CAPTURE_SEAL_INFO,
	type SecretCaptureEvent,
	type SecretStoreConnector,
	SUBMIT_SECRET_VALUE_TOOL,
	secretCaptureSpec,
} from "@hobo/mcp";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { isJsonObject, isJsonString, type JsonObject } from "../src/json.js";
import { openMcpAuditJournal } from "../src/mcp-audit-journal.js";
import {
	createMcpStdioSession,
	handleMcpMessage,
	localOperatorAuth,
} from "../src/mcp-stdio.js";

function seal(
	ticketId: string,
	name: string,
	publicKey: CapturePublicKey,
	value: string,
) {
	const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const shared = diffieHellman({
		privateKey: ephemeral.privateKey,
		publicKey: createPublicKey({ key: publicKey, format: "jwk" }),
	});
	const key = Buffer.from(
		hkdfSync(
			"sha256",
			shared,
			Buffer.from(ticketId),
			Buffer.from(SECRET_CAPTURE_SEAL_INFO),
			32,
		),
	);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(`${ticketId}:${name}`));
	const ciphertext = Buffer.concat([
		cipher.update(value, "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const epk = ephemeral.publicKey.export({ format: "jwk" });
	if (!epk.x || !epk.y) throw new Error("missing ephemeral key");
	key.fill(0);
	return {
		ticketId,
		epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y },
		iv: iv.toString("base64url"),
		ciphertext: ciphertext.toString("base64url"),
	};
}

it("persists capture authorization and a retried write intent without duplicating the store write", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-capture-journal-"));
	const auth = localOperatorAuth({
		HOBO_MCP_SUBJECT: "alice",
		HOBO_MCP_TENANT: "tenant-a",
	});
	const journal = openMcpAuditJournal(home);
	let journalOpen = true;
	let writes = 0;
	let loseAcknowledgement = true;
	const connector: SecretStoreConnector = {
		async status() {
			return {
				connected: true,
				writable: true,
				storeRef: "secref://fixture",
				writerSpec: "WRITER",
			};
		},
		async authorizeWriter() {
			throw new Error("unused");
		},
		async store(_target, secret) {
			writes += 1;
			expect(secret.reveal()).toBe(value);
			return { ref: "secref://fixture/DEMO_SECRET" };
		},
		async endWriterSession() {
			return "none";
		},
	};
	const value = `synthetic-${randomBytes(20).toString("hex")}`;
	const capture = createSecretCaptureApp({
		specs: [
			secretCaptureSpec({
				name: "DEMO_SECRET",
				target: "runtime",
				label: "Demo",
				purpose: "Test",
				minBytes: 8,
				maxBytes: 128,
				charset: "printable-line",
			}),
		],
		connector,
		async onEvent(event) {
			await journal.recordCapture(event, auth);
			if (event.type === "secret.CaptureWriteStarted" && loseAcknowledgement)
				throw new Error("lost acknowledgement");
		},
	});
	const session = createMcpStdioSession(capture);
	session.support = { apps: true, urlElicitation: false };
	const server = createHoboMcpServer({
		cli: createHoboCli(),
		auditSink: journal.record,
		rateLimitAuditSink: journal.record,
	});
	async function call(name: string, args: JsonObject) {
		const response = await handleMcpMessage(
			server,
			auth,
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
			session,
		);
		if (
			!response ||
			!isJsonObject(response.result) ||
			!isJsonObject(response.result.structuredContent)
		)
			throw new Error("expected structured response");
		return response.result.structuredContent;
	}
	try {
		const ticket = await call(CAPTURE_SECRET_TOOL, { name: "DEMO_SECRET" });
		if (
			!isJsonString(ticket.ticketId) ||
			!isJsonString(ticket.name) ||
			!isJsonObject(ticket.key) ||
			ticket.key.kty !== "EC" ||
			ticket.key.crv !== "P-256" ||
			!isJsonString(ticket.key.x) ||
			!isJsonString(ticket.key.y)
		)
			throw new Error("expected capture ticket");
		const sealed = seal(
			ticket.ticketId,
			ticket.name,
			{ kty: "EC", crv: "P-256", x: ticket.key.x, y: ticket.key.y },
			value,
		);
		const args = { ticketId: ticket.ticketId, sealed };
		expect(await call(SUBMIT_SECRET_VALUE_TOOL, args)).toMatchObject({
			code: "SECRET_CAPTURE_AUDIT_UNAVAILABLE",
		});
		expect(writes).toBe(0);
		loseAcknowledgement = false;
		expect(await call(SUBMIT_SECRET_VALUE_TOOL, args)).toMatchObject({
			stored: true,
		});
		expect(writes).toBe(1);
		await capture.close();
		journal.close();
		journalOpen = false;
		const reopened = createRuntimeLocalEventStore({
			dataDir: join(home, "mcp-audit"),
		});
		try {
			const events = [];
			for await (const positioned of reopened.readAll())
				events.push(positioned.event);
			expect(
				events.filter((event) => event.type === "secret.CaptureWriteStarted"),
			).toHaveLength(1);
			expect(
				events.filter((event) => event.type === "secret.CaptureStored"),
			).toHaveLength(1);
			expect(
				events.filter((event) => event.type === "mcp.ToolCallDecided"),
			).toHaveLength(3);
			expect(
				events.every(
					(event) => event.tenant === "tenant-a" && event.actor.id === "alice",
				),
			).toBe(true);
			expect(JSON.stringify(events)).not.toContain(value);
		} finally {
			reopened.close();
		}
	} finally {
		await capture.close().catch(() => undefined);
		if (journalOpen) journal.close();
		rmSync(home, { recursive: true, force: true });
	}
});

it("rejects a reused capture event id across payloads or tenants", async () => {
	const home = mkdtempSync(join(tmpdir(), "hobo-capture-id-"));
	const journal = openMcpAuditJournal(home);
	const first = localOperatorAuth({ HOBO_MCP_TENANT: "tenant-a" });
	const other = localOperatorAuth({ HOBO_MCP_TENANT: "tenant-b" });
	const event: SecretCaptureEvent = {
		id: "sec_0123456789abcdef0123456789abcdef",
		schemaVersion: "hobo.secret-capture/v1",
		type: "secret.CaptureWriteStarted",
		seq: 1,
		time: "2026-11-17T00:00:00.000Z",
		ticketId: "cap_AAAAAAAAAAAAAAAAAAAAAA",
	};
	try {
		await journal.recordCapture(event, first);
		await journal.recordCapture(event, first);
		await expect(
			journal.recordCapture({ ...event, seq: 2 }, first),
		).rejects.toThrow("id was reused");
		await expect(journal.recordCapture(event, other)).rejects.toThrow(
			"id was reused",
		);
	} finally {
		journal.close();
		rmSync(home, { recursive: true, force: true });
	}
});

it("blocks capture before contacting its store when scope or audit denies it", async () => {
	for (const mode of ["scope", "audit"]) {
		let calls = 0;
		const connector: SecretStoreConnector = {
			async status() {
				calls += 1;
				return { connected: false, reason: "none", nextStep: "connect" };
			},
			async authorizeWriter() {
				throw new Error("unused");
			},
			async store() {
				throw new Error("unused");
			},
			async endWriterSession() {
				return "none";
			},
		};
		const capture = createSecretCaptureApp({ specs: [], connector });
		const server = createHoboMcpServer({
			cli: createHoboCli(),
			auditSink: async () => {
				if (mode === "audit") throw new Error("private storage failure");
			},
		});
		const auth = localOperatorAuth(
			mode === "scope" ? { HOBO_MCP_TOOLS: "plan" } : {},
		);
		try {
			const response = await handleMcpMessage(
				server,
				auth,
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: CAPTURE_SECRET_TOOL,
						arguments: { name: "DEMO_SECRET" },
					},
				}),
				createMcpStdioSession(capture),
			);
			expect(JSON.stringify(response)).toContain(
				mode === "scope" ? "MCP_SCOPE_DENIED" : "MCP_AUDIT_UNAVAILABLE",
			);
			expect(JSON.stringify(response)).not.toContain("private storage failure");
			expect(calls).toBe(0);
		} finally {
			await capture.close();
		}
	}
});

it.each([
	"null",
	"[]",
	"42",
	'{"jsonrpc":"1.0","id":1,"method":"ping"}',
	'{"jsonrpc":"2.0","id":{},"method":"ping"}',
	'{"jsonrpc":"2.0","id":1e400,"method":"ping"}',
	'{"jsonrpc":"2.0","id":1}',
])("rejects malformed JSON-RPC requests without dispatching: %s", async (raw) => {
	const server = createHoboMcpServer({ cli: createHoboCli() });
	const response = await handleMcpMessage(server, localOperatorAuth({}), raw);
	expect(response).toEqual({
		jsonrpc: "2.0",
		id: null,
		error: { code: -32600, message: "invalid request" },
	});
	expect(server.getAuditEvents()).toEqual([]);
});
