/**
 * The box relay's routing slip issuer (ADR-0181, decisions 1-5).
 *
 * The relay decides routing (R1). Per connected repository it writes its
 * current answer, the routing slip (`../routing-slip.ts`), as the message of
 * a parentless commit at `refs/hobo/routing-slip`; the route job reads it
 * with its own token. This module holds the three parts of that:
 *
 * - `decideRoutingSlipClasses`: what the slip says for `pr`, `fork` and
 *   `trunk`, from what only the relay holds (3.3). Pure.
 * - `writeRoutingSlipCommit`: the Git Data API calls. A one-file tree made
 *   once and reused, `POST /git/commits` with no parent, then
 *   `PATCH /git/refs/hobo/routing-slip` with `force: true`, or
 *   `POST /git/refs` the first time.
 * - `createRoutingSlipIssuer`: when to write. On a change and as a
 *   heartbeat every 3 minutes, never more than 20 writes a minute or 300 an
 *   hour, 10 minutes of quiet after a 403 or 429, and only on the mesh
 *   leader (a box without a mesh is its own leader).
 *
 * A slip names no slot count and no memory figure; `reason` is a code.
 * Anything the issuer cannot do it logs and leaves: with no fresh slip the
 * route job falls back to the queue rule, as it did before slips (R3).
 */

import { z } from "zod";
import type { GithubTransport } from "../github.js";
import {
	ROUTING_SLIP_CLASSES,
	ROUTING_SLIP_HEARTBEAT_MS,
	ROUTING_SLIP_REF,
	type RoutingSlipClassName,
	type RoutingSlipRoute,
	routingSlipJson,
} from "../routing-slip.js";
import type { RunnerRouting } from "../runner-routing.js";
import type { FleetRunnersView } from "./fleet-verdict-evaluator.js";

/** Hard caps on slip writes, whatever the decision does (ADR-0181, decisions 1-2). */
export const ROUTING_SLIP_WRITES_PER_MINUTE = 20;
export const ROUTING_SLIP_WRITES_PER_HOUR = 300;
/** A 403 or 429 is not a blip: no write for this long. */
export const ROUTING_SLIP_REFUSED_BACKOFF_MS = 10 * 60_000;
/** The issuer samples the box this often. */
export const ROUTING_SLIP_SAMPLE_MS = 10_000;
/** The slip's one file; the slip itself is the commit message. */
// public-contract: the one file of the tree under refs/hobo/routing-slip (ADR-0181).
export const ROUTING_SLIP_TREE_PATH = "README.md";
// public-contract: that file's text, the same on every box so the tree is reused.
export const ROUTING_SLIP_TREE_CONTENT =
	"This ref holds HoBo's routing slip (ADR-0181). The slip is the commit message.\n";

/** One route per class of `ROUTING_SLIP_CLASSES`. */
export type RoutingSlipClasses = Readonly<{
	pr: RoutingSlipRoute;
	fork: RoutingSlipRoute;
	trunk: RoutingSlipRoute;
}>;

export type RoutingSlipDecisionInput = Readonly<{
	policy: Pick<RunnerRouting, "pin" | "labels" | "localRunner">;
	/** Labels at least one live node (this box or a mesh peer) serves. */
	served: ReadonlySet<string>;
	/** Labels the held evaluation refuses: nothing can take a job (no-capacity). */
	refused: ReadonlySet<string>;
	/** Labels with work assigned and nothing started for the stall limit. */
	stalled: ReadonlySet<string>;
	/** Labels whose every live healthy slot is taken: busy, never refused (R4). */
	full: ReadonlySet<string>;
}>;

/**
 * What the slip says per class (ADR-0181, decision 5):
 *
 * 1. A committed pin goes into every class (`pinned`).
 * 2. The fleet is refused when no live node serves the class's label
 *    (`no-node`), when work assigned to it has started nothing for the stall
 *    limit (`stalled`), or when the held evaluation refuses it
 *    (`no-capacity`).
 * 3. Refused, a class goes to the committed local box when one is enrolled,
 *    else GitHub-hosted. A fork never goes to the local box and never asks
 *    for the trunk label.
 * 4. Otherwise the fleet label: `fleet-open`, or `fleet-busy` when every slot
 *    is taken. Busy is never refusal (R4).
 */
