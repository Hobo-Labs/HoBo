/**
 * Publishes the fleet's route table where workflows can read it.
 *
 * On every dispatch pass the relay balances the account's connected offers
 * through the budget policy (`@hobo/ci` fleet) and gets, for each class of
 * job, the label a new job should ask for. That table goes into one
 * repository variable. GitHub evaluates `runs-on` before a job is queued, so
 * this is the only moment a label provider can be chosen for it.
 *
 * Publishing is never allowed to disturb admission: the table is computed
 * from state the pass already holds, a write happens only when the value
 * changes, changes are spaced out so the label cannot flap with every freed
 * slot, and every failure is logged and swallowed.
 */

import {
	type Account,
	FLEET_ROUTES_VARIABLE,
	type FleetRouteTable,
	fleetAccountExposure,
	fleetBudgetPolicy,
	fleetMembersFromAccount,
	fleetRoutesVariableValue,
	fleetRouteTable,
	type Lease,
} from "@hobo/ci";
import { z } from "zod";
import type { GithubTransport } from "./github.js";
import { RUNNER_LABEL, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

export type FleetRouteEvent =
	| "hobo_ci_fleet_routes_published"
	| "hobo_ci_fleet_routes_error";

export type FleetRouteLog = (
	event: FleetRouteEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type FleetRoutePublication = Readonly<{
	value: string;
	outcome: "unchanged" | "deferred" | "published" | "failed";
	table: FleetRouteTable;
}>;

export type FleetRoutePublishInput = Readonly<{
	installationId: number;
	repository: string;
	account: Account;
	leases: readonly Lease[];
	/** Authoritative current time, RFC 3339 UTC. */
	at: string;
}>;

const Repository = z.object({
	private: z.boolean(),
	owner: z.object({ type: z.string() }),
});

const FACTS_TTL_MS = 10 * 60_000;
/** A label that changes more often than this would chase individual jobs. */
const DEFAULT_MIN_INTERVAL_MS = 60_000;

export function createFleetRoutePublisher(options: {
	github: GithubTransport;
	variable?: string;
	minIntervalMs?: number;
	log?: FleetRouteLog;
}) {
	const variable = options.variable ?? FLEET_ROUTES_VARIABLE;
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
	const facts = new Map<
		string,
		{
			visibility: "public" | "private";
			ownerType: "organization" | "user";
			readAtMs: number;
		}
	>();
	const published = new Map<string, { value: string; atMs: number }>();

	async function repositoryFacts(
		installationId: number,
		repository: string,
		nowMs: number,
	) {
		const cached = facts.get(repository);
		if (cached && nowMs - cached.readAtMs < FACTS_TTL_MS) return cached;
		const response = await options.github.request(
			installationId,
			`/repos/${repository}`,
		);
		if (!response.ok)
			throw new Error(`repository lookup returned ${response.status}`);
		const parsed = Repository.parse(await response.json());
		const fresh = {
			visibility: parsed.private ? "private" : "public",
			ownerType: parsed.owner.type === "Organization" ? "organization" : "user",
			readAtMs: nowMs,
		} as const;
		facts.set(repository, fresh);
		return fresh;
	}

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

	/** Resolves to undefined, and logs, when the table could not be computed. */
	async function publish(
		input: FleetRoutePublishInput,
	): Promise<FleetRoutePublication | undefined> {
		const nowMs = Date.parse(input.at);
		try {
			const repository = await repositoryFacts(
				input.installationId,
				input.repository,
				nowMs,
			);
			const { account, leases } = input;
			const minutes = account.maxRuntimeMinutes + account.startupMinutes;
			const demand = {
				minutes,
				repository: {
					visibility: repository.visibility,
					ownerType: repository.ownerType,
				},
				needsDocker: true,
			};
			const table = fleetRouteTable({
				members: fleetMembersFromAccount(account, leases, {
					poolLabel: RUNNER_LABEL,
				}),
				classes: [
					{
						name: "pr",
						hoboLabel: RUNNER_LABEL,
						demand: { ...demand, forkPullRequest: false },
					},
					{
						name: "fork",
						hoboLabel: RUNNER_LABEL,
						demand: { ...demand, forkPullRequest: true },
					},
					{
						name: "trunk",
						hoboLabel: TRUNK_RUNNER_LABEL,
						demand: { ...demand, forkPullRequest: false },
					},
				],
				policy: fleetBudgetPolicy(account),
				...fleetAccountExposure(account, leases),
				now: input.at,
				// A relay never opens a paid account on its own.
				allowNewProviderAgreements: false,
				phase: "plan",
			});
			const value = fleetRoutesVariableValue(table);
			const last = published.get(input.repository);
			if (last?.value === value) return { value, outcome: "unchanged", table };
			if (last && nowMs - last.atMs < minIntervalMs)
				return { value, outcome: "deferred", table };
			const status = await write(input.installationId, input.repository, value);
			if (status !== 201 && status !== 204) {
				options.log?.("hobo_ci_fleet_routes_error", {
					repository: input.repository,
					variable,
					status,
				});
				// Do not retry a refused write on every pass.
				published.set(input.repository, {
					value: last?.value ?? "",
					atMs: nowMs,
				});
				return { value, outcome: "failed", table };
			}
			published.set(input.repository, { value, atMs: nowMs });
			options.log?.("hobo_ci_fleet_routes_published", {
				repository: input.repository,
				variable,
				value,
			});
			return { value, outcome: "published", table };
		} catch (error) {
			options.log?.("hobo_ci_fleet_routes_error", {
				repository: input.repository,
				variable,
				message: error instanceof Error ? error.message : "unknown failure",
			});
			return undefined;
		}
	}

	return { publish, variable };
}

export type FleetRoutePublisher = ReturnType<typeof createFleetRoutePublisher>;
