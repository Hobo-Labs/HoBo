import { Buffer } from "node:buffer";
import {
	createPublicKey,
	createVerify,
	generateKeyPairSync,
	type KeyObject,
	randomUUID,
} from "node:crypto";
import type { RelayJobMessage } from "@hobo/ci";
import { z } from "zod";
import { readProtocolJson } from "./json.js";
import { FORCE_TOKEN_REFRESH, RUNNER_JOB_REQUEST } from "./wire.js";

export const FAKE_BROKER_URL = "https://broker.actions.githubusercontent.com/";
export const FAKE_RUN_SERVICE_URL =
	"https://run-actions-3-azure-eastus.actions.githubusercontent.com/42/";
const FAKE_TOKEN_HOST = "https://vstoken.actions.githubusercontent.com";
const FAKE_PIPELINES_URL =
	"https://pipelinesghubeus1.actions.githubusercontent.com/fake/";

export type FakeRunnerCall =
	| "token"
	| "session"
	| "message"
	| "acknowledge"
	| "acquirejob"
	| "completejob"
	| "close";

export type FakeRunnerRequest = Readonly<{
	call: FakeRunnerCall | "unknown";
	method: string;
	url: string;
}>;

export type FakeCompletion = Readonly<{
	jobId: string;
	planId: string;
	conclusion: string;
	outputs: ReadonlyMap<string, string>;
	annotations: readonly Readonly<{ level: string; message: string }>[];
	runner: string;
}>;

type Runner = Readonly<{
	name: string;
	clientId: string;
	key: KeyObject;
	tokenUrl: string;
}>;

type Offer = Readonly<{
	messageType: string;
	body: string;
	requestId: string | undefined;
}>;

type QueuedJob = {
	readonly requestId: string;
	readonly job: string;
	readonly jobId: string;
	readonly planId: string;
	acquiredBy: string | undefined;
	completed: boolean;
};

const ASSERTION = z.object({
	iss: z.string(),
	sub: z.string(),
	aud: z.string(),
	exp: z.number(),
	nbf: z.number(),
	jti: z.string(),
});

const COMPLETE = z.object({
	planid: z.string(),
	jobid: z.string(),
	conclusion: z.string(),
	outputs: z.record(z.string(), z.object({ value: z.string() })).default({}),
	annotations: z
		.array(z.object({ level: z.string(), message: z.string() }))
		.default([]),
});

type ContextWire =
	| string
	| number
	| boolean
	| Readonly<{ t: 2; d: readonly Readonly<{ k: string; v: ContextWire }>[] }>;

function contextMap(
	entries: readonly (readonly [string, ContextWire])[],
): ContextWire {
	return { t: 2, d: entries.map(([k, v]) => ({ k, v })) };
}

function stepOf(
	uses: string,
	inputs: readonly Readonly<{ name: string; value: string }>[],
) {
	const at = uses.lastIndexOf("@");
	const target = at < 0 ? uses : uses.slice(0, at);
	const ref = at < 0 ? "" : uses.slice(at + 1);
	const parts = target.split("/");
	return {
		type: "action",
		reference:
			uses === ""
				? { type: "script" }
				: {
						type: "repository",
						name: parts.slice(0, 2).join("/"),
						ref,
						path: parts.slice(2).join("/"),
					},
		inputs: {
			type: 2,
			map: inputs.map((input) => ({ Key: input.name, Value: input.value })),
		},
	};
}

export function agentJobRequestOf(message: RelayJobMessage, requestId: number) {
	const event: (readonly [string, ContextWire])[] = [
		["repository", contextMap([["private", message.private]])],
	];
	if (message.triggeringActorId !== "")
		event.push([
			"sender",
			contextMap([["id", Number(message.triggeringActorId)]]),
		]);
	if (message.fork)
		event.push([
			"pull_request",
			contextMap([
				[
					"head",
					contextMap([
						[
							"repo",
							contextMap([
								["fork", true],
								["full_name", "fork-owner/app"],
							]),
						],
					]),
				],
			]),
		]);
	return {
		messageType: "PipelineAgentJobRequest",
		plan: { planId: message.planId, planType: "actions", version: 1 },
		timeline: { id: randomUUID() },
		jobId: message.jobId,
		jobDisplayName: message.job,
		jobName: message.job,
		requestId,
		lockedUntil: "0001-01-01T00:00:00",
		billingOwnerId: "fake-billing-owner",
		contextData: {
			github: contextMap([
				["repository", message.repository],
				["run_id", String(message.runId)],
				["run_attempt", String(message.runAttempt)],
				["job", message.job],
				["event_name", message.event],
				["actor_id", message.actorId],
				["workflow_ref", message.workflowRef],
				["event", contextMap(event)],
			]),
			inputs: contextMap(
				message.inputs.map((input) => [input.name, input.value] as const),
			),
		},
		steps: message.steps.map((step) => stepOf(step.uses, step.inputs)),
	};
}

function json<T>(status: number, body: T | undefined): Response {
	return body === undefined
		? new Response(null, { status })
		: new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
}

export type FakeRunnerServiceOptions = Readonly<{
	nowMs?: () => number;
	tokenTtlSeconds?: number;
}>;

