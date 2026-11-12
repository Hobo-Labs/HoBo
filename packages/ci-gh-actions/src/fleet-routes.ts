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
	DEFAULT_GITHUB_MACHINE_TYPE,
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
	/** Read only when a table is actually computed. */
	leases: () => Promise<readonly Lease[]>;
	/** The connection admits isolated runners only. */
	isolatedOnly: boolean;
	/** Authoritative current time, RFC 3339 UTC. */
	at: string;
}>;

const Repository = z.object({
	private: z.boolean(),
	owner: z.object({ type: z.string() }),
});

const FleetRoutesVariableBody = z.object({ value: z.string().optional() });

const StoredFleetRoutes = z.record(z.string().min(1), z.string().min(1));

const FACTS_TTL_MS = 10 * 60_000;
const NONE: ReadonlySet<string> = new Set();
/** A label that changes more often than this would chase individual jobs. */
const DEFAULT_MIN_INTERVAL_MS = 60_000;
/** A write the App is not allowed to make will not succeed a minute later. */
const REFUSED_WRITE_BACKOFF_MS = 10 * 60_000;
/** The dispatch pass runs every couple of seconds; a table need not. */
const DEFAULT_MIN_COMPUTE_INTERVAL_MS = 15_000;

/**
 * Sets one repository variable, creating it when it does not exist yet.
 * Resolves to GitHub's status: 204 for an update, 201 for a creation.
 */
export async function writeRepositoryVariable(
	github: GithubTransport,
	target: Readonly<{
		installationId: number;
		repository: string;
		name: string;
		value: string;
	}>,
): Promise<number> {
	const body = JSON.stringify({ name: target.name, value: target.value });
	const updated = await github.request(
		target.installationId,
		`/repos/${target.repository}/actions/variables/${target.name}`,
		"PATCH",
		body,
	);
	if (updated.status !== 404) return updated.status;
	const created = await github.request(
		target.installationId,
		`/repos/${target.repository}/actions/variables`,
		"POST",
		body,
	);
	return created.status;
}

