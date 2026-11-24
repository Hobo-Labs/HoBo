import type { RelayJobMessage } from "@hobo/ci";
import { signWebhookBody } from "../../../src/webhook-signature.js";
import type {
	GithubSimulatorPort,
	QueueJobInput,
	SimulatedJob,
	SimulatedRunner,
	WebhookHandler,
} from "../github-simulator-port.js";
import type {
	BillingUsageItem,
	DeliveryRecord,
	JobRecord,
	RecordedRequest,
	RunnerRecord,
} from "./records.js";
import { routeRest } from "./rest.js";
import { RUNNER_SERVICE_PATH } from "./runner-service.js";
import {
	type JobCompletion,
	type RegisterRunnerInput,
	SIMULATOR_EPOCH_MS,
	SimulatorState,
} from "./state.js";

export type GithubSimulatorOptions = Readonly<{
	baseUrl?: string;
	webhookSecret?: string;
	installationId?: number;
	startMs?: number;
	webhookUrl?: string;
}>;

export type MountedRunnerService = (
	request: Request,
	github: GithubSimulator,
) => Promise<Response>;

export type SimulatedDelivery = Readonly<{
	id: string;
	event: string;
	dropped: boolean;
	delivered: number;
}>;

function jobSnapshot(job: JobRecord): SimulatedJob {
	return Object.freeze({
		id: job.id,
		runId: job.runId,
		runAttempt: job.runAttempt,
		repository: job.repository,
		name: job.name,
		labels: Object.freeze([...job.labels]),
		status: job.status,
		conclusion: job.conclusion,
		runnerName: job.runnerName,
		queuedAtMs: job.queuedAtMs,
		startedAtMs: job.startedAtMs,
		completedAtMs: job.completedAtMs,
		outputs: new Map(job.outputs),
		annotations: Object.freeze(
			job.annotations.map((annotation) => annotation.message),
		),
	});
}

function runnerSnapshot(runner: RunnerRecord): SimulatedRunner {
	return Object.freeze({
		id: runner.id,
		name: runner.name,
		labels: Object.freeze(runner.labels.map((label) => label.name)),
		status: runner.status,
		busy: runner.busy,
		repository: runner.repository,
		ephemeral: runner.ephemeral,
	});
}

function area(path: string): RecordedRequest["area"] {
	if (path.startsWith(RUNNER_SERVICE_PATH)) return "runner-service";
	return "unknown";
}

export class GithubSimulator implements GithubSimulatorPort {
	readonly baseUrl: string;
	readonly webhookSecret: string;
	readonly fetch: typeof fetch;
	readonly state: SimulatorState;
	private readonly webhookUrl: string;
	private readonly recorded: RecordedRequest[] = [];
	private mounted: MountedRunnerService | undefined;

	constructor(options: GithubSimulatorOptions = {}) {
		this.baseUrl = (
			options.baseUrl ?? "https://github-simulator.invalid"
		).replace(/\/+$/u, "");
		this.webhookSecret =
			options.webhookSecret ?? "github-simulator-webhook-secret-0123456789";
		this.webhookUrl = options.webhookUrl ?? "https://relay.invalid/webhook";
		this.state = new SimulatorState(
			options.installationId ?? 1,
			options.startMs ?? SIMULATOR_EPOCH_MS,
		);
		const send: typeof fetch = (input, init) => {
			const request = new Request(input, init);
			return this.send(request, request.redirect);
		};
		this.fetch = send;
	}