export class FakeGithubRunnerService {
	readonly requests: FakeRunnerRequest[] = [];
	readonly completions: FakeCompletion[] = [];
	onCompleted: ((completion: FakeCompletion) => void) | undefined;
	private readonly runners = new Map<string, Runner>();
	private readonly tokens = new Map<
		string,
		Readonly<{ runner: Runner; expiresAtMs: number }>
	>();
	private readonly sessions = new Map<string, Runner>();
	private readonly offers: Offer[] = [];
	private readonly jobs = new Map<string, QueuedJob>();
	private readonly failures = new Map<FakeRunnerCall, number[]>();
	private readonly clock: () => number;
	private readonly tokenTtlMs: number;
	private nextRequest = 1;

	constructor(options: FakeRunnerServiceOptions = {}) {
		this.clock = options.nowMs ?? Date.now;
		this.tokenTtlMs = (options.tokenTtlSeconds ?? 3600) * 1000;
	}

	jitConfig(runnerName: string, clientId: string = randomUUID()): string {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const jwk = privateKey.export({ format: "jwk" });
		const b64 = (value: string | undefined) =>
			Buffer.from(value ?? "", "base64url").toString("base64");
		const tokenUrl = `${FAKE_TOKEN_HOST}/_apis/oauth2/token/${clientId}`;
		this.runners.set(clientId, {
			name: runnerName,
			clientId,
			key: createPublicKey(privateKey),
			tokenUrl,
		});
		const file = <T>(value: T) =>
			Buffer.from(JSON.stringify(value)).toString("base64");
		return Buffer.from(
			JSON.stringify({
				".runner": file({
					AgentId: String(this.runners.size),
					AgentName: runnerName,
					PoolId: 1,
					PoolName: "Default",
					ServerUrl: FAKE_PIPELINES_URL,
					GitHubUrl: "",
					WorkFolder: "_work",
					UseV2Flow: true,
					ServerUrlV2: FAKE_BROKER_URL,
				}),
				".credentials": file({
					Scheme: "OAuth",
					Data: {
						ClientId: clientId,
						AuthorizationUrl: tokenUrl,
						RequireFipsCryptography: "True",
					},
				}),
				".credentials_rsaparams": file({
					d: b64(jwk.d),
					dp: b64(jwk.dp),
					dq: b64(jwk.dq),
					exponent: b64(jwk.e),
					inverseQ: b64(jwk.qi),
					modulus: b64(jwk.n),
					p: b64(jwk.p),
					q: b64(jwk.q),
				}),
			}),
		).toString("base64");
	}

	queue(
		message: RelayJobMessage,
		options: Readonly<{
			shouldAcknowledge?: boolean;
			rewriteJob?: (json: string) => string;
		}> = {},
	): string {
		const requestId = String(this.nextRequest);
		this.nextRequest += 1;
		const job = JSON.stringify(agentJobRequestOf(message, Number(requestId)));
		this.jobs.set(requestId, {
			requestId,
			job: options.rewriteJob ? options.rewriteJob(job) : job,
			jobId: message.jobId,
			planId: message.planId,
			acquiredBy: undefined,
			completed: false,
		});
		this.offers.push({
			messageType: RUNNER_JOB_REQUEST,
			requestId,
			body: JSON.stringify({
				id: requestId,
				runner_request_id: requestId,
				should_acknowledge: options.shouldAcknowledge ?? true,
				run_service_url: FAKE_RUN_SERVICE_URL,
				billing_owner_id: "fake-billing-owner",
			}),
		});
		return requestId;
	}

	queueMessage(messageType: string, body = ""): void {
		this.offers.push({ messageType, body, requestId: undefined });
	}

	forceTokenRefresh(): void {
		this.queueMessage(FORCE_TOKEN_REFRESH);
	}

	failNext(call: FakeRunnerCall, status: number): void {
		const queue = this.failures.get(call) ?? [];
		queue.push(status);
		this.failures.set(call, queue);
	}

	expireTokens(): void {
		this.tokens.clear();
	}

	serves(url: string): boolean {
		return (
			url.startsWith(FAKE_BROKER_URL) ||
			url.startsWith(FAKE_RUN_SERVICE_URL) ||
			url.startsWith(`${FAKE_TOKEN_HOST}/`)
		);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const response = await this.handle(request);
		if (!response)
			throw new TypeError(`fetch failed: ${request.url} is not served`);
		return response;
	};

	async handle(request: Request): Promise<Response | undefined> {
		if (!this.serves(request.url)) return undefined;
		const call = this.callOf(request);
		this.requests.push({ call, method: request.method, url: request.url });
		if (call === "unknown") return json(404, { error: "not found" });
		const failure = this.failures.get(call)?.shift();
		if (failure !== undefined)
			return json(failure, { error: `fake ${call} failure` });
		if (call === "token") return this.token(request);
		const runner = this.bearer(request);
		if (!runner) return json(401, { error: "unauthorized" });
		const url = new URL(request.url);
		const body = await request.text();
		if (call === "session") return this.openSession(runner);
		if (call === "close") {
			this.sessions.delete(url.searchParams.get("sessionId") ?? "");
			return json(200, undefined);
		}
		if (call === "message") return this.message(url, runner);
		if (call === "acknowledge") return this.acknowledge(body);
		if (call === "acquirejob") return this.acquire(body, runner);
		return this.complete(body, runner);
	}

