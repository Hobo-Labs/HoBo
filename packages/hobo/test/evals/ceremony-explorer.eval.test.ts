import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import fc from "fast-check";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { JsonObject } from "../../src/json.js";
import { composeHoboMcp } from "../../src/mcp-serve.js";
import { localOperatorAuth, serveMcpStdio } from "../../src/mcp-stdio.js";
import {
	copiedSession,
	startFakeInfisical,
} from "./support/fake-infisical-api.js";
import {
	fakeNeon,
	fakeVercel,
	fakeVercelCli,
} from "./support/fake-providers.js";
import { startTlsWorld } from "./support/tls-world.js";

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
	api.seedJournalFleet();
	const vercelCli = fakeVercelCli(
		mkdtempSync(path.join(tmpdir(), "hobo-explore-vercel-")),
		path.join(
			REPO,
			"packages",
			"cd-vercel",
			"deploy",
			"secret-store.binding.json",
		),
	);
	const vercel = fakeVercel(vercelCli.staged);
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
		XDG_STATE_HOME: config,
		CLAUDE_CODE_REMOTE: "true",
		HOBO_VERCEL_CLI: vercelCli.cli,
		GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF || "hobo-explore",
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
	// Resolved each time the owner has acted on Vercel's form.
	let vercelActed = Promise.withResolvers<void>();
	// The owner has handed over a valid session at least once.
	let signedIn = false;

	// One HoBo MCP server, wired as the binary wires it; `restart` starts a
	// fresh one.
	function startServer() {
		const toServer = new PassThrough();
		const fromServer = new PassThrough();
		const composed = composeHoboMcp({
			output: fromServer,
			projectDir: config,
			remote: true,
			clock,
		});
		const serving = serveMcpStdio({
			server: composed.server,
			auth: localOperatorAuth({}),
			input: toServer,
			output: fromServer,
			session: composed.session,
		}).finally(() => composed.close());
		return { toServer, fromServer, serving };
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

	/** The owner, at the forms their host shows. */
	async function answerPrompt(prompt: Message) {
		const id = prompt.id ?? null;
		const { requestedSchema } = z
			.object({
				requestedSchema: z.object({
					properties: z.record(z.string(), z.record(z.string(), z.json())),
				}),
			})
			.parse(prompt.params);
		const link = z
			.object({ default: z.string() })
			.safeParse(requestedSchema.properties.link);
		const vercelLink =
			link.success && new URL(link.data.default).hostname === "vercel.com"
				? link.data.default
				: undefined;
		if (vercelLink !== undefined) {
			// Vercel's approval form: approve or deny there, then submit.
			story.push("form: vercel");
			const acted = vercelActed;
			if (owner.declineVercelLink > 0) {
				owner.declineVercelLink -= 1;
				send({ jsonrpc: "2.0", id, result: { action: "decline" } });
				return acted.resolve();
			}
			if (owner.denyVercel > 0) {
				owner.denyVercel -= 1;
				vercel.deny(vercelLink);
			} else vercel.approve(vercelLink);
			send({
				jsonrpc: "2.0",
				id,
				result: { action: "accept", content: { done: true } },
			});
			return acted.resolve();
		}
		// The sign-in form: Infisical's link, and the paste field.
		story.push("form: sign-in");
		if (owner.declineSignInLink > 0 || owner.declineForm > 0) {
			if (owner.declineSignInLink > 0) owner.declineSignInLink -= 1;
			else owner.declineForm -= 1;
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
		signedIn = true;
		if (owner.infisicalFault === "expired") {
			// The session lapses before the run uses it: one more sign-in.
			owner.infisicalFault = "none";
			api.expireAll();
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

	// The agent, by the hobo-deploy skill: run cd; the owner answers the
	// forms it asks for; after a refusal, run it again. Nothing else.
	try {
		for (let step = 0; step < 16; step += 1) {
			let settled = false;
			const pending = call("cd", {
				args: ["up", "--hand-off"],
				cwd: REPO,
			}).then((ran) => {
				settled = true;
				return ran;
			});
			// Time passes only once the owner has acted on Vercel's form, and
			// only while the call that waits on the grant is open.
			while (!settled) {
				await Promise.race([pending, vercelActed.promise]);
				if (settled) break;
				vercelActed = Promise.withResolvers<void>();
				while (!settled) {
					clock.advance();
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			}
			const ran = await pending;
			const code = /\\"code\\":\\"(\w+)\\"/u.exec(ran)?.[1];
			story.push(`cd: ${code ?? ran.slice(0, 300)}`);
			if (code === "HOBO_CD_VERCEL_DEVICE_DENIED") break;
			if (owner.restartAfterCapture && signedIn) {
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
				continue;
			}
			if (code?.startsWith("HOBO_CD_") && !/PLAN_REJECTED/u.test(code))
				continue;
			break;
		}
	} finally {
		server.toServer.end();
		await server.serving;
		await world.close();
		await api.close();
		vi.unstubAllEnvs();
		rmSync(config, { recursive: true, force: true });
	}
	return {
		events: eventsFromWire(wire),
		secrets,
		blocked: world.blocked,
		story,
	};
}

function verdictsOf(run: Awaited<ReturnType<typeof runSchedule>>) {
	return ceremonyProperties({ secrets: run.secrets })
		.map((property) => check(property, run.events))
		.filter((verdict) => !verdict.holds);
}

function expectedOutcome(
	schedule: Schedule,
	run: Awaited<ReturnType<typeof runSchedule>>,
): boolean {
	const reached = check(REACHES_FRONTIER, run.events).holds;
	if (schedule.denyVercel === 0) return reached;
	const result = run.events.filter((event) => event.kind === "result").at(-1);
	return (
		result?.kind === "result" &&
		result.code === "HOBO_CD_VERCEL_DEVICE_DENIED" &&
		!reached
	);
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
		expect(run.story.at(-1)).toBe("cd: HOBO_OK");
		expect(check(REACHES_FRONTIER, run.events).holds).toBe(true);
	}, 120_000);

	it("stops after the owner explicitly denies Vercel approval", async () => {
		const run = await runSchedule({ ...BASE, denyVercel: 1 });
		expect(run.story.filter((entry) => entry.startsWith("cd:"))).toEqual([
			"cd: HOBO_CD_VERCEL_DEVICE_DENIED",
		]);
		expect(verdictsOf(run)).toEqual([]);
		expect(check(REACHES_FRONTIER, run.events).holds).toBe(false);
	}, 120_000);

	it("bounded exhaustive: all 72 schedules preserve safety and reach the frontier unless the owner denies Vercel", async () => {
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
			if (!expectedOutcome(schedule, run))
				failed.push("unexpected terminal outcome");
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
					expect(expectedOutcome(schedule, run)).toBe(true);
				},
			),
			{ numRuns: 25 },
		);
	}, 600_000);
});
