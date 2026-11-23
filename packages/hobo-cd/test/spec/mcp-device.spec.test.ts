import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createOwnerJobs, type OwnerChannel } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	prepareVercelConnection,
	VERCEL_DEVICE_AUTHORIZATION_URL,
	VERCEL_DEVICE_TOKEN_URL,
} from "../../src/index.js";
import { fakeWorkload, handedOverInfisicalToken } from "../support/workload.js";

// SPEC: `hobo cd up --hand-off` through the HoBo MCP server. The server runs
// the CLI with --json, so no progress line reaches anyone, and no tool call
// may block on a person. Derived from the real-binary smoke: the run waited
// inside the call on a Vercel device code it could only print.
//
// So the device grant runs off the request path: the call starts it, shows
// the link through the owner channel (the host's own link prompt) and
// returns at once; the grant completes in the server's lifetime and writes
// the connection to the store; the next call finds it there. Polling is the
// protocol's (RFC 8628: interval, slow_down, expiry), on a clock this spec
// drives virtually: no real time passes.

function throughMcp(): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: () => undefined,
		// SAFETY: the preparation reads only progress and these output flags.
		flags: { json: true, quiet: false } as CommandRunInput["flags"],
	};
	return {
		action: "up",
		projectDir: "/tmp/hobo-cd-mcp",
		whatIf: false,
		yes: false,
		handOff: true,
		// SAFETY: prepareVercelConnection reads only progress and these output flags.
		run: run as CommandRunInput,
	};
}

/** Virtual time: a wait advances the clock and returns; nothing really sleeps. */
function virtualClock() {
	let at = 0;
	const waits: number[] = [];
	return {
		waits,
		now: () => at,
		sleep: async (ms: number) => {
			waits.push(ms);
			at += ms;
		},
	};
}

/** Vercel's device grant, answering per RFC 8628. */
function vercel(script: readonly ("pending" | "slow_down" | "denied")[] = []) {
	let approved = false;
	let polls = 0;
	const code = "WXYZ-1234";
	const fetchImpl = async (input: string | URL | Request) => {
		const url = String(input);
		if (url === VERCEL_DEVICE_AUTHORIZATION_URL)
			return Response.json({
				device_code: "device-code",
				user_code: code,
				verification_uri: "https://vercel.com/device",
				verification_uri_complete: `https://vercel.com/device?user_code=${code}`,
				expires_in: 600,
				interval: 5,
			});
		if (url === VERCEL_DEVICE_TOKEN_URL) {
			const scripted = script[polls];
			polls += 1;
			if (scripted === "denied")
				return Response.json({ error: "access_denied" }, { status: 400 });
			if (scripted === "slow_down")
				return Response.json({ error: "slow_down" }, { status: 400 });
			return approved && scripted === undefined
				? Response.json({ access_token: "vercel-token" })
				: Response.json({ error: "authorization_pending" }, { status: 400 });
		}
		if (url.startsWith("https://api.vercel.com/v2/teams"))
			return Response.json({
				teams: [{ id: "team_abc", slug: "acme" }],
				pagination: { next: null },
			});
		return new Response("{}", { status: 404 });
	};
	return {
		// SAFETY: the fake answers every request the device grant makes, by URL.
		fetch: fetchImpl as typeof fetch,
		approve: () => {
			approved = true;
		},
	};
}

function harness(
	provider: ReturnType<typeof vercel>,
	confirm?: OwnerChannel["confirm"],
) {
	const clock = virtualClock();
	const jobs = createOwnerJobs();
	const shown: string[] = [];
	const owner: OwnerChannel = {
		openUrl: async () => undefined,
		captureSecret: async () => undefined,
		holds: () => false,
		show: async (url) => {
			shown.push(url);
		},
		...(confirm !== undefined ? { confirm } : undefined),
		jobs,
	};
	const port = createMemorySecretsPort({ id: "memory" });
	const store = {
		id: "infisical" as const,
		port,
		reference: (name: string) => `infisical://proj/prod/cd/${name}`,
	};
	const run = () =>
		prepareVercelConnection(throughMcp(), {
			env: {},
			vault: handedOverInfisicalToken(),
			workload: fakeWorkload(),
			ownerChannel: owner,
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
				}),
				write: async () => undefined,
			},
			openStore: async () => ({ ok: true, store }),
			fetch: provider.fetch,
			sleep: clock.sleep,
			now: clock.now,
			startPage: () => {
				throw new Error("no page through MCP");
			},
		});
	return { clock, jobs, shown, port, run };
}

const LINK = "https://vercel.com/device?user_code=WXYZ-1234";

