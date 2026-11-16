/**
 * The runner protocol as a relay sees it: open a session with a one-job
 * runner's credentials, take the next relay job, complete it with an answer,
 * close. In relay mode (ADR-0183) a HoBo node answers a job labelled
 * `hobo-relay` this way and starts no process for it, so the job uses no
 * runner minute and no job code runs.
 *
 * This file is the port and an in-memory fake. The client that speaks the
 * protocol to GitHub's runner service is written from the open-source runner
 * (`actions/runner`, MIT) and ships behind a flag that is off; until a live
 * run is linked, that channel is built, not proven.
 *
 * Where `ParsedJitConfig` comes from in `actions/runner`: the runner decodes
 * `--jitconfig` (base64 JSON naming the `.runner`, `.credentials` and
 * `.credentials_rsaparams` files) and writes those files before it starts
 * (`src/Runner.Listener/Runner.cs`). `.runner` holds `RunnerSettings` and
 * `.credentials` holds `CredentialData`, both in
 * `src/Runner.Common/ConfigurationStore.cs`. The parser that fills this type
 * belongs to the client and checks each field against those files.
 */
import { clone } from "@bufbuild/protobuf";
import {
	type RelayJobAnswer,
	type RelayJobMessage,
	RelayJobMessageSchema,
} from "@hobo/ci";

/** `.runner`: the one-job runner GitHub registered, and where to reach the service. */
export type JitRunnerSettings = Readonly<{
	agentId: number;
	agentName: string;
	poolId: number;
	/** The runner service's URL. */
	serverUrl: string;
	/** The repository or organization the runner was registered on. */
	gitHubUrl: string;
	workFolder: string;
	/** The broker flow, and its URL when used. */
	useV2Flow: boolean;
	serverUrlV2: string;
}>;

/** `.credentials`: how the runner signs in. */
export type JitCredentials = Readonly<{
	/** `OAuth` for a registered runner. */
	scheme: string;
	clientId: string;
	authorizationUrl: string;
}>;

declare const parsedJitConfig: unique symbol;
/**
 * A one-job runner's configuration, decoded and checked. `rsaParameters` is
 * the `.credentials_rsaparams` text as the runner wrote it: the private key
 * the session signs its token request with. It is a secret; nothing logs it.
 */
export type ParsedJitConfig = Readonly<{
	runner: JitRunnerSettings;
	credentials: JitCredentials;
	rsaParameters: string;
}> & { readonly [parsedJitConfig]: true };

export interface RunnerServiceClient {
	/** Sign in as the one-job runner and open a session that can take jobs. */
	open(jit: ParsedJitConfig): Promise<RunnerSession>;
}

export interface RunnerSession {
	/**
	 * The next job offered to this runner, waiting up to `waitMs`, or undefined
	 * when none came. A job is given to one session only.
	 */
	nextJob(waitMs: number): Promise<RelayJobMessage | undefined>;
	/** Complete a job this session took. Completing any other job throws. */
	complete(answer: RelayJobAnswer): Promise<void>;
	/** End the session. A closed session takes no more jobs. */
	close(): Promise<void>;
}

/** A configuration for tests that never reaches a real service. */
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
	// SAFETY: a test configuration names an unreachable service; nothing signs in with it.
	return Object.freeze(config) as ParsedJitConfig;
}

type Completion = Readonly<{ session: string; answer: RelayJobAnswer }>;

/**
 * A runner service in memory. `queue` offers a job; any open session may take
 * it, and only one does. `completions` keeps every answer in order.
 */
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

/** What a runner service conformance run needs: a client, and a way to offer it a job. */
export type RunnerServiceUnderTest = Readonly<{
	client: RunnerServiceClient;
	queue(message: RelayJobMessage): Promise<void> | void;
	/** A configuration the client accepts. */
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

/**
 * A runner service client keeps the protocol's rules: an empty queue gives
 * nothing, a job goes to one session only, only the session that took a job
 * completes it, and a closed session takes nothing. `message` and `answer`
 * make a job and its answer for the given job id.
 */
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
