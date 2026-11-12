/**
 * Publishes what the mesh can take, per fleet label, where the routing job
 * can read it without asking anyone: one repository variable.
 *
 * `scripts/ci/route-runner.mts` runs first in every workflow and chooses the
 * fleet, a local box or GitHub-hosted. It reads GitHub's queue, which says
 * what happened to jobs already queued. This snapshot says what the nodes
 * themselves report now: a fleet label nobody serves, or with no free slot,
 * is not worth queueing behind. It is an extra signal and never the only
 * one: the snapshot carries when it was published, and the routing job
 * ignores one older than five minutes, so a mesh that stops publishing
 * changes nothing.
 *
 * What it lists:
 *
 * - Exactly the fleet labels the publishing worker serves, each with its
 *   live healthy nodes, how many of them it trusts, and their free slots
 *   (`MeshFleetState` in `data-models/mesh.proto`). Never `hobo-local-host`:
 *   the board is shared by every repository, and one developer's busy
 *   machine says nothing about another repository's. A label the snapshot
 *   does not list is unknown to the routing job, not refused.
 * - Nodes the reader rejects (a failed signature, an overlong expiry) are not
 *   counted. Trust does not filter the counts, even with `requireTrusted`:
 *   that setting decides whom a worker defers to when ranking, not whether
 *   an unlisted worker picks up a job GitHub hands it.
 *
 * Who writes it: one worker per mesh, the live, healthy worker with the
 * lowest id among those serving a fleet label (with `requireTrusted`, among
 * trusted ones), as the monitor elects its reporter. Every worker with the
 * flag runs this; the others stay quiet.
 *
 * How often: GitHub's variable writes are rate limited, so a write happens
 * only when what the routing job reads changes (per label, whether there is
 * a node and whether there is a free slot), at most every 30 seconds, and
 * otherwise every two minutes so the snapshot never goes stale while the
 * mesh is up. A refused write backs off; every failure is logged and
 * swallowed.
 */
import {
	type MeshBoard,
	type MeshLabelState,
	type MeshNode,
	meshAdvertRejected,
	meshLabelStates,
} from "@hobo/ci/mesh";
import { writeRepositoryVariable } from "./fleet-routes.js";
import type { GithubTransport } from "./github.js";
import { meshFleetStateJson } from "./mesh-records.js";

// public-contract: the repository variable runner routing reads the mesh snapshot from.
export const FLEET_STATE_VARIABLE = "HOBO_CI_FLEET_STATE";

/** How old a snapshot may be before the routing job ignores it. */
export const FLEET_STATE_MAX_AGE_MS = 5 * 60_000;

export type FleetStateEvent =
	| "hobo_ci_fleet_state_published"
	| "hobo_ci_fleet_state_error";

/** A changed snapshot is written at most this often. */
const DEFAULT_MIN_INTERVAL_MS = 30_000;
/** An unchanged one is written again this often, so it never goes stale while the mesh is up. */
const DEFAULT_REFRESH_MS = 2 * 60_000;
/** A write the App is not allowed to make will not succeed a minute later. */
const REFUSED_WRITE_BACKOFF_MS = 10 * 60_000;

/** What the routing job reads of one label: `none` (no node), `full` (no free slot) or `open`. */
function standing(state: MeshLabelState): "none" | "full" | "open" {
	return state.nodes === 0 ? "none" : state.freeSlots === 0 ? "full" : "open";
}

