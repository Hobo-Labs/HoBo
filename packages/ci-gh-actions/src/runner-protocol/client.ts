/**
 * `GithubRunnerServiceClient`: the runner protocol spoken to GitHub's runner
 * service, so a relay can take a relay job as a one-job runner and complete it
 * with an answer without starting any process (ADR-0183, relay mode).
 *
 * It ships off: `open` refuses unless `relayJobs.answer` is on. Until a relay
 * has run it against GitHub and the run is linked, this channel is built, not
 * proven.
 *
 * The flow is the runner's broker flow, read from `actions/runner` (commit in
 * `./source.ts`):
 *
 * 1. Sign in: a client assertion signed with the runner's key is exchanged for
 *    an access token (`OAuthCredential.cs`, `VssOAuthJwtBearerAssertion.cs`).
 * 2. `POST {ServerUrlV2}session` opens a session (`BrokerHttpClient.CreateSessionAsync`).
 * 3. `GET {ServerUrlV2}message` long-polls for a job (`GetRunnerMessageAsync`).
 * 4. `POST {ServerUrlV2}acknowledge` when the offer asks for it
 *    (`AcknowledgeRunnerRequestAsync`, `Runner.cs`).
 * 5. `POST {run_service_url}acquirejob` takes the job (`RunServiceHttpClient.GetJobMessageAsync`).
 * 6. `POST {run_service_url}completejob` completes it (`RunServiceHttpClient.CompleteJobAsync`).
 * 7. `DELETE {ServerUrlV2}session` ends the session (`DeleteSessionAsync`).
 *
 * Acknowledging is the one call beyond open, take, complete and close; the
 * runner makes it when the offer says `should_acknowledge`, so this client
 * does too. It renews no job lock (`renewjob`): a relay answers in seconds.
 *
 * Every call has a deadline, is retried once on a server error or a dropped
 * connection, and signs in again once on a 401. A call goes only to an https
 * GitHub host, with redirects refused, so the token never leaves GitHub.
 */
import { Buffer } from "node:buffer";
import { createSign, randomUUID } from "node:crypto";
import type {
	RelayJobAnswer,
	RelayJobMessage,
	RelayJobsConfig,
} from "@hobo/ci";
import { isGithubServiceUrl, jitSigningKey } from "./jit-config.js";
import { ProtocolJsonRejection, readProtocolJson } from "./json.js";
import type {
	ParsedJitConfig,
	RunnerServiceClient,
	RunnerSession,
} from "./port.js";
import { RUNNER_PROTOCOL_VERSION } from "./source.js";
import {
	AGENT_MESSAGE,
	type CompletedJob,
	completeJobBody,
	FORCE_TOKEN_REFRESH,
	isRelayJob,
	JOB_IDS,
	JOB_MESSAGE,
	JOB_REQUEST_REF,
	type JobMessage,
	type JobRequestRef,
	RUNNER_JOB_REQUEST,
	relayJobMessageOf,
	SESSION,
	TOKEN_RESPONSE,
} from "./wire.js";

/** Something the client did that a caller may want to log. Never holds a token or key. */
export type RunnerProtocolEvent =
	| Readonly<{ kind: "token-issued" }>
	| Readonly<{ kind: "retried"; call: string; status: number }>
	| Readonly<{ kind: "message-ignored"; messageType: string }>
	| Readonly<{ kind: "job-lost"; requestId: string; status: number }>
	| Readonly<{ kind: "job-refused"; jobId: string; reason: string }>
	| Readonly<{
			kind: "job-unreadable";
			requestId: string;
			/** Empty when even the job's id could not be read. */
			jobId: string;
			reason: string;
	  }>
	| Readonly<{ kind: "acknowledge-failed"; requestId: string; status: number }>
	| Readonly<{ kind: "close-failed"; status: number }>;

export type GithubRunnerServiceOptions = Readonly<{
	/** `relayJobs` from `.hobo/ci.json`. The client opens nothing unless `answer` is on. */
	relayJobs: RelayJobsConfig;
	fetch?: typeof fetch;
	/** The clock tokens expire by, epoch ms. */
	nowMs?: () => number;
	/** The longest any one call may take; 60 seconds when absent. */
	callTimeoutMs?: number;
	/** The runner version reported to the service; `RUNNER_PROTOCOL_VERSION` when absent. */
	runnerVersion?: string;
	/** The session's owner name the service shows; `hobo-relay` when absent. */
	sessionOwner?: string;
	onEvent?: (event: RunnerProtocolEvent) => void;
}>;

