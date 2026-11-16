import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
	applyEgressToProcess,
	ceremonyProperties,
	check,
	eventsFromWire,
	REACHES_FRONTIER,
	secretStoreLocatorPath,
	type WireMessage,
} from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";
import fc from "fast-check";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createComposedHoboCli } from "../../src/cli.js";
import type { JsonObject } from "../../src/json.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
	INFISICAL_CLI_SESSION,
} from "../../src/mcp-owner-channel.js";
import { createInfisicalCaptureConnector } from "../../src/mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	type McpStdioSession,
	serveMcpStdio,
} from "../../src/mcp-stdio.js";
import {
	copiedSession,
	startFakeInfisical,
} from "./support/fake-infisical-api.js";
import { fakeNeon, fakeVercel } from "./support/fake-providers.js";
import { startTlsWorld } from "./support/tls-world.js";

// EVAL: the remote cd up ceremony explored, not sampled by hand. Every
// combination of the owner's choices and the providers' faults below is run
// end to end, in-process, through the real composed CLI and HoBo MCP server,
// behind an inspecting proxy that answers as the providers' real hosts, on a
// virtual clock. Each trace is checked against every property derived from
// the ceremony's spec (packages/hobo-ci/src/ceremony-spec/model.ts) and
// must reach the frontier: the owner is fair (what they decline or get
// wrong once, they get right the next time), so every path must end with
// nothing more asked of them. fast-check then runs deeper, random schedules
// (repeated declines, restarts of the server) with shrinking and a seed.

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const LIVE_HOST = {
	roots: { listChanged: true },
	elicitation: { form: {}, url: {} },
};

/** One owner/provider schedule. Counts are how many times before doing it right. */
export interface Schedule {
	readonly declineSignInLink: number;
	readonly declineForm: number;
	readonly wrongPaste: number;
	readonly infisicalFault: "none" | "503" | "expired";
	readonly declineVercelLink: number;
	readonly denyVercel: number;
	readonly restartAfterCapture: boolean;
}

const message = z.record(z.string(), z.json());
type Message = z.infer<typeof message>;

/**
 * Virtual time the explorer drives, like fake timers: a wait registers a
 * timer, and time moves only when the explorer advances it. So a grant
 * cannot run ahead of the owner: time passes once they have acted.
 */
function virtualClock() {
	let at = 1_000_000;
	const timers: { due: number; fire: () => void }[] = [];
	return {
		now: () => at,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				timers.push({ due: at + ms, fire: resolve });
			}),
		/** Move to the next timer and fire everything due. */
		advance() {
			const due = Math.min(...timers.map((timer) => timer.due));
			if (!Number.isFinite(due)) return false;
			at = Math.max(at, due);
			for (const timer of timers.splice(0).filter((t) => {
				if (t.due <= at) return true;
				timers.push(t);
				return false;
			}))
				timer.fire();
			return true;
		},
	};
}

