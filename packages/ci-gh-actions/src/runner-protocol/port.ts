import { clone } from "@bufbuild/protobuf";
import {
	type RelayJobAnswer,
	type RelayJobMessage,
	RelayJobMessageSchema,
} from "@hobo/ci";

export type JitRunnerSettings = Readonly<{
	agentId: number;
	agentName: string;
	poolId: number;

	serverUrl: string;

	gitHubUrl: string;
	workFolder: string;

	useV2Flow: boolean;
	serverUrlV2: string;
}>;

export type JitCredentials = Readonly<{
	scheme: string;
	clientId: string;
	authorizationUrl: string;
}>;

declare const parsedJitConfig: unique symbol;

type JitConfig = Readonly<{
	runner: JitRunnerSettings;
	credentials: JitCredentials;
	rsaParameters: string;
}>;

export type ParsedJitConfig = JitConfig & { readonly [parsedJitConfig]: true };

function isTestJitConfig(config: JitConfig): config is ParsedJitConfig {
	return (
		config.runner.serverUrl === "https://runner.invalid/" &&
		config.credentials.authorizationUrl === "https://runner.invalid/token" &&
		config.rsaParameters === "{}"
	);
}

export interface RunnerServiceClient {
	open(jit: ParsedJitConfig): Promise<RunnerSession>;
}

export interface RunnerSession {
	nextJob(waitMs: number): Promise<RelayJobMessage | undefined>;

	complete(answer: RelayJobAnswer): Promise<void>;

	close(): Promise<void>;
}

export function testJitConfig(agentName = "hobo-relay-test"): ParsedJitConfig {
	const config = {
		runner: {
			agentId: 1,
			agentName,
			poolId: 1,
			serverUrl: "https://runner.invalid/",
			gitHubUrl: "https://github.com/octo/app",
			workFolder: "_work",
			useV2Flow: false,
			serverUrlV2: "",
		},
		credentials: {
			scheme: "OAuth",
			clientId: "00000000-0000-0000-0000-000000000000",
			authorizationUrl: "https://runner.invalid/token",
		},
		rsaParameters: "{}",
	};
	if (!isTestJitConfig(config))
		throw new Error("invalid test runner configuration");
	return Object.freeze(config);
}

type Completion = Readonly<{ session: string; answer: RelayJobAnswer }>;

export class InMemoryRunnerService implements RunnerServiceClient {
	private readonly pending: RelayJobMessage[] = [];
	private readonly taken = new Map<string, string>();
	readonly completions: Completion[] = [];
	readonly opened: string[] = [];

	queue(message: RelayJobMessage): void {
		this.pending.push(clone(RelayJobMessageSchema, message));
	}

	async open(jit: ParsedJitConfig): Promise<RunnerSession> {
		const name = `${jit.runner.agentName}#${this.opened.length + 1}`;
		this.opened.push(name);
		let closed = false;
		return {
			nextJob: async () => {
				if (closed) throw new Error("the runner session is closed");
				const message = this.pending.shift();
				if (message) this.taken.set(message.jobId, name);
				return message;
			},
			complete: async (answer) => {
				if (closed) throw new Error("the runner session is closed");
				if (this.taken.get(answer.jobId) !== name)
					throw new Error(`job ${answer.jobId} was not taken by this session`);
				this.taken.delete(answer.jobId);
				this.completions.push({ session: name, answer });
			},
			close: async () => {
				closed = true;
			},
		};
	}
}

export type RunnerServiceUnderTest = Readonly<{
	client: RunnerServiceClient;
	queue(message: RelayJobMessage): Promise<void> | void;

	jit: ParsedJitConfig;
}>;

function rule(ok: boolean, text: string): void {
	if (!ok) throw new Error(`runner service conformance: ${text}`);
}

async function rejects(action: () => Promise<void>): Promise<boolean> {
	try {
		await action();
		return false;
	} catch {
		return true;
	}
}

export async function runnerServiceClientConformance(
	make: () => RunnerServiceUnderTest | Promise<RunnerServiceUnderTest>,
	fixtures: Readonly<{
		message(jobId: string): RelayJobMessage;
		answer(jobId: string): RelayJobAnswer;
	}>,
): Promise<void> {
	const service = await make();
	const first = await service.client.open(service.jit);
	const second = await service.client.open(service.jit);
	rule((await first.nextJob(0)) === undefined, "an empty queue gives no job");
	await service.queue(fixtures.message("job-1"));
	const taken = [await first.nextJob(1_000), await second.nextJob(0)];
	rule(
		taken.filter((job) => job !== undefined).length === 1,
		"a job is given to one session only",
	);
	rule(taken[0]?.jobId === "job-1", "the job comes back as queued");
	rule(
		await rejects(() => second.complete(fixtures.answer("job-1"))),
		"a session cannot complete a job it did not take",
	);
	await first.complete(fixtures.answer("job-1"));
	rule(
		await rejects(() => first.complete(fixtures.answer("job-1"))),
		"a job is completed once",
	);
	await second.close();
	rule(
		await rejects(async () => {
			await second.nextJob(0);
		}),
		"a closed session takes no more jobs",
	);
	await first.close();
}