export function decideRoutingSlipClasses(
	input: RoutingSlipDecisionInput,
): RoutingSlipClasses {
	const { policy } = input;
	const route = (name: RoutingSlipClassName): RoutingSlipRoute => {
		const label = name === "trunk" ? policy.labels.trunk : policy.labels.fleet;
		if (policy.pin !== "auto") {
			const pinned =
				policy.pin === "fleet"
					? label
					: policy.pin === "local" && name === "fork"
						? policy.labels.github
						: policy.labels[policy.pin];
			const tier =
				policy.pin === "local" && name === "fork" ? "github" : policy.pin;
			return { runner: pinned, tier, reason: "pinned" };
		}
		const refusedFor = !input.served.has(label)
			? "no-node"
			: input.stalled.has(label)
				? "stalled"
				: input.refused.has(label)
					? "no-capacity"
					: undefined;
		if (refusedFor) {
			const local = policy.localRunner && name !== "fork";
			return {
				runner: local ? policy.labels.local : policy.labels.github,
				tier: local ? "local" : "github",
				reason: refusedFor,
			};
		}
		return {
			runner: label,
			tier: "fleet",
			reason: input.full.has(label) ? "fleet-busy" : "fleet-open",
		};
	};
	return {
		pr: route("pr"),
		fork: route("fork"),
		trunk: route("trunk"),
	};
}

/** A lease as the stall watch needs it. */
export type StallWatchLease = Readonly<{
	id: string;
	label: string;
	/** Assigned to this box and nothing started yet. */
	waiting: boolean;
	/** Its runner has started the job. */
	started: boolean;
	assignedAtMs: number;
}>;

/**
 * `stalled` (ADR-0181, decision 5): work has been assigned to a label and nothing
 * on it has started for `stallMs`. The clock for "nothing started" starts
 * when the watch does, so a restart never reads as a stall.
 */
export function createRoutingStallWatch(options: {
	stallMs: number;
	startedAtMs: number;
}) {
	const seenStarted = new Set<string>();
	const lastStartMs = new Map<string, number>();
	return {
		observe(nowMs: number, leases: readonly StallWatchLease[]): Set<string> {
			for (const lease of leases)
				if (lease.started && !seenStarted.has(lease.id)) {
					seenStarted.add(lease.id);
					lastStartMs.set(lease.label, nowMs);
				}
			const live = new Set(leases.map((lease) => lease.id));
			for (const id of seenStarted) if (!live.has(id)) seenStarted.delete(id);
			const stalled = new Set<string>();
			for (const lease of leases) {
				if (!lease.waiting) continue;
				const since = lastStartMs.get(lease.label) ?? options.startedAtMs;
				if (
					nowMs - lease.assignedAtMs >= options.stallMs &&
					nowMs - since >= options.stallMs
				)
					stalled.add(lease.label);
			}
			return stalled;
		},
	};
}

/** Sliding-window caps: at most `perMinute` and `perHour` writes. */
export function createRoutingSlipBudget(
	options: {
		perMinute?: number | undefined;
		perHour?: number | undefined;
	} = {},
) {
	const perMinute = options.perMinute ?? ROUTING_SLIP_WRITES_PER_MINUTE;
	const perHour = options.perHour ?? ROUTING_SLIP_WRITES_PER_HOUR;
	const spent: number[] = [];
	const prune = (nowMs: number) => {
		while (spent.length > 0 && nowMs - (spent[0] ?? nowMs) >= 3_600_000)
			spent.shift();
	};
	return {
		allows(nowMs: number): boolean {
			prune(nowMs);
			const lastMinute = spent.filter((at) => nowMs - at < 60_000).length;
			return lastMinute < perMinute && spent.length < perHour;
		},
		spend(nowMs: number): void {
			spent.push(nowMs);
		},
	};
}

export type RoutingSlipWriteResult =
	| Readonly<{ ok: true; commitSha: string; treeSha: string }>
	| Readonly<{ ok: false; status: number; step: string }>;

/** What the Git Data API answers a create with: the new object's id. */
const CreatedObject = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/u) });

async function shaOf(response: Response): Promise<string | undefined> {
	try {
		const parsed = CreatedObject.safeParse(await response.json());
		return parsed.success ? parsed.data.sha : undefined;
	} catch {
		return undefined;
	}
}

/** The four request bodies the slip writer sends. */
type GitDataBody =
	| Readonly<{
			tree: readonly Readonly<{
				path: string;
				mode: "100644";
				type: "blob";
				content: string;
			}>[];
	  }>
	| Readonly<{ message: string; tree: string; parents: readonly string[] }>
	| Readonly<{ sha: string; force: true }>
	| Readonly<{ ref: string; sha: string }>;

/** A runner as GitHub's repository runner list reports it. */
const RunnerList = z.object({
	runners: z.array(
		z.object({
			name: z.string(),
			status: z.string(),
			busy: z.boolean(),
			labels: z.array(z.object({ name: z.string() })),
		}),
	),
});