/** A runner protocol call failed. The message names the call and status, never a token. */
export class RunnerProtocolError extends Error {
	override readonly name = "RunnerProtocolError";
	constructor(
		message: string,
		/** The HTTP status, or 0 when no answer came. */
		readonly status: number,
		/** The call ran past its deadline. */
		readonly timedOut = false,
		/** The call that failed, such as `message` or `OAuth token`; empty when none was sent. */
		readonly call = "",
	) {
		super(message);
	}
}

/** Relay mode is off; nothing was sent. */
export class RelayModeOffError extends Error {
	override readonly name = "RelayModeOffError";
}

const OAUTH_TOKEN_PATH = "OAuth token";
/** `VssOAuthConstants.cs`. */
const CLIENT_ASSERTION_TYPE =
	"urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** `VssOAuthJwtBearerAssertion.BearerTokenLifetime`: five minutes. */
const ASSERTION_LIFETIME_S = 300;
/** A token is renewed this long before it says it expires. */
const TOKEN_SKEW_MS = 60_000;
/** A token whose response gives no lifetime is kept this long. */
const DEFAULT_TOKEN_MS = 5 * 60_000;
/** The shortest long poll, so a zero wait still asks once. */
const MIN_POLL_MS = 1_000;
/** The pause after an empty poll that came back at once. */
const EMPTY_POLL_PAUSE_MS = 1_000;
/**
 * The query the runner sends with each broker call: `TaskAgentStatus.Online`,
 * and `VarUtil.OS` and `VarUtil.OSArchitecture` for Linux on x64
 * (`BrokerMessageListener.GetNextMessageAsync`). `disableUpdate` keeps the
 * service from offering a self-update a relay would never apply.
 */
const RUNNER_STATUS = "Online";
const RUNNER_OS = "Linux";
const RUNNER_ARCH = "X64";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

type CallInit = Readonly<{
	method: "GET" | "POST" | "DELETE";
	url: URL;
	body: string | undefined;
	contentType: string | undefined;
	timeoutMs: number;
	name: string;
}>;

function isAbort(error: Error): boolean {
	return error.name === "TimeoutError" || error.name === "AbortError";
}

function brokerUrl(
	base: string,
	path: string,
	query: ReadonlyMap<string, string>,
): URL {
	const root = base.endsWith("/") ? base : `${base}/`;
	const url = new URL(path, root);
	for (const [name, value] of query) url.searchParams.set(name, value);
	return url;
}

function jwtPart(claims: ReadonlyMap<string, string | number>): string {
	return Buffer.from(JSON.stringify(Object.fromEntries(claims))).toString(
		"base64url",
	);
}

/** The access token of one runner, renewed when it nears expiry or the service refuses it. */
class RunnerToken {
	private value: string | undefined;
	private expiresAtMs = 0;

	constructor(
		private readonly jit: ParsedJitConfig,
		private readonly client: GithubRunnerServiceClient,
	) {}

	drop(): void {
		this.value = undefined;
	}

	async get(): Promise<string> {
		if (this.value !== undefined && this.client.now() < this.expiresAtMs)
			return this.value;
		const response = await this.client.send(
			{
				method: "POST",
				url: new URL(this.jit.credentials.authorizationUrl),
				body: new URLSearchParams([
					["grant_type", "client_credentials"],
					["client_assertion_type", CLIENT_ASSERTION_TYPE],
					["client_assertion", this.assertion()],
				]).toString(),
				contentType: "application/x-www-form-urlencoded",
				timeoutMs: this.client.callTimeoutMs,
				name: OAUTH_TOKEN_PATH,
			},
			undefined,
		);
		if (!response.ok)
			throw new RunnerProtocolError(
				`the runner service refused the runner's sign-in (${response.status}); the one-job runner may have been removed or used`,
				response.status,
			);
		const token = readProtocolJson(
			await response.text(),
			TOKEN_RESPONSE,
			"the token response",
		);
		this.value = token.access_token;
		const lifetime =
			token.expires_in === undefined
				? DEFAULT_TOKEN_MS
				: token.expires_in * 1000;
		this.expiresAtMs =
			this.client.now() + Math.max(lifetime - TOKEN_SKEW_MS, 0);
		this.client.emit({ kind: "token-issued" });
		return this.value;
	}