describe("SPEC cd up through MCP: Vercel's device grant off the request path", () => {
	it("shows only the accepted grant when two starts race for one store", async () => {
		const provider = vercel();
		let starts = 0;
		let releaseStarts: () => void = () => undefined;
		let releasePoll: () => void = () => undefined;
		const bothStarted = new Promise<void>((resolve) => {
			releaseStarts = resolve;
		});
		const pollReady = new Promise<void>((resolve) => {
			releasePoll = resolve;
		});
		const racing = {
			...provider,
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input) === VERCEL_DEVICE_AUTHORIZATION_URL) {
					starts += 1;
					if (starts === 2) releaseStarts();
					await bothStarted;
				}
				if (String(input) === VERCEL_DEVICE_TOKEN_URL) await pollReady;
				return provider.fetch(input, init);
			},
		};
		const h = harness(racing);
		const results = await Promise.all([h.run(), h.run()]);
		expect(
			results.every((result) => JSON.stringify(result).includes(LINK)),
		).toBe(true);
		expect(h.shown).toEqual([LINK]);
		provider.approve();
		releasePoll();
		await h.jobs.settled();
	});

	it("does not start another grant if the first finishes while a second starts", async () => {
		const provider = vercel();
		provider.approve();
		let starts = 0;
		let releaseSecond: () => void = () => undefined;
		let secondStarted: () => void = () => undefined;
		const secondReady = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const secondMayFinish = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const racing = {
			...provider,
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				if (
					String(input) === VERCEL_DEVICE_AUTHORIZATION_URL &&
					++starts === 2
				) {
					secondStarted();
					await secondMayFinish;
				}
				return provider.fetch(input, init);
			},
		};
		const h = harness(racing);
		const first = h.run();
		const second = h.run();
		await secondReady;
		await first;
		await h.jobs.settled();
		releaseSecond();
		expect((await second).kind).toBe("ready");
		expect(h.shown).toEqual([LINK]);
	});
	it("returns at once with the link shown, then the next call finds the connection", async () => {
		const provider = vercel();
		const h = harness(provider);
		const first = await h.run();
		expect(first).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_VERCEL_AWAITING_APPROVAL" },
		});
		expect(JSON.stringify(first)).not.toMatch(/HANDOFF_SILENT|--json/u);
		expect(h.shown).toEqual([LINK]);
		// The owner approves; the grant completes in the background.
		provider.approve();
		await h.jobs.settled();
		expect(await h.port.access("HOBO_CD_VERCEL_TOKEN")).toMatchObject({
			status: "ok",
		});
		const second = await h.run();
		expect(second.kind).toBe("ready");
	});

	it("a call while the owner has not approved yet starts nothing new and repeats the same link", async () => {
		const h = harness(vercel(["pending", "pending"]));
		await h.run();
		const again = await h.run();
		expect(again).toMatchObject({
			result: { code: "HOBO_CD_VERCEL_AWAITING_APPROVAL" },
		});
		expect(JSON.stringify(again)).toContain(LINK);
		expect(h.shown).toEqual([LINK]);
	});

	it("honours slow_down: the next poll waits five seconds longer (RFC 8628 §3.5)", async () => {
		const provider = vercel(["slow_down"]);
		const h = harness(provider);
		await h.run();
		provider.approve();
		await h.jobs.settled();
		expect(h.clock.waits.slice(0, 2)).toEqual([5000, 10000]);
	});

	it("a denied grant is reported on the next call, and the call after starts a fresh one", async () => {
		const h = harness(vercel(["denied"]));
		await h.run();
		await h.jobs.settled();
		const denied = await h.run();
		expect(denied).toMatchObject({
			result: { code: "HOBO_CD_VERCEL_DEVICE_DENIED" },
		});
		const fresh = await h.run();
		expect(fresh).toMatchObject({
			result: { code: "HOBO_CD_VERCEL_AWAITING_APPROVAL" },
		});
		expect(h.shown).toEqual([LINK, LINK]);
	});

	it("through a form: submitted once approved, the same call ends ready on the stored connection", async () => {
		const provider = vercel();
		const asked: string[] = [];
		const h = harness(provider, async ({ url }) => {
			asked.push(url);
			provider.approve();
			return true;
		});
		const outcome = await h.run();
		expect(outcome.kind).toBe("ready");
		expect(asked).toEqual([LINK]);
		expect(h.shown).toEqual([]);
		expect(await h.port.access("HOBO_CD_VERCEL_TOKEN")).toMatchObject({
			status: "ok",
		});
	});

	it("through a form: submitted but denied on Vercel, the same call ends with Vercel's refusal", async () => {
		const h = harness(vercel(["denied"]), async () => true);
		const outcome = await h.run();
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_VERCEL_DEVICE_DENIED" },
		});
	});

	it("through a form: closed, the call says it waits, and the next call shows the same link and code again", async () => {
		const asked: string[] = [];
		const h = harness(vercel(["pending", "pending"]), async ({ url }) => {
			asked.push(url);
			return false;
		});
		const first = await h.run();
		expect(first).toMatchObject({
			result: { code: "HOBO_CD_VERCEL_AWAITING_APPROVAL" },
		});
		await h.run();
		expect(asked).toEqual([LINK, LINK]);
	});
});
