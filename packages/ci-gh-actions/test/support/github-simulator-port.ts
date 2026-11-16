/**
 * The interface of the GitHub simulator the parity scenarios run against:
 * REST, billing and the runner service behind one `fetch`, a job queue, webhook
 * delivery with a lost-webhook switch, and its own clock. It touches no
 * network. This file is the interface only; the simulator implements it.
 *
 * A scenario drives it like GitHub would be driven: queue a job, deliver the
 * webhooks it caused to the relay's handler, move the clock, then read what
 * the runners and jobs look like.
 */

/** A job's status on GitHub. */
export type SimulatedJobStatus = "queued" | "in_progress" | "completed";

/** One step of a simulated job: what it `uses:` and its `with:` entries. */
export type SimulatedStep = Readonly<{
	uses: string;
	with: ReadonlyMap<string, string>;
}>;

/** A job to queue. Everything left out takes the default named beside it. */
export type QueueJobInput = Readonly<{
	repository: string;
	/** The job's id in its workflow file. */
	name: string;
	/** Its `runs-on` labels. */
	labels: readonly string[];
	/** A new run when absent. */
	runId?: number;
	/** 1 when absent. */
	runAttempt?: number;
	/** `push` when absent. */
	event?: string;
	/** true when absent. */
	private?: boolean;
	/** false when absent. */
	fork?: boolean;
	/** A fixed test user when absent. */
	actorId?: string;
	/** The workflow file at the default branch when absent. */
	workflowRef?: string;
	/** A relay job's `with:` inputs; none when absent. */
	inputs?: ReadonlyMap<string, string>;
	steps?: readonly SimulatedStep[];
	/** Jobs of the same run this one waits on, by name. */
	needs?: readonly string[];
}>;

export type SimulatedJob = Readonly<{
	id: number;
	runId: number;
	runAttempt: number;
	repository: string;
	name: string;
	labels: readonly string[];
	status: SimulatedJobStatus;
	/** Set once completed: `success`, `failure`, `cancelled` or `skipped`. */
	conclusion: string | undefined;
	/** The runner that took it, once one has. */
	runnerName: string | undefined;
	queuedAtMs: number;
	startedAtMs: number | undefined;
	completedAtMs: number | undefined;
	/** What its completion set, for a relay job. */
	outputs: ReadonlyMap<string, string>;
	/** The annotations its completion carried. */
	annotations: readonly string[];
}>;

export type SimulatedRunner = Readonly<{
	id: number;
	name: string;
	labels: readonly string[];
	status: "online" | "offline";
	busy: boolean;
	/** Set for a runner registered on one repository. */
	repository: string | undefined;
	/** A one-job runner GitHub removes after its job. */
	ephemeral: boolean;
}>;

/** A relay's webhook endpoint: takes a signed delivery, answers like a server. */
export type WebhookHandler = (request: Request) => Promise<Response>;

export interface GithubSimulatorPort {
	/** REST (`/repos/...`), billing (`/users/.../settings/billing/...`) and the runner service, all under `baseUrl`. */
	readonly fetch: typeof fetch;
	readonly baseUrl: string;
	/** The secret webhook deliveries are signed with. */
	readonly webhookSecret: string;
	/** Queue a job; its `workflow_job` `queued` webhook waits to be delivered. */
	queueJob(input: QueueJobInput): SimulatedJob;
	/**
	 * Deliver every webhook waiting, oldest first, to `handler`, and return its
	 * responses. A webhook dropped by `dropNextWebhook` is never delivered.
	 */
	deliver(handler: WebhookHandler): Promise<readonly Response[]>;
	/** Move the simulator's clock forward. Jobs, runners and limits read it. */
	advance(ms: number): void;
	/** The simulator's clock, epoch milliseconds. */
	nowMs(): number;
	/** Lose the next webhook, as GitHub sometimes does. */
	dropNextWebhook(): void;
	runners(): readonly SimulatedRunner[];
	jobs(): readonly SimulatedJob[];
}
