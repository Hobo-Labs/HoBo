import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { GithubTransport } from "./github.js";
import { getRun } from "./github.js";
import { signIngressForward } from "./ingress-forward.js";
import {
	assertRelayOriginAllowed,
	type CiWebhookRoutingContext,
	isForkPullRequestRun,
	loadCiProjectConfigDocument,
	parseCiProjectSelection,
	relayWebhookPath,
	resolveCiConfigRefForRun,
	resolveCiRelayRoute,
} from "./relay-routing.js";
import { verifyWebhookSignature } from "./webhook-signature.js";

const JobWebhook = z.object({
	action: z.enum(["queued", "in_progress", "completed"]),
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({
		id: z.number().int().positive(),
		full_name: z.string(),
	}),
	workflow_job: z.object({
		id: z.number().int().positive(),
		run_id: z.number().int().positive(),
		run_attempt: z.number().int().positive().optional(),
		labels: z.array(z.string()),
	}),
});

export interface CiProjectContentFetcher {
	readProjectJson(
		repository: string,
		ref: string,
		path: string,
	): Promise<string | undefined>;
}

export function createGithubCiProjectFetcher(
	github: GithubTransport,
	installationId: number,
): CiProjectContentFetcher {
	return {
		async readProjectJson(repository, ref, path) {
			const encoded = encodeURIComponent(path);
			const response = await github.request(
				installationId,
				`/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
			);
			if (response.status === 404) return undefined;
			if (!response.ok) throw new Error("project configuration unavailable");
			const payload = z
				.object({
					content: z.string(),
					encoding: z.literal("base64"),
				})
				.parse(await response.json());
			return Buffer.from(payload.content, "base64").toString("utf8");
		},
	};
}

async function readBody(
	request: IncomingMessage,
	limit: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += next.length;
		if (bytes > limit) throw new Error("body too large");
		chunks.push(next);
	}
	return Buffer.concat(chunks);
}

/** Stateless GitHub App webhook front door: route by repo config at event commit. */
export function createWebhookIngressHandler(options: {
	githubWebhookSecret: string;
	ingressForwardSecret: string;
	projectPath?: string;
	github: GithubTransport;
	fetch?: typeof fetch;
}) {
	if (options.githubWebhookSecret.length < 32)
		throw new Error("webhook secret too short");
	if (Buffer.byteLength(options.ingressForwardSecret, "utf8") < 32)
		throw new Error("ingress forward secret too short");
	const projectPath = options.projectPath ?? ".hobo/ci.json";
	const fetchImpl = options.fetch ?? fetch;

	return async (request: IncomingMessage, response: ServerResponse) => {
		const headers = { "cache-control": "no-store" };
		const json = (status: number, body: string) => {
			response.setHeader("content-type", "application/json");
			response.writeHead(status, headers).end(body);
		};
		if (request.method !== "POST" || request.url !== "/github/webhooks") {
			json(404, '{"error":"not found"}');
			return;
		}
		const signature = request.headers["x-hub-signature-256"];
		const event = request.headers["x-github-event"];
		const delivery = request.headers["x-github-delivery"];
		if (
			Array.isArray(signature) ||
			Array.isArray(event) ||
			Array.isArray(delivery) ||
			!signature ||
			!event ||
			!delivery
		) {
			json(401, '{"error":"signature required"}');
			return;
		}
		let raw: Buffer;
		try {
			raw = await readBody(request, 1024 * 1024);
		} catch {
			json(413, '{"error":"body too large"}');
			return;
		}
		if (
			verifyWebhookSignature(options.githubWebhookSecret, raw, signature) !==
			"valid"
		) {
			json(401, '{"error":"invalid signature"}');
			return;
		}
		if (event !== "workflow_job" && event !== "workflow_run") {
			json(202, JSON.stringify({ status: "ignored" }));
			return;
		}
		const payload = JSON.parse(raw.toString("utf8"));
		const PayloadIdentity = z.object({
			repository: z.object({ full_name: z.string() }),
			installation: z.object({ id: z.number().int().positive() }),
		});
		const identity = PayloadIdentity.safeParse(payload);
		if (!identity.success) {
			json(202, JSON.stringify({ status: "ignored" }));
			return;
		}
		const repository = identity.data.repository.full_name;
		const installationId = identity.data.installation.id;
		let context: CiWebhookRoutingContext | undefined;
		if (event === "workflow_job") {
			const parsed = JobWebhook.safeParse(payload);
			if (!parsed.success) {
				json(202, JSON.stringify({ status: "ignored" }));
				return;
			}
			const run = await getRun(
				options.github,
				parsed.data.installation.id,
				parsed.data.repository.full_name,
				parsed.data.workflow_job.run_id,
			);
			const isFork = isForkPullRequestRun(run, parsed.data.repository.id);
			const configRef = resolveCiConfigRefForRun(
				run,
				parsed.data.repository.id,
			);
			context = Object.freeze({
				repositoryFullName: parsed.data.repository.full_name,
				repositoryId: parsed.data.repository.id,
				installationId: parsed.data.installation.id,
				workflowRunId: parsed.data.workflow_job.run_id,
				eventName: run.event,
				headBranch: run.head_branch ?? undefined,
				headRef: run.head_branch ? `refs/heads/${run.head_branch}` : undefined,
				isForkPullRequest: isFork,
				configRef,
			});
		} else {
			const RunWebhook = z.object({
				repository: z.object({
					id: z.number().int().positive(),
					full_name: z.string(),
				}),
				installation: z.object({ id: z.number().int().positive() }),
				workflow_run: z.object({ id: z.number().int().positive() }),
			});
			const parsedRun = RunWebhook.safeParse(payload);
			if (!parsedRun.success) {
				json(202, JSON.stringify({ status: "ignored" }));
				return;
			}
			context = Object.freeze({
				repositoryFullName: parsedRun.data.repository.full_name,
				repositoryId: parsedRun.data.repository.id,
				installationId: parsedRun.data.installation.id,
				workflowRunId: parsedRun.data.workflow_run.id,
				eventName: "workflow_run",
				headBranch: undefined,
				headRef: undefined,
				isForkPullRequest: false,
				configRef: "HEAD",
			});
		}
		const fetchProject = createGithubCiProjectFetcher(
			options.github,
			installationId,
		);
		const committed = await fetchProject.readProjectJson(
			repository,
			context.configRef,
			projectPath,
		);
		if (!committed) {
			json(503, '{"error":"missing project configuration"}');
			return;
		}
		const document = JSON.parse(committed);
		const config = loadCiProjectConfigDocument(committed);
		const selection = parseCiProjectSelection(document);
		const route = resolveCiRelayRoute({
			config,
			selection,
			context,
		});
		assertRelayOriginAllowed(route, config);
		if (route.admission === "pull") {
			json(
				202,
				JSON.stringify({
					status: "poll-admission",
					environment: route.environment.name,
				}),
			);
			return;
		}
		const forward = signIngressForward(options.ingressForwardSecret, raw);
		const forwardTargets = [
			`${route.relayOrigin}${relayWebhookPath(route.engine)}`,
			`${route.relayOrigin}/github/webhooks`,
		];
		let relayResponse: Response | undefined;
		for (const target of forwardTargets) {
			try {
				relayResponse = await fetchImpl(target, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-github-event": event,
						"x-github-delivery": delivery,
						"x-hobo-ingress-forward": forward,
					},
					body: new Uint8Array(raw),
					redirect: "error",
					signal: AbortSignal.timeout(120_000),
				});
			} catch {
				json(502, '{"error":"relay forward failed"}');
				return;
			}
			if (relayResponse.status !== 404) break;
			void relayResponse.body?.cancel().catch(() => {});
			relayResponse = undefined;
		}
		if (!relayResponse) {
			json(502, '{"error":"relay forward failed"}');
			return;
		}
		void relayResponse.body?.cancel().catch(() => {});
		if (relayResponse.status !== 202) {
			json(502, '{"error":"relay rejected forward"}');
			return;
		}
		json(
			202,
			JSON.stringify({
				status: "forwarded",
				environment: route.environment.name,
			}),
		);
	};
}
