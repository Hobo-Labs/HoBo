/**
 * Publishes live fleet slot headroom where workflows can cap shard matrices.
 */

import {
	FLEET_CAPACITY_VARIABLE,
	type FleetCapacityPublished,
	fleetCapacitySnapshot,
	fleetCapacityVariableValue,
} from "@hobo/ci";
import type { GithubTransport } from "./github.js";

export type FleetCapacityEvent =
	| "hobo_ci_fleet_capacity_published"
	| "hobo_ci_fleet_capacity_error";

export type FleetCapacityLog = (
	event: FleetCapacityEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type FleetCapacityPublishInput = Readonly<{
	installationId: number;
	repository: string;
	hoboFreeSlots: number;
	arcFreeSlots?: number;
	/** Authoritative current time, RFC 3339 UTC. */
	at: string;
}>;

const DEFAULT_MIN_INTERVAL_MS = 60_000;
const REFUSED_WRITE_BACKOFF_MS = 10 * 60_000;
const DEFAULT_MIN_COMPUTE_INTERVAL_MS = 15_000;

export function createFleetCapacityPublisher(options: {
	github: GithubTransport;
	variable?: string;
	minIntervalMs?: number;
	minComputeIntervalMs?: number;
	log?: FleetCapacityLog;
}) {
	const variable = options.variable ?? FLEET_CAPACITY_VARIABLE;
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
	const minComputeIntervalMs =
		options.minComputeIntervalMs ?? DEFAULT_MIN_COMPUTE_INTERVAL_MS;
	const published = new Map<string, { value: string; atMs: number }>();
	const attempted = new Map<string, number>();
	const refusedUntil = new Map<string, number>();

	async function write(
		installationId: number,
		repository: string,
		value: string,
	): Promise<number> {
		const body = JSON.stringify({ name: variable, value });
		const updated = await options.github.request(
			installationId,
			`/repos/${repository}/actions/variables/${variable}`,
			"PATCH",
			body,
		);
		if (updated.status !== 404) return updated.status;
		const created = await options.github.request(
			installationId,
			`/repos/${repository}/actions/variables`,
			"POST",
			body,
		);
		return created.status;
	}

	async function publish(
		input: FleetCapacityPublishInput,
	): Promise<"unchanged" | "deferred" | "published" | "failed" | undefined> {
		const nowMs = Date.parse(input.at);
		const lastAttemptMs = attempted.get(input.repository);
		if (
			(lastAttemptMs !== undefined &&
				nowMs - lastAttemptMs < minComputeIntervalMs) ||
			nowMs < (refusedUntil.get(input.repository) ?? 0)
		)
			return undefined;
		attempted.set(input.repository, nowMs);
		const snapshot: FleetCapacityPublished = fleetCapacitySnapshot(
			input.hoboFreeSlots,
			input.arcFreeSlots ?? 0,
			input.at,
		);
		const value = fleetCapacityVariableValue(snapshot);
		const last = published.get(input.repository);
		if (last?.value === value) return "unchanged";
		if (last && nowMs - last.atMs < minIntervalMs) return "deferred";
		try {
			const status = await write(input.installationId, input.repository, value);
			if (status !== 201 && status !== 204) {
				options.log?.("hobo_ci_fleet_capacity_error", {
					repository: input.repository,
					variable,
					status,
				});
				refusedUntil.set(input.repository, nowMs + REFUSED_WRITE_BACKOFF_MS);
				return "failed";
			}
			published.set(input.repository, { value, atMs: nowMs });
			options.log?.("hobo_ci_fleet_capacity_published", {
				repository: input.repository,
				variable,
				admittedParallel: snapshot.admittedParallel,
			});
			return "published";
		} catch (error) {
			options.log?.("hobo_ci_fleet_capacity_error", {
				repository: input.repository,
				variable,
				message: error instanceof Error ? error.message : "unknown",
			});
			return "failed";
		}
	}

	return { publish, variable };
}

export type FleetCapacityPublisher = ReturnType<
	typeof createFleetCapacityPublisher
>;