export function createFleetStatePublisher(options: {
	github: GithubTransport;
	/** The board as this worker reads it, each node with its trust level. */
	board: Pick<MeshBoard, "nodes">;
	/** This worker, counted from its own state whatever the board says of it. */
	self: () => MeshNode;
	/** The fleet labels this worker serves: the only labels the snapshot lists. */
	labels: readonly string[];
	/** Whether the mesh ranks only trusted nodes: then only they are elected. */
	requireTrusted?: (() => boolean) | undefined;
	variable?: string;
	minIntervalMs?: number;
	refreshMs?: number;
	now?: () => number;
	log?: (
		event: FleetStateEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	const variable = options.variable ?? FLEET_STATE_VARIABLE;
	const now = options.now ?? Date.now;
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
	const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
	/** Per repository: what routing would read of the last write, and when. */
	const published = new Map<string, { content: string; atMs: number }>();
	const refusedUntil = new Map<string, number>();
	/** Whether this worker was the publisher at its last reading. */
	let elected = false;

	/**
	 * The snapshot as of now, and whether this worker is the one to write
	 * it; or nothing when the board cannot be read: a worker that cannot see
	 * the mesh says nothing about it, and the last snapshot ages out.
	 */
	async function snapshot(): Promise<
		| {
				value: string;
				/** What the routing job reads of it, for the change check and the log. */
				content: string;
				elected: boolean;
		  }
		| undefined
	> {
		let nodes: readonly MeshNode[];
		try {
			nodes = await options.board.nodes();
		} catch {
			return undefined;
		}
		const nowMs = now();
		// This worker's own state is current now, whatever expiry it carries.
		const own = options.self();
		const self: MeshNode = {
			...own,
			trust: "trusted",
			validUntilMs: Math.max(own.validUntilMs, nowMs + 1),
		};
		const all = [self, ...nodes.filter((node) => node.id !== self.id)];
		const states = meshLabelStates(all, nowMs, { labels: options.labels });
		const requireTrusted = options.requireTrusted?.() ?? false;
		const candidates = all.filter(
			(node) =>
				node.validUntilMs > nowMs &&
				node.healthy &&
				!meshAdvertRejected(node, nowMs) &&
				(!requireTrusted || node.trust === "trusted") &&
				node.labels.some((label) => options.labels.includes(label)),
		);
		const publisher = candidates.map((node) => node.id).sort()[0];
		return {
			value: meshFleetStateJson(states, nowMs),
			content: [...states]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([label, state]) => `${label}=${standing(state)}`)
				.join(","),
			elected: publisher === self.id,
		};
	}

	/**
	 * Writes the snapshot to each repository that is due one, when this
	 * worker is the elected publisher: what routing reads changed (and the
	 * last write is not too recent), or the last write is old enough to need
	 * refreshing. `now` skips the spacing, for the one write the publisher
	 * makes as it starts to drain; a worker that is draining is no longer a
	 * candidate, so that write is allowed when it was elected at its last
	 * reading. Resolves to how many were written.
	 */
	async function publish(
		targets: readonly Readonly<{
			installationId: number;
			repository: string;
		}>[],
		timing: { now?: boolean } = {},
	): Promise<number> {
		const nowMs = now();
		const due = targets.filter((target) => {
			if (nowMs < (refusedUntil.get(target.repository) ?? 0)) return false;
			const last = published.get(target.repository);
			return timing.now === true || !last || nowMs - last.atMs >= minIntervalMs;
		});
		if (due.length === 0) return 0;
		const current = await snapshot();
		if (!current) return 0;
		const mayWrite = current.elected || (timing.now === true && elected);
		elected = current.elected;
		if (!mayWrite) return 0;
		let written = 0;
		for (const target of due) {
			const last = published.get(target.repository);
			if (
				timing.now !== true &&
				last &&
				last.content === current.content &&
				nowMs - last.atMs < refreshMs
			)
				continue;
			try {
				const status = await writeRepositoryVariable(options.github, {
					...target,
					name: variable,
					value: current.value,
				});
				if (status !== 201 && status !== 204) {
					options.log?.("hobo_ci_fleet_state_error", {
						repository: target.repository,
						variable,
						status,
					});
					// A refusal is a permission the App lacks, not a blip: wait.
					refusedUntil.set(target.repository, nowMs + REFUSED_WRITE_BACKOFF_MS);
					continue;
				}
				published.set(target.repository, {
					content: current.content,
					atMs: nowMs,
				});
				written += 1;
				// What routing reads, not the whole value: one line per write.
				options.log?.("hobo_ci_fleet_state_published", {
					repository: target.repository,
					variable,
					labels: current.content,
				});
			} catch (error) {
				options.log?.("hobo_ci_fleet_state_error", {
					repository: target.repository,
					variable,
					message: error instanceof Error ? error.message : "unknown failure",
				});
			}
		}
		return written;
	}

	return { publish, snapshot, variable };
}

export type FleetStatePublisher = ReturnType<typeof createFleetStatePublisher>;