	private callOf(request: Request): FakeRunnerCall | "unknown" {
		const url = new URL(request.url);
		if (request.url.startsWith(`${FAKE_TOKEN_HOST}/`))
			return request.method === "POST" ? "token" : "unknown";
		if (request.url.startsWith(FAKE_RUN_SERVICE_URL)) {
			if (url.pathname.endsWith("/acquirejob")) return "acquirejob";
			if (url.pathname.endsWith("/completejob")) return "completejob";
			return "unknown";
		}
		if (url.pathname === "/session")
			return request.method === "DELETE" ? "close" : "session";
		if (url.pathname === "/message" && request.method === "GET")
			return "message";
		if (url.pathname === "/acknowledge") return "acknowledge";
		return "unknown";
	}

	private bearer(request: Request): Runner | undefined {
		const header = request.headers.get("authorization") ?? "";
		const token = this.tokens.get(header.replace(/^Bearer /u, ""));
		if (!token || this.clock() >= token.expiresAtMs) return undefined;
		return token.runner;
	}

	private async token(request: Request): Promise<Response> {
		const form = new URLSearchParams(await request.text());
		if (form.get("grant_type") !== "client_credentials")
			return json(400, { error: "unsupported_grant_type" });
		if (
			form.get("client_assertion_type") !==
			"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
		)
			return json(400, { error: "invalid_request" });
		const [header, payload, signature] = (
			form.get("client_assertion") ?? ""
		).split(".");
		if (!header || !payload || !signature)
			return json(400, { error: "invalid_client" });
		const claims = readProtocolJson(
			Buffer.from(payload, "base64url").toString("utf8"),
			ASSERTION,
			"the client assertion",
		);
		const runner = this.runners.get(claims.sub);
		const nowS = Math.floor(this.clock() / 1000);
		if (
			!runner ||
			claims.iss !== runner.clientId ||
			claims.aud !== runner.tokenUrl ||
			request.url !== runner.tokenUrl ||
			claims.exp <= nowS ||
			claims.nbf > nowS + 60 ||
			!createVerify("RSA-SHA256")
				.update(`${header}.${payload}`)
				.verify(runner.key, Buffer.from(signature, "base64url"))
		)
			return json(400, { error: "invalid_client" });
		const accessToken = randomUUID();
		this.tokens.set(accessToken, {
			runner,
			expiresAtMs: this.clock() + this.tokenTtlMs,
		});
		return json(200, {
			access_token: accessToken,
			token_type: "bearer",
			expires_in: this.tokenTtlMs / 1000,
		});
	}

	private openSession(runner: Runner): Response {
		const sessionId = randomUUID();
		this.sessions.set(sessionId, runner);
		return json(200, { sessionId, ownerName: "fake", brokerSession: true });
	}

	private message(url: URL, runner: Runner): Response {
		const session = this.sessions.get(url.searchParams.get("sessionId") ?? "");
		if (session !== runner)
			return json(404, { errorKind: "RunnerSessionInvalid", statusCode: 404 });
		const offer = this.offers.shift();
		if (!offer) return json(202, undefined);
		return json(200, {
			messageId: this.nextRequest++,
			messageType: offer.messageType,
			body: offer.body,
		});
	}

	private acknowledge(body: string): Response {
		const id = readProtocolJson(
			body,
			z.object({ runnerrequestid: z.string() }),
			"the acknowledgement",
		).runnerrequestid;
		return this.jobs.has(id)
			? json(200, undefined)
			: json(404, { errorKind: "AcknowledgeJobNotFound", statusCode: 404 });
	}

	private acquire(body: string, runner: Runner): Response {
		const id = readProtocolJson(
			body,
			z.object({ jobmessageid: z.string() }),
			"the acquire request",
		).jobmessageid;
		const job = this.jobs.get(id);
		if (!job) return json(404, { code: 404, message: "job not found" });
		if (job.acquiredBy !== undefined)
			return json(409, { code: 409, message: "job already acquired" });
		job.acquiredBy = runner.name;
		return new Response(job.job, {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	private complete(body: string, runner: Runner): Response {
		const request = readProtocolJson(body, COMPLETE, "the completion");
		const job = [...this.jobs.values()].find(
			(entry) =>
				entry.jobId === request.jobid && entry.planId === request.planid,
		);
		if (!job || job.acquiredBy !== runner.name || job.completed)
			return json(404, { code: 404, message: "job not found" });
		job.completed = true;
		const completion: FakeCompletion = {
			jobId: request.jobid,
			planId: request.planid,
			conclusion: request.conclusion,
			outputs: new Map(
				Object.entries(request.outputs).map(([name, value]) => [
					name,
					value.value,
				]),
			),
			annotations: request.annotations,
			runner: runner.name,
		};
		this.completions.push(completion);
		this.onCompleted?.(completion);
		return json(200, undefined);
	}
}