async function runSchedule(schedule: Schedule) {
	const api = await startFakeInfisical("org-1");
	const vercel = fakeVercel();
	const neon = fakeNeon();
	const world = await startTlsWorld({
		"app.infisical.com": api.handle,
		"api.vercel.com": vercel.handle,
		"neon.new": neon.handle,
	});
	const config = mkdtempSync(path.join(tmpdir(), "hobo-explore-"));
	// The owner's choice, saved where the server keys it: the directory it
	// runs in (the repo root for the live host; this worker's here).
	for (const where of new Set([REPO, process.cwd()])) {
		const locator = secretStoreLocatorPath(where, { XDG_CONFIG_HOME: config });
		mkdirSync(path.dirname(locator), { recursive: true });
		writeFileSync(
			locator,
			JSON.stringify({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj-1",
			}),
		);
	}
	for (const [name, value] of Object.entries({
		XDG_CONFIG_HOME: config,
		CLAUDE_CODE_REMOTE: "true",
		HTTPS_PROXY: world.proxyUrl,
		HTTP_PROXY: world.proxyUrl,
		NO_PROXY: "",
		NODE_EXTRA_CA_CERTS: world.caBundle,
	}))
		vi.stubEnv(name, value);
	applyEgressToProcess(process.env);
	if (schedule.infisicalFault === "503") api.fail("create-identity", 503);

	const wire: WireMessage[] = [];
	const secrets: string[] = [];
	// What each step answered, in order: a failing schedule's story.
	const story: string[] = [];
	const clock = virtualClock();
	const owner = { ...schedule };
	// Resolved each time the owner has acted on a Vercel link prompt.
	let vercelActed = Promise.withResolvers<void>();

	// One HoBo MCP server, as the host runs it; `restart` starts a fresh one.
	function startServer() {
		const toServer = new PassThrough();
		const fromServer = new PassThrough();
		let session: McpStdioSession | undefined;
		const channel = createMcpOwnerChannel({
			prompt: async (params) => {
				await session?.request?.("elicitation/create", params);
			},
			notify: (method, params) => {
				fromServer.write(
					`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
				);
			},
		});
		session = createMcpStdioSession(
			createOwnerCaptureApp({
				owner: channel,
				connector: createInfisicalCaptureConnector({ projectDir: config }),
				remote: true,
				elicit: (params) => {
					const request = session?.request;
					if (request === undefined) throw new Error("no transport");
					return request("elicitation/create", params);
				},
			}),
		);
		const serving = serveMcpStdio({
			server: createHoboMcpServer({
				cli: createComposedHoboCli({ ownerChannel: channel, clock }),
			}),
			auth: localOperatorAuth({}),
			input: toServer,
			output: fromServer,
			session,
		});
		return { toServer, fromServer, channel, serving };
	}

	let server = startServer();
	const inbox: Message[] = [];
	const waiters: (() => void)[] = [];
	const listen = (stream: PassThrough) => {
		let buffer = "";
		stream.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (line.trim() === "") continue;
				wire.push({ to: "host", message: line });
				const parsed = message.parse(JSON.parse(line));
				if (parsed.method === "elicitation/create") void answerPrompt(parsed);
				else inbox.push(parsed);
			}
			for (const wake of waiters.splice(0)) wake();
		});
	};
	const send = (m: Message) => {
		const line = JSON.stringify(m);
		wire.push({ to: "server", message: line });
		server.toServer.write(`${line}\n`);
	};
	const next = async (match: (m: Message) => boolean): Promise<Message> => {
		for (;;) {
			const at = inbox.findIndex(match);
			const [found] = at === -1 ? [] : inbox.splice(at, 1);
			if (found !== undefined) return found;
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
	};
	listen(server.fromServer);

	/** The owner, at their host's prompts. */
	async function answerPrompt(prompt: Message) {
		const id = prompt.id ?? null;
		const params = z
			.object({ mode: z.string().optional(), url: z.string().optional() })
			.parse(prompt.params);
		if (params.mode === "url" && params.url !== undefined) {
			const url = new URL(params.url);
			if (url.hostname === "app.infisical.com") {
				if (owner.declineSignInLink > 0) {
					owner.declineSignInLink -= 1;
					return send({ jsonrpc: "2.0", id, result: { action: "decline" } });
				}
				return send({ jsonrpc: "2.0", id, result: { action: "accept" } });
			}
			// Vercel's device link: open it, then approve or deny on Vercel.
			const acted = vercelActed;
			if (owner.declineVercelLink > 0) {
				owner.declineVercelLink -= 1;
				send({ jsonrpc: "2.0", id, result: { action: "decline" } });
				return acted.resolve();
			}
			send({ jsonrpc: "2.0", id, result: { action: "accept" } });
			if (owner.denyVercel > 0) {
				owner.denyVercel -= 1;
				vercel.deny(params.url);
			} else vercel.approve(params.url);
			return acted.resolve();
		}
		// The paste form.
		if (owner.declineForm > 0) {
			owner.declineForm -= 1;
			return send({ jsonrpc: "2.0", id, result: { action: "decline" } });
		}
		if (owner.wrongPaste > 0) {
			owner.wrongPaste -= 1;
			return send({
				jsonrpc: "2.0",
				id,
				result: { action: "accept", content: { value: "not-a-session!" } },
			});
		}
		const jwt = api.signIn();
		const copied = copiedSession(jwt);
		secrets.push(jwt, copied);
		if (owner.infisicalFault === "expired") {
			// The session lapses before the run uses it: one more sign-in.
			owner.infisicalFault = "none";
			setImmediate(() => api.expireAll());
		}
		return send({
			jsonrpc: "2.0",
			id,
			result: { action: "accept", content: { value: copied } },
		});
	}

	let ids = 0;
	const call = async (tool: string, args: JsonObject) => {
		ids += 1;
		const id = ids;
		send({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: tool, arguments: args },
		});
		return JSON.stringify(
			await next((m) => m.id === id && m.method === undefined),
		);
	};

	ids += 1;
	send({
		jsonrpc: "2.0",
		id: ids,
		method: "initialize",
		params: { protocolVersion: "2025-11-25", capabilities: LIVE_HOST },
	});
	await next((m) => m.id === ids);

	// The agent, by the hobo-deploy skill: run, act on what the run says, run again.
	try {
		for (let step = 0; step < 16; step += 1) {
			const ran = await call("cd", { args: ["up", "--hand-off"], cwd: REPO });
			const code = /\\"code\\":\\"(\w+)\\"/u.exec(ran)?.[1];
			story.push(`cd: ${code ?? ran.slice(0, 300)}`);
			if (code === "HOBO_CD_INFISICAL_SIGN_IN") {
				for (let ask = 0; ask < 4; ask += 1) {
					const captured = await call("capture_secret", {
						name: INFISICAL_CLI_SESSION,
					});
					story.push(
						`capture: ${/SECRET_CAPTURE_[A-Z_]+|stored/u.exec(captured)?.[0] ?? captured.slice(0, 120)}`,
					);
					if (
						captured.includes('\\"status\\":\\"stored\\"') ||
						captured.includes('"status":"stored"')
					)
						break;
				}
				if (owner.restartAfterCapture) {
					owner.restartAfterCapture = false;
					server.toServer.end();
					await server.serving;
					server = startServer();
					listen(server.fromServer);
					ids += 1;
					send({
						jsonrpc: "2.0",
						id: ids,
						method: "initialize",
						params: { protocolVersion: "2025-11-25", capabilities: LIVE_HOST },
					});
					await next((m) => m.id === ids);
				}
				continue;
			}
			if (code === "HOBO_CD_VERCEL_AWAITING_APPROVAL") {
				// Time passes only once the owner has acted on the link; then
				// until the event the server sends when the grant ends.
				await vercelActed.promise;
				vercelActed = Promise.withResolvers<void>();
				let done = false;
				const completed = next(
					(m) => m.method === "notifications/elicitation/complete",
				).then(() => {
					done = true;
				});
				while (!done) {
					clock.advance();
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				await completed;
				continue;
			}
			if (
				code !== undefined &&
				code.startsWith("HOBO_CD_") &&
				!/PLAN_REJECTED/u.test(code)
			)
				continue;
			break;
		}
	} finally {
		server.toServer.end();
		await server.serving;
		await world.close();
		await api.close();
		vi.unstubAllEnvs();
	}
	return {
		events: eventsFromWire(wire),
		secrets,
		blocked: world.blocked,
		story,
	};
}

function verdictsOf(run: Awaited<ReturnType<typeof runSchedule>>) {
	return [...ceremonyProperties({ secrets: run.secrets }), REACHES_FRONTIER]
		.map((property) => check(property, run.events))
		.filter((verdict) => !verdict.holds);
}

const dispatcher = getGlobalDispatcher();
beforeAll(() => undefined);
afterAll(() => setGlobalDispatcher(dispatcher));

const BASE: Schedule = {
	declineSignInLink: 0,
	declineForm: 0,
	wrongPaste: 0,
	infisicalFault: "none",
	declineVercelLink: 0,
	denyVercel: 0,
	restartAfterCapture: false,
};

/** Every combination, each dimension's fault once (the owner is fair). */
function exhaustive(): Schedule[] {
	const schedules: Schedule[] = [];
	for (const declineSignInLink of [0, 1])
		for (const form of ["valid", "wrong", "decline"] as const)
			for (const infisicalFault of ["none", "503", "expired"] as const)
				for (const declineVercelLink of [0, 1])
					for (const denyVercel of [0, 1])
						schedules.push({
							...BASE,
							declineSignInLink,
							declineForm: form === "decline" ? 1 : 0,
							wrongPaste: form === "wrong" ? 1 : 0,
							infisicalFault,
							declineVercelLink,
							denyVercel,
						});
	return schedules;
}

describe("EVAL ceremony explorer: every owner choice and provider fault, end to end", () => {
	it("the owner does everything right the first time", async () => {
		const run = await runSchedule(BASE);
		process.stderr.write(`STORY ${run.story.join(" | ")}\n`);
		expect({ failed: verdictsOf(run), story: run.story }).toMatchObject({
			failed: [],
		});
		expect(run.blocked).toEqual([]);
	}, 120_000);

	it("bounded exhaustive: all 72 schedules satisfy every derived property and reach the frontier", async () => {
		const failures: {
			schedule: Schedule;
			failed: string[];
			story: string[];
		}[] = [];
		for (const schedule of exhaustive()) {
			const run = await runSchedule(schedule);
			const failed = verdictsOf(run).map(
				(verdict) =>
					`${verdict.property}${verdict.at === undefined ? "" : ` @${verdict.at}`}`,
			);
			if (run.blocked.length > 0)
				failed.push(`egress outside the proxy: ${run.blocked.join(", ")}`);
			if (failed.length > 0)
				failures.push({ schedule, failed, story: run.story });
		}
		// Grouped by what broke, with one story each: the shape of the bugs.
		const groups = new Map<string, { count: number; example: string }>();
		for (const failure of failures) {
			const key = failure.failed.join(" & ");
			const group = groups.get(key);
			if (group === undefined)
				groups.set(key, {
					count: 1,
					example: `${JSON.stringify(failure.schedule)} → ${failure.story.join(" | ")}`,
				});
			else group.count += 1;
		}
		for (const [key, group] of groups)
			process.stderr.write(
				`GROUP ${group.count}× ${key}\n  e.g. ${group.example}\n`,
			);
		expect(failures).toEqual([]);
	}, 600_000);

	it("random deeper schedules (repeats, restarts), shrunk to the smallest failing one", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					declineSignInLink: fc.nat(2),
					declineForm: fc.nat(2),
					wrongPaste: fc.nat(2),
					infisicalFault: fc.constantFrom("none", "503", "expired"),
					declineVercelLink: fc.nat(2),
					denyVercel: fc.nat(2),
					restartAfterCapture: fc.boolean(),
				}),
				async (schedule) => {
					const run = await runSchedule(schedule);
					expect(verdictsOf(run)).toEqual([]);
					expect(run.blocked).toEqual([]);
				},
			),
			{ numRuns: 25 },
		);
	}, 600_000);
});