	/** A client assertion (`VssOAuthJwtBearerAssertion.GetBearerToken`): issuer and subject the client id, audience the token URL. */
	private assertion(): string {
		const nowS = Math.floor(this.client.now() / 1000);
		const claims = new Map<string, string | number>([
			["sub", this.jit.credentials.clientId],
			["jti", randomUUID()],
			["iss", this.jit.credentials.clientId],
			["aud", this.jit.credentials.authorizationUrl],
			["nbf", nowS],
			["exp", nowS + ASSERTION_LIFETIME_S],
		]);
		const header = new Map([
			["alg", "RS256"],
			["typ", "JWT"],
		]);
		const input = `${jwtPart(header)}.${jwtPart(claims)}`;
		const signature = createSign("RSA-SHA256")
			.update(input)
			.sign(jitSigningKey(this.jit.rsaParameters))
			.toString("base64url");
		return `${input}.${signature}`;
	}
}

type TakenJob = Readonly<{
	planId: string;
	runServiceUrl: string;
	billingOwnerId: string;
}>;

class GithubRunnerSession implements RunnerSession {
	private closed = false;
	private readonly taken = new Map<string, TakenJob>();

	constructor(
		private readonly client: GithubRunnerServiceClient,
		private readonly jit: ParsedJitConfig,
		private readonly token: RunnerToken,
		private readonly sessionId: string,
	) {}

	private query(): Map<string, string> {
		return new Map([
			["sessionId", this.sessionId],
			["status", RUNNER_STATUS],
			["runnerVersion", this.client.runnerVersion],
			["os", RUNNER_OS],
			["architecture", RUNNER_ARCH],
		]);
	}

	async nextJob(waitMs: number): Promise<RelayJobMessage | undefined> {
		if (this.closed) throw new Error("the runner session is closed");
		const now = () => this.client.now();
		const until = now() + Math.max(waitMs, 0);
		for (;;) {
			const remaining = until - now();
			const started = now();
			const offer = await this.poll(
				Math.min(Math.max(remaining, MIN_POLL_MS), this.client.callTimeoutMs),
			);
			if (offer) {
				const job = await this.take(offer);
				if (job) return job;
			}
			if (until - now() <= 0) return undefined;
			if (!offer && now() - started < EMPTY_POLL_PAUSE_MS)
				await new Promise((resolve) =>
					setTimeout(resolve, Math.min(EMPTY_POLL_PAUSE_MS, until - now())),
				);
		}
	}

	/**
	 * One long poll. Undefined when no job was offered before the deadline.
	 * Only the message call running out of time counts as an empty poll; a
	 * sign-in that times out is an error, so an outage is not hidden as quiet.
	 */
	private async poll(timeoutMs: number): Promise<JobRequestRef | undefined> {
		const query = this.query();
		query.set("disableUpdate", "true");
		let response: Response;
		try {
			response = await this.client.authorized(this.token, {
				method: "GET",
				url: brokerUrl(this.jit.runner.serverUrlV2, "message", query),
				body: undefined,
				contentType: undefined,
				timeoutMs,
				name: "message",
			});
		} catch (error) {
			if (
				error instanceof RunnerProtocolError &&
				error.timedOut &&
				error.call === "message"
			)
				return undefined;
			throw error;
		}
		if (response.status === 202 || response.status === 204) return undefined;
		if (!response.ok)
			throw new RunnerProtocolError(
				`the broker refused the message poll (${response.status})`,
				response.status,
			);
		const body = (await response.text()).trim();
		if (body === "" || body === "null") return undefined;
		const message = readProtocolJson(body, AGENT_MESSAGE, "the broker message");
		if (message.messagetype === FORCE_TOKEN_REFRESH) {
			this.token.drop();
			return undefined;
		}
		if (message.messagetype !== RUNNER_JOB_REQUEST) {
			this.client.emit({
				kind: "message-ignored",
				messageType: message.messagetype,
			});
			return undefined;
		}
		const offer = readProtocolJson(
			message.body,
			JOB_REQUEST_REF,
			"the job offer",
		);
		if (!isGithubServiceUrl(offer.run_service_url)) {
			this.client.emit({
				kind: "job-lost",
				requestId: offer.runner_request_id,
				status: 0,
			});
			return undefined;
		}
		return offer;
	}