export function createFleetRoutePublisher(options: {
	github: GithubTransport;
	variable?: string;
	minIntervalMs?: number;
	/** Minimum gap between computations for one repository, failed or not. */
	minComputeIntervalMs?: number;
	/**
	 * Offers the fleet should not send new work to right now, for example the
	 * box's own while its host is critically short of a resource.
	 */
	unhealthyOfferIds?: (account: Account) => ReadonlySet<string>;
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
	const minComputeIntervalMs =
		options.minComputeIntervalMs ?? DEFAULT_MIN_COMPUTE_INTERVAL_MS;
	const attempted = new Map<string, number>();
	const refusedUntil = new Map<string, number>();

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

	const write = (installationId: number, repository: string, value: string) =>
		writeRepositoryVariable(options.github, {
			installationId,
			repository,
			name: variable,
			value,
		});

	/**
	 * Resolves to undefined when the repository was computed too recently, or,
	 * with a log line, when the table could not be computed.
	 */
	async function publish(
		input: FleetRoutePublishInput,
	): Promise<FleetRoutePublication | undefined> {
		const nowMs = Date.parse(input.at);
		const lastAttemptMs = attempted.get(input.repository);
		if (
			(lastAttemptMs !== undefined &&
				nowMs - lastAttemptMs < minComputeIntervalMs) ||
			nowMs < (refusedUntil.get(input.repository) ?? 0)
		)
			return undefined;
		// Recorded first, so a failing lookup backs off like a successful one.
		attempted.set(input.repository, nowMs);
		try {
			const repository = await repositoryFacts(
				input.installationId,
				input.repository,
				nowMs,
			);
			const { account } = input;
			const leases = await input.leases();
			// Admission requires isolation for every public-repository job and
			// every pull request, whatever the connection says.
			const isolated = input.isolatedOnly || repository.visibility === "public";
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
					extraPoolLabels: [TRUNK_RUNNER_LABEL],
					unhealthyOfferIds: options.unhealthyOfferIds?.(account) ?? NONE,
				}),
				classes: [
					{
						name: "pr",
						hoboLabel: RUNNER_LABEL,
						demand: {
							...demand,
							forkPullRequest: false,
							isolationRequired: true,
						},
					},
					{
						name: "fork",
						hoboLabel: RUNNER_LABEL,
						demand: {
							...demand,
							forkPullRequest: true,
							isolationRequired: true,
						},
					},
					{
						name: "trunk",
						hoboLabel: TRUNK_RUNNER_LABEL,
						demand: {
							...demand,
							forkPullRequest: false,
							isolationRequired: isolated,
						},
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
				// A refusal is a permission the App lacks, not a blip: wait.
				refusedUntil.set(input.repository, nowMs + REFUSED_WRITE_BACKOFF_MS);
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

	/**
	 * Puts every class back on its hobo label. For a publisher that is going
	 * away for good: the variable outlives the process, and a route nobody is
	 * keeping current must not keep sending work to an overflow provider.
	 */
	async function reset(target: {
		installationId: number;
		repository: string;
	}): Promise<boolean> {
		const value = JSON.stringify({
			fork: RUNNER_LABEL,
			pr: RUNNER_LABEL,
			trunk: TRUNK_RUNNER_LABEL,
		});
		try {
			const status = await write(
				target.installationId,
				target.repository,
				value,
			);
			const ok = status === 201 || status === 204;
			options.log?.(
				ok ? "hobo_ci_fleet_routes_published" : "hobo_ci_fleet_routes_error",
				{ repository: target.repository, variable, value, status, reset: true },
			);
			if (ok) published.set(target.repository, { value, atMs: 0 });
			return ok;
		} catch (error) {
			options.log?.("hobo_ci_fleet_routes_error", {
				repository: target.repository,
				variable,
				reset: true,
				message: error instanceof Error ? error.message : "unknown failure",
			});
			return false;
		}
	}

	/**
	 * Forces trunk onto GitHub-hosted before a headroom overflow rerun so new
	 * jobs read `ubuntu-24.04` instead of waiting on hobo-trunk again.
	 */
	async function publishTrunkHostedOverflow(target: {
		installationId: number;
		repository: string;
	}): Promise<boolean> {
		const defaults = {
			fork: RUNNER_LABEL,
			pr: RUNNER_LABEL,
			trunk: TRUNK_RUNNER_LABEL,
		} as const;
		let routes = { ...defaults };
		try {
			const response = await options.github.request(
				target.installationId,
				`/repos/${target.repository}/actions/variables/${variable}`,
			);
			if (response.ok) {
				const body = FleetRoutesVariableBody.parse(await response.json());
				if (body.value) {
					const merged = StoredFleetRoutes.safeParse(JSON.parse(body.value));
					if (merged.success) routes = { ...defaults, ...merged.data };
				}
			}
		} catch (error) {
			options.log?.("hobo_ci_fleet_routes_error", {
				repository: target.repository,
				variable,
				overflow: true,
				message: error instanceof Error ? error.message : "unknown failure",
			});
		}
		const overflowRoutes = {
			...routes,
			trunk: DEFAULT_GITHUB_MACHINE_TYPE,
		};
		const value = JSON.stringify(
			Object.fromEntries(
				Object.entries(overflowRoutes).sort(([left], [right]) =>
					left < right ? -1 : left > right ? 1 : 0,
				),
			),
		);
		try {
			const status = await write(
				target.installationId,
				target.repository,
				value,
			);
			const ok = status === 201 || status === 204;
			options.log?.(
				ok ? "hobo_ci_fleet_routes_published" : "hobo_ci_fleet_routes_error",
				{
					repository: target.repository,
					variable,
					value,
					status,
					overflow: true,
				},
			);
			if (ok) published.set(target.repository, { value, atMs: Date.now() });
			return ok;
		} catch (error) {
			options.log?.("hobo_ci_fleet_routes_error", {
				repository: target.repository,
				variable,
				overflow: true,
				message: error instanceof Error ? error.message : "unknown failure",
			});
			return false;
		}
	}

	return { publish, reset, publishTrunkHostedOverflow, variable };
}

export type FleetRoutePublisher = ReturnType<typeof createFleetRoutePublisher>;
