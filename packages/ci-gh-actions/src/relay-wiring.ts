/**
 * The relay's built pieces, turned on (ADR-0183). Each is behind its own
 * flag and every flag is off unless set:
 *
 * - **Relay mode's rescue and sweep** run after each admission poll, only
 *   when the node's `relayJobs.answer` is on. A pass that is still running
 *   (an answer can wait four minutes for GitHub's offer) makes the next poll
 *   skip its own, so passes never overlap and never hold up admission.
 * - **Automatic retry** reads every `workflow_job` and `workflow_run`
 *   delivery the relay accepted into its run history, and on a failed
 *   `workflow_run` asks `autoRetryRun`, with the SQLite retry ledger, whether
 *   to re-run the relay job.
 * - **The dashboard** page and its script, read-only, and the read API it
 *   reads (`GET /v1/accounts/self/...`). The page holds no account data; the
 *   read API checks the account token and its read scope on every request,
 *   with the relay's own authenticator. Run history is kept for it from the
 *   accepted webhooks.
 *
 * The three share one SQLite file (`database`), separate from the relay's
 * own partition and written only by this process (ADR-0135). It is opened
 * only when a flag is on, so with every flag off the relay opens no file,
 * makes no GitHub request and serves no new path.
 */
import { DatabaseSync } from "node:sqlite";
import {
	DEFAULT_RELAY_JOBS,
	DEFAULT_RUNNER_ORDER,
	type RelayJobsConfig,
	type RouteJournal,
	type RunnerOrderLookup,
	type RunnerOrderSource,
} from "@hobo/ci";
import { SqliteInsightStore } from "@hobo/ci/insights/history-sqlite";
import { SqliteRouteJournal } from "@hobo/ci/runner-order/journal-sqlite";
import { SqliteMachineRegistry } from "@hobo/ci/runner-order/machine-registry-sqlite";
import { z } from "zod";
import {
	type AutoRetryOutcome,
	autoRetryRun,
	githubCheckRunAnnotations,
	githubRerunJob,
	machineEventDisconnects,
	RetryRouteFacts,
	SqliteRetryLedger,
} from "./auto-retry.js";
import {
	GITHUB_INCLUDED_COMPUTE_OBSERVED_AT,
	GITHUB_INCLUDED_COMPUTE_SOURCE,
	GITHUB_LINUX_USD_PER_MINUTE,
} from "./billing-usage.js";
import type { ControlAuthenticator } from "./control-auth.js";
import type { GithubTransport } from "./github.js";
import type { VerifiedWebhook } from "./http-handler.js";
import { InsightIngest } from "./insight-ingest.js";
import { createReadApi } from "./read-api.js";
import {
	createRelayAnswerer,
	GithubCiFile,
	GithubCiOrderSource,
	type RelayAnswerer,
	type RelayConnection,
	type RelayRescueSummary,
	type RelaySweepSummary,
	StoreRouteFacts,
} from "./relay-answer/index.js";
import { GithubRunnerServiceClient } from "./runner-protocol/client.js";
import { parseJitConfig } from "./runner-protocol/jit-config.js";
import type {
	ParsedJitConfig,
	RunnerServiceClient,
} from "./runner-protocol/port.js";

export type RelayWiringFlags = Readonly<{
	/** The node's `relayJobs`; rescue and sweep run only when `answer` is on. */
	relayJobs: RelayJobsConfig;
	/** Automatic retry of a run that failed outside its own steps. */
	autoRetry: boolean;
	/** Serve the read-only dashboard. */
	dashboard: boolean;
}>;

/** Every wiring off: what a relay does when nothing is set. */
export const RELAY_WIRING_OFF: RelayWiringFlags = Object.freeze({
	relayJobs: DEFAULT_RELAY_JOBS,
	autoRetry: false,
	dashboard: false,
});

/**
 * The flags from a relay's environment. Each is on only when its variable is
 * exactly `1`: `HOBO_CI_RELAY_JOBS_ANSWER` (with `HOBO_CI_RELAY_JOBS_LABEL`,
 * the relay label by default), `HOBO_CI_AUTO_RETRY` and `HOBO_CI_DASHBOARD`.
 */
export function relayWiringFlags(env: NodeJS.ProcessEnv): RelayWiringFlags {
	const label = env.HOBO_CI_RELAY_JOBS_LABEL?.trim();
	return Object.freeze({
		relayJobs: Object.freeze({
			answer: env.HOBO_CI_RELAY_JOBS_ANSWER === "1",
			label: label ? label : DEFAULT_RELAY_JOBS.label,
		}),
		autoRetry: env.HOBO_CI_AUTO_RETRY === "1",
		dashboard: env.HOBO_CI_DASHBOARD === "1",
	});
}

/** Whether any wiring is on. */
export function relayWiringOn(flags: RelayWiringFlags): boolean {
	return flags.relayJobs.answer || flags.autoRetry || flags.dashboard;
}