	/** Acknowledge and acquire an offered job. Undefined when it went elsewhere or was not a relay job. */
	private async take(
		offer: JobRequestRef,
	): Promise<RelayJobMessage | undefined> {
		if (offer.should_acknowledge) {
			const ack = await this.client.authorized(this.token, {
				method: "POST",
				url: brokerUrl(
					this.jit.runner.serverUrlV2,
					"acknowledge",
					this.query(),
				),
				body: JSON.stringify({ runnerRequestId: offer.runner_request_id }),
				contentType: "application/json",
				timeoutMs: this.client.callTimeoutMs,
				name: "acknowledge",
			});
			if (ack.status === 404) {
				this.client.emit({
					kind: "job-lost",
					requestId: offer.runner_request_id,
					status: 404,
				});
				return undefined;
			}
			if (!ack.ok)
				this.client.emit({
					kind: "acknowledge-failed",
					requestId: offer.runner_request_id,
					status: ack.status,
				});
		}
		const acquired = await this.client.authorized(this.token, {
			method: "POST",
			url: new URL("acquirejob", offer.run_service_url),
			body: JSON.stringify({
				jobMessageId: offer.runner_request_id,
				runnerOS: RUNNER_OS,
				billingOwnerId: offer.billing_owner_id,
			}),
			contentType: "application/json",
			timeoutMs: this.client.callTimeoutMs,
			name: "acquirejob",
		});
		// `Runner.cs` skips an offer whose acquire answers 404, 409 or 422.
		if (
			acquired.status === 404 ||
			acquired.status === 409 ||
			acquired.status === 422
		) {
			this.client.emit({
				kind: "job-lost",
				requestId: offer.runner_request_id,
				status: acquired.status,
			});
			return undefined;
		}
		if (!acquired.ok)
			throw new RunnerProtocolError(
				`the run service refused to hand over the job (${acquired.status})`,
				acquired.status,
			);
		// The job is this runner's now: whatever its message holds, it is
		// completed or handed out, never left until the service drops the lock.
		const text = await acquired.text();
		let ids: ReturnType<typeof JOB_IDS.parse>;
		try {
			ids = readProtocolJson(text, JOB_IDS, "the job message");
		} catch (error) {
			if (!(error instanceof ProtocolJsonRejection)) throw error;
			// Without its plan and job id the job cannot be completed; the service
			// fails it when the lock lapses.
			this.client.emit({
				kind: "job-unreadable",
				requestId: offer.runner_request_id,
				jobId: "",
				reason: error.message,
			});
			return undefined;
		}
		const taken: TakenJob = {
			planId: ids.plan.planid,
			runServiceUrl: offer.run_service_url,
			billingOwnerId: ids.billingownerid ?? offer.billing_owner_id,
		};
		this.taken.set(ids.jobid, taken);
		let message: RelayJobMessage;
		let job: JobMessage;
		try {
			job = readProtocolJson(text, JOB_MESSAGE, "the job message");
			message = relayJobMessageOf(job);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			const reason = `The HoBo relay could not read this job's message (${error instanceof ProtocolJsonRejection ? error.message : error.name}), so it completed the job as failed without running anything. Run it again; if it fails the same way, give it another runs-on label and report it.`;
			await this.finish(
				{
					jobId: ids.jobid,
					conclusion: "failed",
					outputs: [],
					annotations: [{ level: "error", message: reason }],
				},
				taken,
			);
			this.client.emit({
				kind: "job-unreadable",
				requestId: offer.runner_request_id,
				jobId: ids.jobid,
				reason,
			});
			return undefined;
		}
		if (isRelayJob(message, job)) return message;
		const reason =
			"This job asked for the HoBo relay's runner label but is not a relay job. A relay runs no job code, so the job was completed as failed; give it another runs-on label.";
		await this.finish(
			{
				jobId: message.jobId,
				conclusion: "failed",
				outputs: [],
				annotations: [{ level: "error", message: reason }],
			},
			taken,
		);
		this.client.emit({ kind: "job-refused", jobId: message.jobId, reason });
		return undefined;
	}

	async complete(answer: RelayJobAnswer): Promise<void> {
		if (this.closed) throw new Error("the runner session is closed");
		const taken = this.taken.get(answer.jobId);
		if (!taken)
			throw new Error(`job ${answer.jobId} was not taken by this session`);
		if (answer.planId !== taken.planId)
			throw new Error(`job ${answer.jobId} belongs to another plan`);
		await this.finish(answer, taken);
	}

	private async finish(answer: CompletedJob, taken: TakenJob): Promise<void> {
		const response = await this.client.authorized(this.token, {
			method: "POST",
			url: new URL("completejob", taken.runServiceUrl),
			body: completeJobBody(answer, taken.planId, taken.billingOwnerId),
			contentType: "application/json",
			timeoutMs: this.client.callTimeoutMs,
			name: "completejob",
		});
		if (!response.ok)
			throw new RunnerProtocolError(
				`the run service refused to complete job ${answer.jobId} (${response.status})`,
				response.status,
			);
		this.taken.delete(answer.jobId);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			const response = await this.client.authorized(this.token, {
				method: "DELETE",
				url: brokerUrl(
					this.jit.runner.serverUrlV2,
					"session",
					new Map([["sessionId", this.sessionId]]),
				),
				body: undefined,
				contentType: undefined,
				timeoutMs: this.client.callTimeoutMs,
				name: "session",
			});
			if (!response.ok)
				this.client.emit({ kind: "close-failed", status: response.status });
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			this.client.emit({ kind: "close-failed", status: 0 });
		}
	}
}