	private async send(
		request: Request,
		redirect: RequestRedirect,
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.origin !== new URL(this.baseUrl).origin)
			throw new TypeError(
				`fetch failed: the simulator has no network to reach ${url.origin}`,
			);
		const body = request.body ? await request.text() : "";
		const base = {
			atMs: this.state.now(),
			method: request.method,
			path: url.pathname,
			query: url.search,
			body,
			authorized: request.headers.has("authorization"),
		};
		if (url.pathname.startsWith(RUNNER_SERVICE_PATH)) {
			const mounted = this.mounted;
			const response = mounted
				? await mounted(
						new Request(request.url, {
							method: request.method,
							headers: request.headers,
							body: body === "" ? null : body,
						}),
						this,
					)
				: Response.json(
						{ message: "no runner service is mounted on the simulator" },
						{ status: 501 },
					);
			this.recorded.push({
				...base,
				status: response.status,
				area: area(url.pathname),
			});
			return response;
		}
		const routed = routeRest(
			{
				state: this.state,
				baseUrl: this.baseUrl,
				runnerServiceUrl: `${this.baseUrl}${RUNNER_SERVICE_PATH}/`,
			},
			request.method,
			url,
			body,
		);
		this.recorded.push({
			...base,
			status: routed.response.status,
			area: routed.area,
		});
		const location = routed.response.headers.get("location");
		if (routed.response.status === 302 && location) {
			if (redirect === "error")
				throw new TypeError("fetch failed: unexpected redirect");
			if (redirect === "follow")
				return this.send(new Request(location), redirect);
		}
		return routed.response;
	}

	queueJob(input: QueueJobInput): SimulatedJob {
		return jobSnapshot(this.state.queueJob(input));
	}

	async deliver(handler: WebhookHandler): Promise<readonly Response[]> {
		const responses: Response[] = [];
		for (const delivery of this.state.takePending()) {
			delivery.delivered += 1;
			const bytes = new TextEncoder().encode(delivery.body);
			responses.push(
				await handler(
					new Request(this.webhookUrl, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"user-agent": "GitHub-Hookshot/simulator",
							"x-github-event": delivery.event,
							"x-github-delivery": delivery.id,
							"x-github-hook-installation-target-type": "integration",
							"x-hub-signature-256": signWebhookBody(this.webhookSecret, bytes),
						},
						body: delivery.body,
					}),
				),
			);
		}
		return responses;
	}

	advance(ms: number): void {
		this.state.advance(ms);
	}

	nowMs(): number {
		return this.state.now();
	}

	dropNextWebhook(): void {
		this.state.dropNext();
	}

	runners(): readonly SimulatedRunner[] {
		return [...this.state.runners.values()].map(runnerSnapshot);
	}

	jobs(): readonly SimulatedJob[] {
		return [...this.state.jobs.values()]
			.filter((job) => !job.blocked)
			.map(jobSnapshot);
	}

	registerRunner(input: RegisterRunnerInput): SimulatedRunner {
		return runnerSnapshot(this.state.registerRunner(input));
	}

	claim(runnerName: string): SimulatedJob | undefined {
		const job = this.state.claim(runnerName);
		return job ? jobSnapshot(job) : undefined;
	}

	complete(jobId: number, completion: JobCompletion): SimulatedJob {
		return jobSnapshot(this.state.complete(jobId, completion));
	}

	queueRelayMessage(
		message: RelayJobMessage,
		labels: readonly string[],
	): SimulatedJob {
		const input: QueueJobInput = {
			repository: message.repository,
			name: message.job,
			labels,
			runId: message.runId,
			runAttempt: message.runAttempt === 0 ? 1 : message.runAttempt,
			event: message.event,
			private: message.private,
			fork: message.fork,
			actorId: message.actorId,
			inputs: new Map(message.inputs.map((entry) => [entry.name, entry.value])),
			steps: message.steps.map((step) => ({
				uses: step.uses,
				with: new Map(step.inputs.map((entry) => [entry.name, entry.value])),
			})),
		};
		return jobSnapshot(
			this.state.queueJob(
				message.workflowRef === ""
					? input
					: { ...input, workflowRef: message.workflowRef },
				message.jobId,
			),
		);
	}

	relayJobMessage(jobId: number): RelayJobMessage {
		const job = this.state.jobs.get(jobId);
		if (!job) throw new Error(`no job ${jobId}`);
		return this.state.relayJobMessage(job);
	}

	cancelRun(runId: number): void {
		const run = this.state.run(runId);
		if (!run) throw new Error(`no run ${runId}`);
		this.state.cancelRun(run);
	}

	putFile(
		repository: string,
		path: string,
		text: string,
		branch?: string,
	): void {
		this.state.putFile(repository, path, text, branch);
	}

	addRepository(fullName: string, isPrivate = true): void {
		this.state.ensureRepository(fullName, isPrivate);
	}

	addBillingUsage(
		kind: "user" | "organization",
		account: string,
		item: BillingUsageItem,
	): void {
		this.state.addBilling(
			`${kind === "user" ? "users" : "organizations"}:${account}`,
			item,
		);
	}

	mountRunnerService(service: MountedRunnerService): void {
		this.mounted = service;
	}

	redeliver(deliveryId: string): void {
		this.state.redeliver(deliveryId);
	}

	deliveries(): readonly SimulatedDelivery[] {
		return this.state.deliveries.map((delivery: DeliveryRecord) =>
			Object.freeze({
				id: delivery.id,
				event: delivery.event,
				dropped: delivery.dropped,
				delivered: delivery.delivered,
			}),
		);
	}

	requests(): readonly RecordedRequest[] {
		return [...this.recorded];
	}
}