/** A repository the relay is connected to, and the account it belongs to. */
export type WiredConnection = Readonly<{
	accountId: string;
	installationId: number;
	repository: string;
	/** Whether the repository is public; its kept minutes save no money. */
	public: boolean;
}>;

/** One relay-mode pass after a poll. */
export type RelayModePass = Readonly<{
	rescue: RelayRescueSummary;
	sweep: RelaySweepSummary;
}>;

export type RelayWiringLog = (
	event: string,
	fields: Readonly<{ [key: string]: string | number }>,
) => void;

export type RelayWiringOptions = Readonly<{
	flags: RelayWiringFlags;
	github: GithubTransport;
	/** The relay's connections, read fresh on each use. */
	connections: () => Promise<readonly WiredConnection[]>;
	/** The wiring's SQLite file, or `:memory:`. Opened only when a flag is on. */
	database: string;
	/** The relay's account authenticator; without it the read API is not served. */
	authenticate?: ControlAuthenticator | undefined;
	/** This node's name in the route journal. */
	node: string;
	/** The dashboard route (`createDashboardRoute` from `@hobo/ci-dashboard`). */
	dashboard?: ((request: Request) => Promise<Response | undefined>) | undefined;
	/** `GithubRunnerServiceClient` when absent. */
	runnerService?: RunnerServiceClient | undefined;
	/** `parseJitConfig` when absent. */
	readJitConfig?: (encoded: string, runnerName: string) => ParsedJitConfig;
	nowMs?: (() => number) | undefined;
	log?: RelayWiringLog | undefined;
}>;

export type RelayWiring = Readonly<{
	flags: RelayWiringFlags;
	/**
	 * Relay mode's rescue, then its sweep, over the polled repositories.
	 * Undefined, with no request made, when answering is off or the last pass
	 * is still running.
	 */
	afterPoll(
		connections: readonly RelayConnection[],
	): Promise<RelayModePass | undefined>;
	/**
	 * A webhook the relay accepted. With retry or the dashboard on, it is
	 * folded into the run history; with retry on, a failed `workflow_run` is
	 * offered to `autoRetryRun`. Undefined when retry is off or the delivery
	 * decides nothing. Never rejects.
	 */
	onWebhook(webhook: VerifiedWebhook): Promise<AutoRetryOutcome | undefined>;
	/** The dashboard's answer for its paths; undefined for any other, or when it is off. */
	page(request: Request): Promise<Response | undefined>;
	/** The read API's answer for its paths, with the dashboard on; undefined otherwise. */
	control(request: Request): Promise<Response | undefined>;
	/** The route journal relay mode writes, when any flag is on. */
	journal: RouteJournal | undefined;
	close(): void;
}>;

const WebhookSource = z.object({
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({ full_name: z.string().min(3) }),
});

