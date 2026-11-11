/**
 * Publishes what the mesh can take, per runner label, where the routing job
 * can read it without asking anyone: one repository variable.
 *
 * `scripts/ci/route-runner.mts` runs first in every workflow and chooses the
 * fleet, a local box or GitHub-hosted. It reads GitHub's queue, which says
 * what happened to jobs already queued. This snapshot says what the nodes
 * themselves report now: a label nobody serves, or with no free slot, is not
 * worth queueing behind. It is an extra signal and never the only one: the
 * snapshot carries when it was published, and the routing job ignores one
 * older than five minutes, so a worker that stops publishing changes nothing.
 *
 * The value is small and holds no node ids, keys or addresses: per label,
 * how many nodes this worker ranks, how many of them it trusts, and their
 * free slots (`MeshFleetState` in `data-models/mesh.proto`).
 *
 * Like the route table, publishing never disturbs admission: writes are
 * spaced out, a refused write backs off, and every failure is logged and
 * swallowed.
 */
import { type MeshBoard, type MeshNode, meshLabelStates } from "@hobo/ci/mesh";
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
/** An unchanged one is written again this often, so it never goes stale while the worker is up. */
const DEFAULT_REFRESH_MS = 2 * 60_000;
/** A write the App is not allowed to make will not succeed a minute later. */
const REFUSED_WRITE_BACKOFF_MS = 10 * 60_000;

export function createFleetStatePublisher(options: {
	github: GithubTransport;
	/** The board as this worker reads it, each node with its trust level. */
	board: Pick<MeshBoard, "nodes">;
	/** This worker, counted from its own state whatever the board says of it. */
	self: () => MeshNode;
	/** The labels always listed, with zeros when no node serves them. */
	labels: readonly string[];
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
	/** Per repository: what was last written, without its timestamp, and when. */
	const published = new Map<string, { content: string; atMs: number }>();
	const refusedUntil = new Map<string, number>();

	/**
	 * The snapshot as of now, or nothing when the board cannot be read: a
	 * worker that cannot see the mesh says nothing about it, and the last
	 * snapshot ages out.
	 */
	async function snapshot(): Promise<
		{ value: string; content: string } | undefined
	> {
		let nodes: readonly MeshNode[];
		try {
			nodes = await options.board.nodes();
		} catch {
			return undefined;
		}
		const nowMs = now();
		const self: MeshNode = { ...options.self(), trust: "trusted" };
		const states = meshLabelStates(
			[self, ...nodes.filter((node) => node.id !== self.id)],
			nowMs,
			{
				labels: options.labels,
				requireTrusted: options.requireTrusted?.() ?? false,
			},
		);
		return {
			value: meshFleetStateJson(states, nowMs),
			// What the snapshot says, apart from when it was published.
			content: JSON.stringify(
				[...states].sort(([a], [b]) => a.localeCompare(b)),
			),
		};
	}

	/**
	 * Writes the snapshot to each repository that is due one: its content
	 * changed (and the last write is not too recent), or the last write is
	 * old enough to need refreshing. `now` skips the spacing, for the one
	 * write a worker makes as it starts to drain. Resolves to how many were
	 * written.
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
		let written = 0;
		for (const target of due) {
			const last = published.get(target.repository);
			if (
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
				options.log?.("hobo_ci_fleet_state_published", {
					repository: target.repository,
					variable,
					value: current.value,
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