/**
 * GitHub's runner list for a repository (`GET /actions/runners`, which the
 * App's `administration` permission allows), for counting external pools
 * (ADR-0181, decision 5). Undefined when it cannot be read: unknown (R3).
 */
export async function readRepositoryRunners(
	github: GithubTransport,
	target: Readonly<{ installationId: number; repository: string }>,
	nowMs: number,
): Promise<FleetRunnersView | undefined> {
	try {
		const response = await github.request(
			target.installationId,
			`/repos/${target.repository}/actions/runners?per_page=100`,
		);
		if (!response.ok) return undefined;
		const parsed = RunnerList.safeParse(await response.json());
		if (!parsed.success) return undefined;
		return {
			readAtMs: nowMs,
			runners: parsed.data.runners.map((runner) => ({
				name: runner.name,
				online: runner.status === "online",
				busy: runner.busy,
				labels: runner.labels.map((label) => label.name),
			})),
		};
	} catch {
		return undefined;
	}
}

/**
 * Writes `message` as the slip: the commit at `ROUTING_SLIP_REF`. Reuses
 * `treeSha` when given; otherwise makes the one-file tree. A transport that
 * throws is status 0.
 */
export async function writeRoutingSlipCommit(
	github: GithubTransport,
	target: Readonly<{
		installationId: number;
		repository: string;
		message: string;
		treeSha?: string | undefined;
	}>,
): Promise<RoutingSlipWriteResult> {
	const git = `/repos/${target.repository}/git`;
	const send = async (
		path: string,
		method: "POST" | "PATCH",
		body: GitDataBody,
	) => {
		try {
			return await github.request(
				target.installationId,
				path,
				method,
				JSON.stringify(body),
			);
		} catch {
			return new Response(null, { status: 599 });
		}
	};
	let treeSha = target.treeSha;
	if (!treeSha) {
		const tree = await send(`${git}/trees`, "POST", {
			tree: [
				{
					path: ROUTING_SLIP_TREE_PATH,
					mode: "100644",
					type: "blob",
					content: ROUTING_SLIP_TREE_CONTENT,
				},
			],
		});
		treeSha = tree.status === 201 ? await shaOf(tree) : undefined;
		if (!treeSha) return { ok: false, status: tree.status, step: "tree" };
	}
	const commit = await send(`${git}/commits`, "POST", {
		message: target.message,
		tree: treeSha,
		parents: [],
	});
	const commitSha = commit.status === 201 ? await shaOf(commit) : undefined;
	if (!commitSha) return { ok: false, status: commit.status, step: "commit" };
	const short = ROUTING_SLIP_REF.replace(/^refs\//u, "");
	const moved = await send(`${git}/refs/${short}`, "PATCH", {
		sha: commitSha,
		force: true,
	});
	if (moved.status === 200) return { ok: true, commitSha, treeSha };
	// GitHub answers 422 ("Reference does not exist") for a missing ref.
	if (moved.status !== 422 && moved.status !== 404)
		return { ok: false, status: moved.status, step: "ref" };
	const created = await send(`${git}/refs`, "POST", {
		ref: ROUTING_SLIP_REF,
		sha: commitSha,
	});
	if (created.status === 201) return { ok: true, commitSha, treeSha };
	return { ok: false, status: created.status, step: "ref" };
}

export type RoutingSlipIssuerEvent =
	| "hobo_ci_slip_written"
	| "hobo_ci_slip_write_refused"
	| "hobo_ci_slip_write_failed"
	| "hobo_ci_slip_write_deferred"
	| "hobo_ci_slip_leader"
	| "hobo_ci_slip_decision_failed";

export type RoutingSlipIssuerLog = (
	event: RoutingSlipIssuerEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type RoutingSlipTarget = Readonly<{
	repository: string;
	installationId: number;
}>;

export type RoutingSlipIssuerOptions = Readonly<{
	github: GithubTransport;
	/** The committed labels; every runner a slip names is one of them. */
	labels: ReadonlySet<string>;
	/** This relay: the mesh node id (or the box's own) and its commit. */
	relay: Readonly<{ nodeId: string; commit: string }>;
	/** Whether this box is the mesh leader right now. */
	leader: () => Promise<boolean>;
	/** The connected repositories, one slip each. */
	targets: () => Promise<readonly RoutingSlipTarget[]>;
	/** The decision for one repository now. */
	decide: (repository: string) => Promise<RoutingSlipClasses>;
	now?: (() => number) | undefined;
	log?: RoutingSlipIssuerLog | undefined;
	heartbeatMs?: number | undefined;
	perMinute?: number | undefined;
	perHour?: number | undefined;
	refusedBackoffMs?: number | undefined;
	/** Whether to write at all; a draining box stops writing. */
	enabled?: (() => boolean) | undefined;
	/** Called once, the first time this process finds it is the leader. */
	onFirstLead?: (() => Promise<void> | void) | undefined;
}>;

const classesKey = (classes: RoutingSlipClasses) =>
	ROUTING_SLIP_CLASSES.map((name) => {
		const route = classes[name];
		return `${name}=${route.runner}/${route.tier}/${route.reason}`;
	}).join(";");

/**
 * Writes each connected repository's slip when its decision changes and as a
 * heartbeat, within the budget, and only while this box leads the mesh.
 */
export function createRoutingSlipIssuer(options: RoutingSlipIssuerOptions) {
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => undefined);
	const heartbeatMs = options.heartbeatMs ?? ROUTING_SLIP_HEARTBEAT_MS;
	const backoffMs = options.refusedBackoffMs ?? ROUTING_SLIP_REFUSED_BACKOFF_MS;
	const budget = createRoutingSlipBudget({
		perMinute: options.perMinute,
		perHour: options.perHour,
	});
	const written = new Map<string, { key: string; atMs: number }>();
	const trees = new Map<string, string>();
	const deferredLogged = new Set<string>();
	let refusedUntilMs = 0;
	let leading: boolean | undefined;
	let firstLead = true;
	let inFlight: Promise<void> | undefined;
	let writes = 0;

	async function issue(target: RoutingSlipTarget, nowMs: number) {
		let classes: RoutingSlipClasses;
		try {
			classes = await options.decide(target.repository);
		} catch (error) {
			log("hobo_ci_slip_decision_failed", {
				repository: target.repository,
				message: error instanceof Error ? error.message : "unknown",
			});
			return;
		}
		const key = classesKey(classes);
		const last = written.get(target.repository);
		const changed = last?.key !== key;
		if (!changed && last && nowMs - last.atMs < heartbeatMs) return;
		if (nowMs < refusedUntilMs) return;
		if (!budget.allows(nowMs)) {
			if (!deferredLogged.has(target.repository)) {
				deferredLogged.add(target.repository);
				log("hobo_ci_slip_write_deferred", {
					repository: target.repository,
					reason: "budget",
				});
			}
			return;
		}
		deferredLogged.delete(target.repository);
		const message = routingSlipJson(
			{
				repository: target.repository,
				issuedAtMs: nowMs,
				classes,
				relay: options.relay,
			},
			options.labels,
		);
		budget.spend(nowMs);
		writes += 1;
		const result = await writeRoutingSlipCommit(options.github, {
			installationId: target.installationId,
			repository: target.repository,
			message,
			treeSha: trees.get(target.repository),
		});
		if (result.ok) {
			trees.set(target.repository, result.treeSha);
			written.set(target.repository, { key, atMs: nowMs });
			if (changed)
				log("hobo_ci_slip_written", {
					repository: target.repository,
					commit: result.commitSha,
					relayCommit: options.relay.commit,
					classes: key,
				});
			return;
		}
		if (result.status === 403 || result.status === 429) {
			refusedUntilMs = nowMs + backoffMs;
			log("hobo_ci_slip_write_refused", {
				repository: target.repository,
				status: result.status,
				step: result.step,
				backoffMs,
			});
			return;
		}
		log("hobo_ci_slip_write_failed", {
			repository: target.repository,
			status: result.status,
			step: result.step,
		});
	}

	async function tickOnce(): Promise<void> {
		if (options.enabled && !options.enabled()) return;
		let leads: boolean;
		try {
			leads = await options.leader();
		} catch {
			// A mesh that cannot be read names no leader: no slip (R3).
			leads = false;
		}
		if (leads !== leading) {
			leading = leads;
			log("hobo_ci_slip_leader", {
				leader: leads,
				nodeId: options.relay.nodeId,
			});
		}
		if (!leads) return;
		if (firstLead) {
			firstLead = false;
			try {
				await options.onFirstLead?.();
			} catch {
				/* Its own logging says what failed; slips go on. */
			}
		}
		const targets = await options.targets();
		for (const target of targets) {
			if (now() < refusedUntilMs) return;
			await issue(target, now());
		}
	}

	/** One pass, unless the last one is still running. */
	function tick(): Promise<void> {
		if (inFlight) return inFlight;
		const current = tickOnce()
			.catch(() => undefined)
			.finally(() => {
				inFlight = undefined;
			});
		inFlight = current;
		return current;
	}

	return {
		tick,
		/** Slip writes attempted by this process. */
		writes: () => writes,
	};
}

export type RoutingSlipIssuer = ReturnType<typeof createRoutingSlipIssuer>;
