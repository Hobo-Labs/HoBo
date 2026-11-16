import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
	CAPTURE_SECRET_TOOL,
	type CapturePublicKey,
	createSecretCaptureApp,
	NO_HOST_SUPPORT,
	OWNER_PREVIEW_LINE_PREFIX,
	SECRET_CAPTURE_STATUS_TOOL,
	type SecretCaptureApp,
	secretCaptureSpec,
} from "../src/index.js";
import {
	http,
	memoryConnector,
	sealAsTheFormDoes,
	synthetic,
} from "./secret-capture-support.js";

// A remote dev box whose agent host shows no MCP Apps: the owner is not at
// this machine, so a page on its 127.0.0.1 can never reach them. The form is
// served at `/` of its own port for the host's port preview or forwarding,
// whatever Host and Origin that forwarder sends, and the owner proves it is
// them with the pairing code the agent gives them in chat.

const SESSION = secretCaptureSpec({
	name: "INFISICAL_CLI_SESSION",
	target: "handoff",
	label: "Infisical sign-in",
	purpose: "Handed to the waiting run.",
	minBytes: 20,
	maxBytes: 16384,
	charset: "printable-line",
	pattern: "^[A-Za-z0-9+/=]+$",
});

const apps: SecretCaptureApp[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

function remoteApp(received: string[]) {
	const app = createSecretCaptureApp({
		specs: [SESSION],
		connector: memoryConnector(),
		remote: true,
		handoff: async (secret) => {
			received.push(secret.reveal());
		},
	});
	apps.push(app);
	return app;
}

const opened = z.object({
	kind: z.literal("result"),
	result: z.object({
		content: z.array(z.object({ text: z.string() })),
		structuredContent: z.object({
			ticketId: z.string(),
			name: z.string(),
			key: z.custom<CapturePublicKey>(),
		}),
	}),
});

async function open(app: SecretCaptureApp) {
	const outcome = opened.parse(
		await app.callTool(
			CAPTURE_SECRET_TOOL,
			{ name: SESSION.name },
			NO_HOST_SUPPORT,
		),
	);
	const text = outcome.result.content[0]?.text ?? "";
	const line = new RegExp(
		`^${OWNER_PREVIEW_LINE_PREFIX} port=(\\d+) pairing=([A-Z0-9]{4}-[A-Z0-9]{4})$`,
		"mu",
	).exec(text);
	if (line === null) throw new Error(`no preview line in: ${text}`);
	return {
		text,
		ticket: outcome.result.structuredContent,
		port: Number(line[1]),
		pairing: line[2] ?? "",
	};
}

/** What a host's preview forwards: its own Host and Origin, not the box's. */
const FORWARDED = {
	host: "8f3c-preview.example.dev",
	origin: "https://8f3c-preview.example.dev",
};

describe("secret capture on a remote box without MCP Apps", () => {
	it("never offers a page on this machine; names the port and a pairing code instead", async () => {
		const { text } = await open(remoteApp([]));
		expect(text).not.toMatch(
			/127\.0\.0\.1|localhost|on this machine\b(?! so)/u,
		);
		expect(text).toMatch(/report_preview_port/u);
	});

	it("serves the form at / through a forwarder's Host, and takes the value with the pairing code", async () => {
		const received: string[] = [];
		const app = remoteApp(received);
		const { ticket, port, pairing } = await open(app);
		const page = await http(`http://127.0.0.1:${port}/`, {
			headers: FORWARDED,
		});
		expect(page.status).toBe(200);
		expect(page.body).toContain("capture-pairing");
		expect(page.body).not.toContain(pairing);
		const value = Buffer.from(synthetic("session")).toString("base64");
		const stored = await http(`http://127.0.0.1:${port}/`, {
			method: "POST",
			headers: { ...FORWARDED, "content-type": "application/json" },
			body: JSON.stringify({
				token: pairing.toLowerCase().replace("-", " "),
				sealed: await sealAsTheFormDoes(ticket, value),
			}),
		});
		expect(stored.status).toBe(200);
		expect(received).toEqual([value]);
		const status = await app.callTool(
			SECRET_CAPTURE_STATUS_TOOL,
			{ ticketId: ticket.ticketId },
			NO_HOST_SUPPORT,
		);
		expect(JSON.stringify(status)).not.toContain(value);
	});

	it("refuses a submission without the pairing code, and closes the capture after repeated guesses", async () => {
		const received: string[] = [];
		const app = remoteApp(received);
		const { ticket, port } = await open(app);
		const sealed = await sealAsTheFormDoes(
			ticket,
			Buffer.from(synthetic("attacker")).toString("base64"),
		);
		const statuses: number[] = [];
		for (let guess = 0; guess < 5; guess += 1)
			statuses.push(
				(
					await http(`http://127.0.0.1:${port}/`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ token: `GUES-S00${guess}`, sealed }),
					})
				).status,
			);
		expect(statuses.slice(0, 4)).toEqual([403, 403, 403, 403]);
		expect(received).toEqual([]);
		// Closed: the page is gone for everyone.
		expect((await http(`http://127.0.0.1:${port}/`)).status).toBe(410);
	});

	it("a laptop (not remote) keeps the loopback page as before", async () => {
		const app = createSecretCaptureApp({
			specs: [SESSION],
			connector: memoryConnector(),
			handoff: async () => undefined,
		});
		apps.push(app);
		const outcome = await app.callTool(
			CAPTURE_SECRET_TOOL,
			{ name: SESSION.name },
			NO_HOST_SUPPORT,
		);
		expect(JSON.stringify(outcome)).toMatch(/127\.0\.0\.1/u);
	});
});
