import {
	FLEET_CAPACITY_VARIABLE,
	type FleetCapacitySnapshot,
	fleetCapacityVariableValue,
} from "@hobo/ci";
import type { GithubTransport } from "./github.js";

export type FleetCapacityPublication = Readonly<{
	outcome: "unchanged" | "deferred" | "published" | "failed";
	snapshot: FleetCapacitySnapshot;
}>;

const DEFAULT_MIN_INTERVAL_MS = 15_000;

export function createFleetCapacityPublisher(options: {
	github: GithubTransport;
	variable?: string;
	minIntervalMs?: number;
	log?: (
		event: "hobo_ci_fleet_capacity_published" | "hobo_ci_fleet_capacity_error",
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	const variable = options.variable ?? FLEET_CAPACITY_VARIABLE;
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
	const published = new Map<string, { value: string; atMs: number }>();

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

	return {
		variable,
		async publish(input: {
			installationId: number;
			repository: string;
			snapshot: FleetCapacitySnapshot;
		}): Promise<FleetCapacityPublication> {
			const value = fleetCapacityVariableValue(input.snapshot);
			const last = published.get(input.repository);
			if (last?.value === value)
				return { outcome: "unchanged", snapshot: input.snapshot };
			const nowMs = input.snapshot.atMs;
			if (last && nowMs - last.atMs < minIntervalMs)
				return { outcome: "deferred", snapshot: input.snapshot };
			try {
				const status = await write(
					input.installationId,
					input.repository,
					value,
				);
				if (status !== 201 && status !== 204) {
					options.log?.("hobo_ci_fleet_capacity_error", {
						repository: input.repository,
						variable,
						status,
					});
					return { outcome: "failed", snapshot: input.snapshot };
				}
				published.set(input.repository, { value, atMs: nowMs });
				options.log?.("hobo_ci_fleet_capacity_published", {
					repository: input.repository,
					variable,
					admitHobo: input.snapshot.hobo.admit,
					admitTrunk: input.snapshot["hobo-trunk"].admit,
					availableMb: input.snapshot.hobo.availableMb ?? -1,
				});
				return { outcome: "published", snapshot: input.snapshot };
			} catch (error) {
				options.log?.("hobo_ci_fleet_capacity_error", {
					repository: input.repository,
					variable,
					message: error instanceof Error ? error.message : "unknown failure",
				});
				return { outcome: "failed", snapshot: input.snapshot };
			}
		},
	};
}

export type FleetCapacityPublisher = ReturnType<
	typeof createFleetCapacityPublisher
>;
