import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GithubTransport } from "../src/github.js";
import {
	DEFAULT_RUNNER_ROUTING,
	readBoxRoutingPolicy,
	routingEnvironmentNamesSet,
} from "../src/isolated-worker/box-routing-policy.js";
import {
	createRoutingSlipBudget,
	createRoutingSlipIssuer,
	createRoutingStallWatch,
	decideRoutingSlipClasses,
	type RoutingSlipClasses,
	type RoutingSlipDecisionInput,
	writeRoutingSlipCommit,
} from "../src/isolated-worker/routing-slip-issuer.js";
import { judgeRoutingSlip } from "../src/routing-slip.js";
import { runnerRoutingLabels } from "../src/runner-routing.js";

const REPOSITORY = "Hobo-Labs/HoBo";
const POLICY = DEFAULT_RUNNER_ROUTING;
const LABELS = runnerRoutingLabels(POLICY);
const NOW = Date.parse("2026-11-13T16:00:00.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const none: ReadonlySet<string> = new Set();
type Json = z.infer<ReturnType<typeof z.json>>;
const CommitBody = z.object({ message: z.string() });
const messageOf = (call: { body: Json } | undefined) =>
	CommitBody.parse(call?.body).message;
const both = new Set(["hobo", "hobo-trunk"]);

function decide(overrides: Partial<RoutingSlipDecisionInput> = {}) {
	return decideRoutingSlipClasses({
		policy: POLICY,
		served: both,
		refused: none,
		stalled: none,
		full: none,
		...overrides,
	});
}

/** A fake Git Data API: records every call, answers as GitHub does. */
function gitApi(
	options: { refExists?: boolean; status?: (method: string) => number } = {},
) {
	let refExists = options.refExists ?? false;
	let sequence = 0;
	const calls: { method: string; path: string; body: Json; atMs: number }[] =
		[];
	const clock = { now: NOW };
	const sha = () => (++sequence).toString(16).padStart(40, "0");
	const transport: GithubTransport = {
		async request(_installationId, path, method = "GET", body) {
			calls.push({
				method,
				path,
				body: body === undefined ? null : z.json().parse(JSON.parse(body)),
				atMs: clock.now,
			});
			const forced = options.status?.(method);
			if (forced !== undefined && forced >= 400)
				return new Response(null, { status: forced });
			if (method === "POST" && path.endsWith("/git/trees"))
				return Response.json({ sha: sha() }, { status: 201 });
			if (method === "POST" && path.endsWith("/git/commits"))
				return Response.json({ sha: sha() }, { status: 201 });
			if (method === "PATCH")
				return refExists
					? Response.json({}, { status: 200 })
					: new Response(null, { status: 422 });
			if (method === "POST" && path.endsWith("/git/refs")) {
				refExists = true;
				return Response.json({}, { status: 201 });
			}
			return new Response(null, { status: 404 });
		},
	};
	const commits = () =>
		calls.filter(
			(call) => call.method === "POST" && call.path.endsWith("/git/commits"),
		);
	return { transport, calls, clock, commits };
}

describe("the routing slip decision (plan 0026, 3.3)", () => {
	it("sends every class to its fleet label while the fleet is open", () => {
		expect(decide()).toEqual({
			pr: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
			fork: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
			trunk: { runner: "hobo-trunk", tier: "fleet", reason: "fleet-open" },
		});
	});

	// M6: busy and healthy is the fleet (R4).
	it("a box busy with its own jobs is fleet-busy, never refused", () => {
		const classes = decide({ full: both });
		expect(classes.pr).toEqual({
			runner: "hobo",
			tier: "fleet",
			reason: "fleet-busy",
		});
		expect(classes.trunk.reason).toBe("fleet-busy");
	});

	it("refuses a label no live node serves, one that stalled and one with no capacity", () => {
		expect(decide({ served: new Set(["hobo"]) }).trunk).toEqual({
			runner: "ubuntu-24.04",
			tier: "github",
			reason: "no-node",
		});
		expect(decide({ stalled: new Set(["hobo-trunk"]) }).trunk.reason).toBe(
			"stalled",
		);
		expect(decide({ refused: new Set(["hobo"]) }).pr).toEqual({
			runner: "ubuntu-24.04",
			tier: "github",
			reason: "no-capacity",
		});
	});

	it("sends a refused class to the enrolled local box, never a fork", () => {
		const classes = decideRoutingSlipClasses({
			policy: { ...POLICY, localRunner: true },
			served: both,
			refused: both,
			stalled: none,
			full: none,
		});
		expect(classes.pr).toEqual({
			runner: "hobo-local-host",
			tier: "local",
			reason: "no-capacity",
		});
		expect(classes.fork).toEqual({
			runner: "ubuntu-24.04",
			tier: "github",
			reason: "no-capacity",
		});
	});

	it("a fork never asks for the trunk label", () => {
		for (const classes of [
			decide(),
			decide({ full: both }),
			decideRoutingSlipClasses({
				policy: { ...POLICY, pin: "fleet" },
				served: both,
				refused: none,
				stalled: none,
				full: none,
			}),
		])
			expect(classes.fork.runner).not.toBe("hobo-trunk");
	});

	it("writes a committed pin into every class", () => {
		const pinned = (pin: "fleet" | "local" | "github") =>
			decideRoutingSlipClasses({
				policy: { ...POLICY, pin },
				served: none,
				refused: both,
				stalled: none,
				full: none,
			});
		expect(pinned("github").pr).toEqual({
			runner: "ubuntu-24.04",
			tier: "github",
			reason: "pinned",
		});
		expect(pinned("fleet").trunk).toEqual({
			runner: "hobo-trunk",
			tier: "fleet",
			reason: "pinned",
		});
		expect(pinned("local").pr.runner).toBe("hobo-local-host");
		expect(pinned("local").fork.tier).toBe("github");
	});
});

describe("the stall watch", () => {
	const lease = (
		id: string,
		state: "waiting" | "started",
		assignedAtMs: number,
	) => ({
		id,
		label: "hobo",
		waiting: state === "waiting",
		started: state === "started",
		assignedAtMs,
	});

	// M6: assigned, and nothing started for ten minutes, is stalled.
	it("names a label with work assigned and nothing started for the limit", () => {
		const watch = createRoutingStallWatch({
			stallMs: 600_000,
			startedAtMs: NOW,
		});
		const waiting = [lease("a", "waiting", NOW)];
		expect(watch.observe(NOW + 599_999, waiting)).toEqual(new Set());
		expect(watch.observe(NOW + 600_000, waiting)).toEqual(new Set(["hobo"]));
	});

	it("a job that started lately keeps the label from stalling", () => {
		const watch = createRoutingStallWatch({
			stallMs: 600_000,
			startedAtMs: NOW,
		});
		watch.observe(NOW + 500_000, [lease("b", "started", NOW)]);
		const leases = [lease("a", "waiting", NOW), lease("b", "started", NOW)];
		expect(watch.observe(NOW + 700_000, leases)).toEqual(new Set());
		expect(watch.observe(NOW + 1_100_000, leases)).toEqual(new Set(["hobo"]));
	});

	it("a restart is never a stall: the clock starts with the watch", () => {
		const watch = createRoutingStallWatch({
			stallMs: 600_000,
			startedAtMs: NOW,
		});
		expect(
			watch.observe(NOW + 1_000, [lease("a", "waiting", NOW - 3_600_000)]),
		).toEqual(new Set());
	});
});

describe("writing the slip", () => {
	it("makes the tree once, a parentless commit, then creates or moves the ref", async () => {
		const api = gitApi();
		const first = await writeRoutingSlipCommit(api.transport, {
			installationId: 7,
			repository: REPOSITORY,
			message: "{}",
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = await writeRoutingSlipCommit(api.transport, {
			installationId: 7,
			repository: REPOSITORY,
			message: "{}",
			treeSha: first.treeSha,
		});
		expect(second.ok).toBe(true);
		expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			`POST /repos/${REPOSITORY}/git/trees`,
			`POST /repos/${REPOSITORY}/git/commits`,
			`PATCH /repos/${REPOSITORY}/git/refs/hobo/routing-slip`,
			`POST /repos/${REPOSITORY}/git/refs`,
			`POST /repos/${REPOSITORY}/git/commits`,
			`PATCH /repos/${REPOSITORY}/git/refs/hobo/routing-slip`,
		]);
		expect(api.calls[1]?.body).toEqual({
			message: "{}",
			tree: first.treeSha,
			parents: [],
		});
		expect(api.calls[2]?.body).toMatchObject({ force: true });
		expect(api.calls[3]?.body).toMatchObject({ ref: "refs/hobo/routing-slip" });
	});

	it("reports the status and step of a refusal", async () => {
		const api = gitApi({ status: (method) => (method === "POST" ? 403 : 0) });
		expect(
			await writeRoutingSlipCommit(api.transport, {
				installationId: 7,
				repository: REPOSITORY,
				message: "{}",
			}),
		).toEqual({ ok: false, status: 403, step: "tree" });
	});
});

describe("the issuer (plan 0026, 3.2)", () => {
	const flipping = () => {
		let calls = 0;
		return async (): Promise<RoutingSlipClasses> =>
			decide({ full: ++calls % 2 === 0 ? both : none });
	};
	const issuer = (
		api: ReturnType<typeof gitApi>,
		overrides: Partial<Parameters<typeof createRoutingSlipIssuer>[0]> = {},
	) =>
		createRoutingSlipIssuer({
			github: api.transport,
			labels: LABELS,
			relay: { nodeId: "box-a", commit: COMMIT },
			leader: async () => true,
			targets: async () => [{ repository: REPOSITORY, installationId: 7 }],
			decide: async () => decide(),
			now: () => api.clock.now,
			...overrides,
		});

	it("writes a slip the route job accepts, naming the relay and its commit", async () => {
		const api = gitApi();
		await issuer(api).tick();
		const message = messageOf(api.commits()[0]);
		const judged = judgeRoutingSlip(message, {
			repository: REPOSITORY,
			nowMs: NOW + 1_000,
			labels: LABELS,
		});
		expect(judged.ok).toBe(true);
		if (judged.ok)
			expect(judged.slip.relay).toEqual({ nodeId: "box-a", commit: COMMIT });
	});

	it("writes on a change and as a 3-minute heartbeat, not on every tick", async () => {
		const api = gitApi();
		const slips = issuer(api);
		for (let second = 0; second < 600; second += 10) {
			api.clock.now = NOW + second * 1_000;
			await slips.tick();
		}
		// Ten minutes of the same answer: the first write and three heartbeats.
		expect(api.commits().map((call) => (call.atMs - NOW) / 1_000)).toEqual([
			0, 180, 360, 540,
		]);
	});

	// M7: a decision that changes on every tick still stays within the caps.
	it("never writes more than 20 slips a minute or 300 an hour", async () => {
		const api = gitApi();
		const slips = issuer(api, { decide: flipping() });
		for (let second = 0; second < 2 * 3_600; second += 1) {
			api.clock.now = NOW + second * 1_000;
			await slips.tick();
		}
		const times = api.commits().map((call) => call.atMs);
		for (const at of times) {
			expect(
				times.filter((other) => other >= at && other < at + 60_000).length,
			).toBeLessThanOrEqual(20);
			expect(
				times.filter((other) => other >= at && other < at + 3_600_000).length,
			).toBeLessThanOrEqual(300);
		}
		expect(times.length).toBeGreaterThan(300);
		expect(times.length).toBeLessThanOrEqual(600);
	});

	it("a 100-run burst adds no writes: only a changed decision does", async () => {
		const api = gitApi();
		const slips = issuer(api);
		await Promise.all(Array.from({ length: 100 }, () => slips.tick()));
		for (let index = 0; index < 100; index += 1) {
			api.clock.now = NOW + index * 100;
			await slips.tick();
		}
		expect(api.commits()).toHaveLength(1);
	});

	it("only the mesh leader writes", async () => {
		const api = gitApi();
		const nodes = ["box-a", "box-b", "box-c"];
		const leader = (id: string) => async () => [...nodes].sort()[0] === id;
		const fleet = nodes.map((id) =>
			issuer(api, {
				leader: leader(id),
				relay: { nodeId: id, commit: COMMIT },
				decide: flipping(),
			}),
		);
		for (let second = 0; second < 600; second += 10) {
			api.clock.now = NOW + second * 1_000;
			for (const slips of fleet) await slips.tick();
		}
		expect(fleet.map((slips) => slips.writes() > 0)).toEqual([
			true,
			false,
			false,
		]);
		for (const call of api.commits())
			expect(messageOf(call)).toContain('"nodeId":"box-a"');
	});

	it("backs off 10 minutes after a 403 or 429 and logs the refusal", async () => {
		for (const status of [403, 429]) {
			let refuse = true;
			const api = gitApi({
				status: (method) => (refuse && method === "POST" ? status : 0),
			});
			const events: { event: string; status?: unknown }[] = [];
			const slips = issuer(api, {
				decide: flipping(),
				log: (event, fields) => events.push({ event, status: fields.status }),
			});
			await slips.tick();
			refuse = false;
			for (let second = 10; second < 600; second += 10) {
				api.clock.now = NOW + second * 1_000;
				await slips.tick();
			}
			expect(api.commits()).toHaveLength(0);
			api.clock.now = NOW + 600_000;
			await slips.tick();
			expect(api.commits()).toHaveLength(1);
			expect(
				events.filter((entry) => entry.event === "hobo_ci_slip_write_refused"),
			).toEqual([{ event: "hobo_ci_slip_write_refused", status }]);
		}
	});

	it("runs the first-lead step once, and only on the leader", async () => {
		const api = gitApi();
		let leads = false;
		let ran = 0;
		const slips = issuer(api, {
			leader: async () => leads,
			onFirstLead: () => {
				ran += 1;
			},
		});
		await slips.tick();
		expect(ran).toBe(0);
		leads = true;
		await slips.tick();
		await slips.tick();
		expect(ran).toBe(1);
	});

	it("writes nothing while disabled or with no leader to be found", async () => {
		const api = gitApi();
		await issuer(api, { enabled: () => false }).tick();
		await issuer(api, {
			leader: async () => {
				throw new Error("board unreachable");
			},
		}).tick();
		expect(api.calls).toHaveLength(0);
	});
});

describe("the budget", () => {
	it("allows 20 a minute and 300 an hour", () => {
		const budget = createRoutingSlipBudget();
		let spent = 0;
		for (let second = 0; second < 3_600; second += 1) {
			const at = NOW + second * 1_000;
			if (budget.allows(at)) {
				budget.spend(at);
				spent += 1;
			}
		}
		expect(spent).toBe(300);
	});
});

describe("the box's committed routing policy (plan 0026, 3.4)", () => {
	const root = fileURLToPath(new URL("../../..", import.meta.url));

	it("reads runnerRouting from the checkout, and it equals the code's defaults", () => {
		const read = readBoxRoutingPolicy(root);
		expect(read.source).toBe("committed");
		expect(read.policy).toEqual(DEFAULT_RUNNER_ROUTING);
	});

	it("a checkout without the block runs on the defaults; a bad block refuses to start", () => {
		const empty = mkdtempSync(join(tmpdir(), "hobo-routing-"));
		expect(readBoxRoutingPolicy(empty).source).toBe("default");
		const dir = mkdtempSync(join(tmpdir(), "hobo-routing-"));
		const hobo = join(dir, ".hobo");
		mkdirSync(hobo);
		writeFileSync(join(hobo, "ci.json"), JSON.stringify({}));
		expect(readBoxRoutingPolicy(dir).source).toBe("default");
		writeFileSync(
			join(hobo, "ci.json"),
			JSON.stringify({ runnerRouting: { pin: "sometimes" } }),
		);
		expect(() => readBoxRoutingPolicy(dir)).toThrow(/invalid runnerRouting/u);
	});

	it("names the routing variables still set, never their values", () => {
		expect(
			routingEnvironmentNamesSet({
				HOBO_CI_WORKER_SLOTS: "4",
				HOBO_CI_FLEET_VERDICT_MODE: "report",
				HOBO_CI_JOB_ADMISSION: "",
				HOBO_CI_NATS_URL: "nats://mesh:4222",
				MAIN_WORKSPACE_PARALLEL_CAP: "2",
			}),
		).toEqual([
			"HOBO_CI_FLEET_VERDICT_MODE",
			"HOBO_CI_WORKER_SLOTS",
			"MAIN_WORKSPACE_PARALLEL_CAP",
		]);
	});
});