function sameRepository(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function failure(error: Error | string): string {
	return error instanceof Error ? error.message : error;
}

/** GitHub's standard Linux rate, the price the read API's usage report keeps minutes at. */
const GITHUB_STANDARD_RATE = Object.freeze({
	usdPerMinute: GITHUB_LINUX_USD_PER_MINUTE,
	source: GITHUB_INCLUDED_COMPUTE_SOURCE,
	readOn: GITHUB_INCLUDED_COMPUTE_OBSERVED_AT,
});

/** The committed order of a connected repository, read with its own installation. */
class ConnectedOrderSource implements RunnerOrderSource {
	constructor(
		private readonly github: GithubTransport,
		private readonly connection: (
			repository: string,
		) => Promise<WiredConnection | undefined>,
	) {}

	async order(
		repository: string,
		ref: string | undefined,
	): Promise<RunnerOrderLookup> {
		const connection = await this.connection(repository);
		if (!connection)
			return {
				order: DEFAULT_RUNNER_ORDER,
				problem: "the repository is not connected to this relay",
			};
		return new GithubCiOrderSource(
			new GithubCiFile(this.github, connection.installationId),
		).order(repository, ref);
	}
}

/** The relay's wiring over its flags. See the module comment. */
export function createRelayWiring(options: RelayWiringOptions): RelayWiring {
	const { flags, github } = options;
	const nowMs = options.nowMs ?? Date.now;
	const log: RelayWiringLog = (event, fields) => {
		try {
			options.log?.(event, fields);
		} catch {
			// A failed logger must not fail a pass or a delivery.
		}
	};
	const db = relayWiringOn(flags)
		? new DatabaseSync(options.database)
		: undefined;
	const journal = db ? new SqliteRouteJournal(db, { nowMs }) : undefined;
	const machines = db ? new SqliteMachineRegistry(db) : undefined;
	const ledger = db && flags.autoRetry ? new SqliteRetryLedger(db) : undefined;
	const insights =
		db && (flags.autoRetry || flags.dashboard)
			? new SqliteInsightStore(db)
			: undefined;
	const ingest = insights ? new InsightIngest(insights) : undefined;

	const account = async (
		installationId: number,
		repository: string,
	): Promise<WiredConnection | undefined> =>
		(await options.connections()).find(
			(connection) =>
				connection.installationId === installationId &&
				sameRepository(connection.repository, repository),
		);

	const readApi =
		flags.dashboard && options.authenticate
			? createReadApi({
					authenticate: options.authenticate,
					repositories: async (accountId) =>
						(await options.connections())
							.filter((connection) => connection.accountId === accountId)
							.map((connection) => ({
								name: connection.repository,
								public: connection.public,
							})),
					order: new ConnectedOrderSource(github, async (repository) =>
						(await options.connections()).find((connection) =>
							sameRepository(connection.repository, repository),
						),
					),
					journal,
					machines,
					insights,
					minutes: undefined,
					githubRate: GITHUB_STANDARD_RATE,
					nowMs,
				})
			: undefined;

	let answerer: RelayAnswerer | undefined;
	if (journal && flags.relayJobs.answer) {
		answerer = createRelayAnswerer({
			relayJobs: flags.relayJobs,
			github,
			runnerService:
				options.runnerService ??
				new GithubRunnerServiceClient({ relayJobs: flags.relayJobs }),
			readJitConfig:
				options.readJitConfig ??
				((encoded, runnerName) => parseJitConfig(encoded, { runnerName })),
			account: async (job) =>
				(await account(job.installationId, job.repository))?.accountId,
			facts: (accountId) => {
				const facts = new StoreRouteFacts({
					accountId,
					// This relay starts no fleet runners of its own: the fleet step
					// is left out of relay-mode decisions here.
					fleet: undefined,
					machines,
					readers: undefined,
					spend: undefined,
					health: undefined,
					minutes: undefined,
					onWarning: (warning) =>
						log("hobo_ci_relay_facts_warning", {
							part: warning.part,
							message: warning.message,
						}),
				});
				// A relay job re-run by a retry is decided knowing it is one.
				return ledger ? new RetryRouteFacts(facts, ledger) : facts;
			},
			journal,
			node: options.node,
			nowMs,
		});
	}

	let pass: Promise<RelayModePass> | undefined;
	async function afterPoll(
		connections: readonly RelayConnection[],
	): Promise<RelayModePass | undefined> {
		if (!answerer || pass) return undefined;
		const relay = answerer;
		pass = (async () => {
			const rescue = await relay.rescue(connections);
			const sweep = await relay.sweep(connections);
			const answered = rescue.outcomes.filter(
				(outcome) => outcome.kind === "answered",
			).length;
			if (rescue.queued > 0 || sweep.deleted.length > 0)
				log("hobo_ci_relay_mode_pass", {
					queued: rescue.queued,
					answered,
					swept: sweep.deleted.length,
					failedReads: rescue.failedReads + sweep.failedReads,
				});
			return { rescue, sweep };
		})();
		try {
			return await pass;
		} catch (error) {
			log("hobo_ci_relay_mode_pass_failed", {
				message: failure(error instanceof Error ? error : String(error)),
			});
			return undefined;
		} finally {
			pass = undefined;
		}
	}

	async function retry(
		webhook: VerifiedWebhook,
	): Promise<AutoRetryOutcome | undefined> {
		if (!ingest) return undefined;
		const body = new TextDecoder().decode(webhook.rawBody);
		let parsed: z.infer<typeof WebhookSource>;
		try {
			const source = WebhookSource.safeParse(JSON.parse(body));
			if (!source.success) return undefined;
			parsed = source.data;
		} catch {
			return undefined;
		}
		const connection = await account(
			parsed.installation.id,
			parsed.repository.full_name,
		);
		if (!connection) return undefined;
		const run = await ingest.deliver(webhook.event, body);
		if (
			!journal ||
			!ledger ||
			webhook.event !== "workflow_run" ||
			run === undefined ||
			run.completedAtMs === undefined
		)
			return undefined;
		const installationId = connection.installationId;
		const outcome = await autoRetryRun(run, {
			accountId: connection.accountId,
			nowMs: nowMs(),
			journal,
			ledger,
			order: new GithubCiOrderSource(new GithubCiFile(github, installationId)),
			annotations: githubCheckRunAnnotations(github, installationId),
			// This relay keeps no machine events: no disconnect is known.
			machineDisconnects: machineEventDisconnects(async () => []),
			rerun: githubRerunJob(github, installationId),
		});
		if (outcome.retried || "row" in outcome)
			log("hobo_ci_auto_retry", {
				repository: run.repository,
				runId: run.id,
				attempt: run.attempt,
				retried: outcome.retried ? "yes" : outcome.reason,
			});
		return outcome;
	}

	return {
		flags,
		afterPoll,
		async onWebhook(webhook) {
			try {
				return await retry(webhook);
			} catch (error) {
				log("hobo_ci_auto_retry_failed", {
					deliveryId: webhook.deliveryId,
					message: failure(error instanceof Error ? error : String(error)),
				});
				return undefined;
			}
		},
		async page(request) {
			if (!flags.dashboard || !options.dashboard) return undefined;
			return options.dashboard(request);
		},
		async control(request) {
			return readApi ? readApi(request) : undefined;
		},
		journal,
		close() {
			db?.close();
		},
	};
}
