export type SimulatedJobStatus = "queued" | "in_progress" | "completed";

export type SimulatedStep = Readonly<{
	uses: string;
	with: ReadonlyMap<string, string>;
}>;

export type QueueJobInput = Readonly<{
	repository: string;

	name: string;

	labels: readonly string[];

	runId?: number;

	runAttempt?: number;

	event?: string;

	private?: boolean;

	fork?: boolean;

	actorId?: string;

	workflowRef?: string;

	inputs?: ReadonlyMap<string, string>;
	steps?: readonly SimulatedStep[];

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

	conclusion: string | undefined;

	runnerName: string | undefined;
	queuedAtMs: number;
	startedAtMs: number | undefined;
	completedAtMs: number | undefined;

	outputs: ReadonlyMap<string, string>;

	annotations: readonly string[];
}>;

export type SimulatedRunner = Readonly<{
	id: number;
	name: string;
	labels: readonly string[];
	status: "online" | "offline";
	busy: boolean;

	repository: string | undefined;

	ephemeral: boolean;
}>;

export type WebhookHandler = (request: Request) => Promise<Response>;

export interface GithubSimulatorPort {
	readonly fetch: typeof fetch;
	readonly baseUrl: string;

	readonly webhookSecret: string;

	queueJob(input: QueueJobInput): SimulatedJob;

	deliver(handler: WebhookHandler): Promise<readonly Response[]>;

	advance(ms: number): void;

	nowMs(): number;

	dropNextWebhook(): void;
	runners(): readonly SimulatedRunner[];
	jobs(): readonly SimulatedJob[];
}