/** The runner protocol client. One instance can open sessions for many one-job runners. */
export class GithubRunnerServiceClient implements RunnerServiceClient {
	readonly callTimeoutMs: number;
	readonly runnerVersion: string;
	private readonly fetcher: typeof fetch;
	private readonly clock: () => number;

	constructor(private readonly options: GithubRunnerServiceOptions) {
		this.fetcher = options.fetch ?? globalThis.fetch;
		this.clock = options.nowMs ?? Date.now;
		this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
		this.runnerVersion = options.runnerVersion ?? RUNNER_PROTOCOL_VERSION;
	}

	now(): number {
		return this.clock();
	}

	emit(event: RunnerProtocolEvent): void {
		this.options.onEvent?.(event);
	}

	async open(jit: ParsedJitConfig): Promise<RunnerSession> {
		if (!this.options.relayJobs.answer)
			throw new RelayModeOffError(
				"relay mode is off: relayJobs.answer is false in .hobo/ci.json, so no runner session is opened",
			);
		if (!jit.runner.useV2Flow || jit.runner.serverUrlV2 === "")
			throw new RunnerProtocolError(
				"the one-job runner does not use the broker flow (UseV2Flow and ServerUrlV2), the only one this client speaks",
				0,
			);
		const token = new RunnerToken(jit, this);
		const response = await this.authorized(token, {
			method: "POST",
			url: brokerUrl(jit.runner.serverUrlV2, "session", new Map()),
			body: JSON.stringify({
				sessionId: NIL_UUID,
				ownerName: this.options.sessionOwner ?? "hobo-relay",
				agent: {
					id: jit.runner.agentId,
					name: jit.runner.agentName,
					version: this.runnerVersion,
					osDescription: "HoBo relay",
				},
				useFipsEncryption: false,
				brokerSession: true,
			}),
			contentType: "application/json",
			timeoutMs: this.callTimeoutMs,
			name: "session",
		});
		if (response.status === 409)
			throw new RunnerProtocolError(
				"another session already holds this runner",
				409,
			);
		if (!response.ok)
			throw new RunnerProtocolError(
				`the broker refused to open a session (${response.status})`,
				response.status,
			);
		const session = readProtocolJson(
			await response.text(),
			SESSION,
			"the session",
		);
		return new GithubRunnerSession(this, jit, token, session.sessionid);
	}

	/** A call with the runner's token, signing in again once when the service answers 401. */
	async authorized(token: RunnerToken, init: CallInit): Promise<Response> {
		const first = await this.send(init, await token.get());
		if (first.status !== 401) return first;
		token.drop();
		return this.send(init, await token.get());
	}

	/** One call with a deadline, retried once on a server error or a dropped connection. */
	async send(init: CallInit, bearer: string | undefined): Promise<Response> {
		if (!isGithubServiceUrl(init.url.href))
			throw new RunnerProtocolError(
				`the ${init.name} call would leave GitHub's hosts; it was not sent`,
				0,
			);
		for (let attempt = 1; ; attempt += 1) {
			const headers = new Headers({
				accept: "application/json",
				"user-agent": `HoBoRelay (actions-runner-protocol ${this.runnerVersion})`,
			});
			if (bearer !== undefined)
				headers.set("authorization", `Bearer ${bearer}`);
			if (init.contentType !== undefined)
				headers.set("content-type", init.contentType);
			try {
				const response = await this.fetcher(init.url, {
					method: init.method,
					headers,
					body: init.body ?? null,
					redirect: "error",
					signal: AbortSignal.timeout(init.timeoutMs),
				});
				if (response.status < 500 || attempt > 1) return response;
				await response.body?.cancel();
				this.emit({
					kind: "retried",
					call: init.name,
					status: response.status,
				});
			} catch (error) {
				if (error instanceof Error && isAbort(error))
					throw new RunnerProtocolError(
						`the ${init.name} call ran past its ${init.timeoutMs} ms deadline`,
						0,
						true,
						init.name,
					);
				if (attempt > 1)
					throw new RunnerProtocolError(
						`the ${init.name} call failed after a transport error`,
						0,
					);
				this.emit({ kind: "retried", call: init.name, status: 0 });
			}
		}
	}
}
