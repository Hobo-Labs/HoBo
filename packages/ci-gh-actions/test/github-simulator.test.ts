/**
 * The GitHub simulator the parity scenarios run against (ADR-0183): its
 * matching rule, webhooks, REST reads and writes, runner service and clock,
 * checked here so a scenario can trust what it reports.
 */
import { create } from "@bufbuild/protobuf";
import {
	type RelayJobAnswer,
	RelayJobAnswerSchema,
	type RelayJobMessage,
} from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { getRun } from "../src/github.js";
import {
	readRepositoryRunners,
	writeRoutingSlipCommit,
} from "../src/isolated-worker/routing-slip-issuer.js";
import { ROUTING_SLIP_REF } from "../src/routing-slip.js";
import {
	runnerServiceClientConformance,
	testJitConfig,
} from "../src/runner-protocol/port.js";
import { verifyWebhookSignature } from "../src/webhook-signature.js";
import {
	decodeSimulatedJitConfig,
	GithubSimulator,
	JOB_QUEUE_LIMIT_MS,
	RUNNER_SERVICE_PATH,
	SimulatedRunnerService,
	simulatorTransport,
} from "./support/github-simulator/index.js";
import type { GithubSimulatorPort } from "./support/github-simulator-port.js";

const REPO = "octo/app";

/** A webhook handler that keeps what it was sent. */
function recorder() {
	const seen: {
		event: string;
		delivery: string;
		body: string;
		valid: string;
	}[] = [];
	return {
		seen,
		handler(secret: string) {
			return async (request: Request) => {
				const body = await request.text();
				seen.push({
					event: request.headers.get("x-github-event") ?? "",
					delivery: request.headers.get("x-github-delivery") ?? "",
					body,
					valid: verifyWebhookSignature(
						secret,
						new TextEncoder().encode(body),
						request.headers.get("x-hub-signature-256") ?? undefined,
					),
				});
				return new Response(null, { status: 202 });
			};
		},
	};
}

function actionsOf(seen: readonly { event: string; body: string }[]) {
	return seen.map((delivery) => {
		const payload = JSON.parse(delivery.body);
		return `${delivery.event}:${payload.action}:${payload.workflow_job?.name ?? payload.workflow_run?.id}`;
	});
}

async function api(
	sim: GithubSimulator,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return sim.fetch(`${sim.baseUrl}${path}`, init);
}

function answer(
	jobId: string,
	planId: string,
	outputs: readonly (readonly [string, string])[],
	conclusion = "succeeded",
): RelayJobAnswer {
	return create(RelayJobAnswerSchema, {
		jobId,
		planId,
		conclusion,
		outputs: outputs.map(([name, value]) => ({ name, value })),
		annotations:
			conclusion === "failed"
				? [{ level: "error", message: "No runner in the order can take it." }]
				: [],
	});
}

describe("GithubSimulator", () => {
	it("implements the wave 0 simulator interface", () => {
		const port: GithubSimulatorPort = new GithubSimulator();
		expect(port.baseUrl).toMatch(/^https:\/\/.+\.invalid$/u);
		expect(port.webhookSecret.length).toBeGreaterThanOrEqual(32);
	});

	it("routes a relay job: queued, runner registered, claimed, completed with outputs, dependent queued on the output label", async () => {
		const sim = new GithubSimulator();
		const hooks = recorder();
		const relay = sim.queueJob({
			repository: REPO,
			name: "route",
			labels: ["hobo-relay"],
			inputs: new Map([["github", "ubuntu-24.04"]]),
		});
		const build = sim.queueJob({
			repository: REPO,
			name: "build",
			runId: relay.runId,
			labels: ["${{ needs.route.outputs.runner }}"],
			needs: ["route"],
		});
		expect(build.status).toBe("queued");
		// The dependent job is not on GitHub's lists until its needs finish.
		expect(sim.jobs().map((job) => job.name)).toEqual(["route"]);

		// The relay registers a one-job runner through the REST API.
		const registered = await api(
			sim,
			`/repos/${REPO}/actions/runners/generate-jitconfig`,
			{
				method: "POST",
				body: JSON.stringify({
					name: "hobo-relay-1",
					runner_group_id: 1,
					labels: ["hobo-relay"],
				}),
			},
		);
		expect(registered.status).toBe(201);
		const jit = await registered.json();
		expect(jit.runner).toMatchObject({
			name: "hobo-relay-1",
			status: "offline",
			busy: false,
			ephemeral: true,
		});
		const files = decodeSimulatedJitConfig(jit.encoded_jit_config);
		expect(files.runner.agentName).toBe("hobo-relay-1");
		expect(files.runner.serverUrl).toBe(
			`${sim.baseUrl}${RUNNER_SERVICE_PATH}/`,
		);

		// The runner signs in and is offered the job: it holds every label.
		const service = new SimulatedRunnerService(sim);
		const session = await service.open(testJitConfig("hobo-relay-1"));
		expect(sim.runners()[0]?.status).toBe("online");
		const message = await session.nextJob(1_000);
		if (!message) throw new Error("the runner was offered no job");
		const taken = message;
		expect(taken.repository).toBe(REPO);
		expect(taken.job).toBe("route");
		expect(taken.runId).toBe(relay.runId);
		expect(taken.inputs.map((input) => [input.name, input.value])).toEqual([
			["github", "ubuntu-24.04"],
		]);
		expect(sim.jobs()[0]).toMatchObject({
			status: "in_progress",
			runnerName: "hobo-relay-1",
		});

		sim.advance(800);
		await session.complete(
			answer(taken.jobId, taken.planId, [
				["runner", "ubuntu-24.04"],
				["outcome", "routed"],
			]),
		);
		const route = sim.jobs().find((job) => job.name === "route");
		expect(route).toMatchObject({ status: "completed", conclusion: "success" });
		expect(route?.outputs.get("runner")).toBe("ubuntu-24.04");
		expect(
			(route?.completedAtMs ?? 0) - (route?.queuedAtMs ?? 0),
		).toBeLessThanOrEqual(5_000);
		// An ephemeral runner is gone after its job.
		expect(sim.runners()).toEqual([]);

		const queued = sim.jobs().find((job) => job.name === "build");
		expect(queued).toMatchObject({
			status: "queued",
			labels: ["ubuntu-24.04"],
		});

		await sim.deliver(hooks.handler(sim.webhookSecret));
		expect(actionsOf(hooks.seen)).toEqual([
			"workflow_job:queued:route",
			"workflow_job:in_progress:route",
			"workflow_job:completed:route",
			"workflow_job:queued:build",
		]);
		expect(hooks.seen.every((delivery) => delivery.valid === "valid")).toBe(
			true,
		);
		await session.close();
	});

	it("offers a job only to a runner that holds every label it asks for", () => {
		const sim = new GithubSimulator();
		const job = sim.queueJob({
			repository: REPO,
			name: "test",
			labels: ["self-hosted", "Linux", "gpu"],
		});
		sim.registerRunner({ name: "plain", labels: ["linux"], repository: REPO });
		sim.registerRunner({
			name: "elsewhere",
			labels: ["linux", "gpu"],
			repository: "octo/other",
		});
		expect(sim.claim("plain")).toBeUndefined();
		expect(sim.claim("elsewhere")).toBeUndefined();
		sim.registerRunner({ name: "gpu", labels: ["LINUX", "gpu"], org: "octo" });
		const claimed = sim.claim("gpu");
		expect(claimed?.id).toBe(job.id);
		expect(sim.claim("gpu")).toBeUndefined();
	});

	it("skips a dependent job when the relay job fails, with its reason as an annotation", async () => {
		const sim = new GithubSimulator();
		const relay = sim.queueJob({
			repository: REPO,
			name: "route",
			labels: ["hobo-relay"],
		});
		sim.queueJob({
			repository: REPO,
			name: "build",
			runId: relay.runId,
			labels: ["${{ needs.route.outputs.runner }}"],
			needs: ["route"],
		});
		sim.registerRunner({ name: "relay", labels: ["hobo-relay"] });
		const session = await new SimulatedRunnerService(sim).open(
			testJitConfig("relay"),
		);
		const message = await session.nextJob(0);
		await session.complete(
			answer(message?.jobId ?? "", message?.planId ?? "", [], "failed"),
		);
		const [route, build] = sim.jobs();
		expect(route).toMatchObject({ conclusion: "failure" });
		expect(route?.annotations).toEqual(["No runner in the order can take it."]);
		expect(build).toMatchObject({ status: "completed", conclusion: "skipped" });

		const annotations = await (
			await api(sim, `/repos/${REPO}/check-runs/${route?.id}/annotations`)
		).json();
		expect(annotations).toEqual([
			expect.objectContaining({
				annotation_level: "failure",
				message: "No runner in the order can take it.",
			}),
		]);

		const hooks = recorder();
		await sim.deliver(hooks.handler(sim.webhookSecret));
		expect(actionsOf(hooks.seen)).toEqual([
			"workflow_job:queued:route",
			"workflow_job:in_progress:route",
			"workflow_job:completed:route",
			"workflow_job:completed:build",
			`workflow_run:completed:${relay.runId}`,
		]);
		const run = JSON.parse(hooks.seen[4]?.body ?? "{}");
		expect(run.workflow_run).toMatchObject({
			status: "completed",
			conclusion: "failure",
		});
		await session.close();
	});

	it("routes a three-leg matrix from one relay output", () => {
		const sim = new GithubSimulator();
		const relay = sim.queueJob({
			repository: REPO,
			name: "route",
			labels: ["hobo-relay"],
		});
		for (const leg of ["a", "b", "c"])
			sim.queueJob({
				repository: REPO,
				name: `test (${leg})`,
				runId: relay.runId,
				labels: ["${{needs.route.outputs.runner}}"],
				needs: ["route"],
			});
		sim.registerRunner({ name: "relay", labels: ["hobo-relay"] });
		const claimed = sim.claim("relay");
		sim.complete(claimed?.id ?? 0, {
			conclusion: "success",
			outputs: new Map([["runner", "hobo"]]),
		});
		const legs = sim.jobs().filter((job) => job.name.startsWith("test"));
		expect(legs.map((job) => [job.status, job.labels])).toEqual([
			["queued", ["hobo"]],
			["queued", ["hobo"]],
			["queued", ["hobo"]],
		]);
	});

	it("loses a dropped webhook and redelivers one by id", async () => {
		const sim = new GithubSimulator();
		sim.dropNextWebhook();
		sim.queueJob({ repository: REPO, name: "a", labels: ["x"] });
		sim.queueJob({ repository: REPO, name: "b", labels: ["x"] });
		const hooks = recorder();
		const responses = await sim.deliver(hooks.handler(sim.webhookSecret));
		expect(responses.map((response) => response.status)).toEqual([202]);
		expect(actionsOf(hooks.seen)).toEqual(["workflow_job:queued:b"]);
		expect(sim.deliveries().map((delivery) => delivery.dropped)).toEqual([
			true,
			false,
		]);
		// Nothing more waits.
		expect(await sim.deliver(hooks.handler(sim.webhookSecret))).toEqual([]);
		const first = hooks.seen[0]?.delivery ?? "";
		sim.redeliver(first);
		await sim.deliver(hooks.handler(sim.webhookSecret));
		expect(hooks.seen.map((delivery) => delivery.delivery)).toEqual([
			first,
			first,
		]);
		expect(hooks.seen[0]?.body).toBe(hooks.seen[1]?.body);
	});

	it("signs deliveries with the GitHub headers a relay reads", async () => {
		const sim = new GithubSimulator({ installationId: 77 });
		sim.queueJob({ repository: REPO, name: "a", labels: ["x"] });
		let request: Request | undefined;
		await sim.deliver(async (sent) => {
			request = sent;
			return new Response(null, { status: 200 });
		});
		expect(request?.method).toBe("POST");
		expect(request?.headers.get("content-type")).toBe("application/json");
		expect(request?.headers.get("user-agent")).toMatch(/^GitHub-Hookshot\//u);
		const payload = await request?.json();
		expect(payload).toMatchObject({
			action: "queued",
			installation: { id: 77 },
			repository: { full_name: REPO, private: true },
			workflow_job: { name: "a", labels: ["x"], status: "queued" },
		});
		expect(payload.repository.id).toBeGreaterThan(0);
		expect(payload.workflow_job.run_attempt).toBe(1);
	});

	it("owns its clock and cancels a job queued for 24 hours", async () => {
		const sim = new GithubSimulator({ startMs: Date.UTC(2026, 10, 16) });
		expect(sim.nowMs()).toBe(Date.UTC(2026, 10, 16));
		const job = sim.queueJob({ repository: REPO, name: "a", labels: ["x"] });
		sim.advance(JOB_QUEUE_LIMIT_MS - 1);
		expect(sim.jobs()[0]?.status).toBe("queued");
		sim.advance(1);
		expect(sim.jobs()[0]).toMatchObject({
			id: job.id,
			status: "completed",
			conclusion: "cancelled",
		});
		expect(() => sim.advance(-1)).toThrow();
	});

	it("cancels a run and frees the runner its job held", async () => {
		const sim = new GithubSimulator();
		const job = sim.queueJob({ repository: REPO, name: "a", labels: ["x"] });
		sim.queueJob({
			repository: REPO,
			name: "b",
			labels: ["x"],
			runId: job.runId,
		});
		sim.registerRunner({ name: "box", labels: ["x"] });
		sim.claim("box");
		expect(sim.runners()[0]?.busy).toBe(true);
		const response = await api(
			sim,
			`/repos/${REPO}/actions/runs/${job.runId}/cancel`,
			{ method: "POST" },
		);
		expect(response.status).toBe(202);
		expect(sim.jobs().map((entry) => entry.conclusion)).toEqual([
			"cancelled",
			"cancelled",
		]);
		expect(sim.runners()[0]?.busy).toBe(false);
	});

	it("re-runs failed jobs as a new attempt that keeps the passing ones", async () => {
		const sim = new GithubSimulator();
		const relay = sim.queueJob({
			repository: REPO,
			name: "route",
			labels: ["hobo-relay"],
		});
		sim.queueJob({
			repository: REPO,
			name: "build",
			runId: relay.runId,
			labels: ["${{ needs.route.outputs.runner }}"],
			needs: ["route"],
		});
		sim.registerRunner({ name: "relay", labels: ["hobo-relay"] });
		sim.registerRunner({ name: "fleet", labels: ["hobo"] });
		sim.complete(sim.claim("relay")?.id ?? 0, {
			conclusion: "success",
			outputs: new Map([["runner", "hobo"]]),
		});
		sim.complete(sim.claim("fleet")?.id ?? 0, {
			conclusion: "failure",
			log: "Error: the runner lost communication with the server",
		});

		const rerun = await api(
			sim,
			`/repos/${REPO}/actions/runs/${relay.runId}/rerun-failed-jobs`,
			{ method: "POST" },
		);
		expect(rerun.status).toBe(201);
		const latest = await (
			await api(sim, `/repos/${REPO}/actions/runs/${relay.runId}/jobs`)
		).json();
		expect(
			latest.jobs.map(
				(job: { name: string; status: string; run_attempt: number }) => [
					job.name,
					job.status,
					job.run_attempt,
				],
			),
		).toEqual([
			["route", "completed", 1],
			["build", "queued", 2],
		]);
		// The re-run job returns to the label the relay chose; the relay is not re-run.
		const again = sim.jobs().filter((job) => job.runAttempt === 2);
		expect(again.map((job) => [job.name, job.labels])).toEqual([
			["build", ["hobo"]],
		]);
		const run = await (
			await api(sim, `/repos/${REPO}/actions/runs/${relay.runId}`)
		).json();
		expect(run).toMatchObject({ run_attempt: 2, status: "queued" });
		const first = await (
			await api(sim, `/repos/${REPO}/actions/runs/${relay.runId}/attempts/1`)
		).json();
		expect(first).toMatchObject({ run_attempt: 1, conclusion: "failure" });

		const whole = await api(
			sim,
			`/repos/${REPO}/actions/runs/${relay.runId}/rerun`,
			{ method: "POST" },
		);
		expect(whole.status).toBe(403);
	});

	it("serves runs, attempts, jobs and logs as the existing readers parse them", async () => {
		const sim = new GithubSimulator();
		const job = sim.queueJob({
			repository: REPO,
			name: "lint",
			labels: ["ubuntu-24.04"],
			event: "pull_request",
			private: false,
		});
		sim.registerRunner({ name: "GitHub Actions 1", labels: ["ubuntu-24.04"] });
		sim.claim("GitHub Actions 1");
		sim.advance(61_000);
		sim.complete(job.id, {
			conclusion: "failure",
			log: "npm ERR! missing script: lint\n",
			steps: [
				{ name: "Set up job", conclusion: "success" },
				{ name: "Run npm run lint", conclusion: "failure" },
			],
		});

		const run = await getRun(simulatorTransport(sim), 1, REPO, job.runId);
		expect(run).toMatchObject({
			id: job.runId,
			run_attempt: 1,
			event: "pull_request",
			status: "completed",
			conclusion: "failure",
			repository: { private: false },
		});

		const runs = await (
			await api(sim, `/repos/${REPO}/actions/runs?status=failure&per_page=1`)
		).json();
		expect(runs.workflow_runs.map((entry: { id: number }) => entry.id)).toEqual(
			[job.runId],
		);
		const jobs = await (
			await api(
				sim,
				`/repos/${REPO}/actions/runs/${job.runId}/attempts/1/jobs?per_page=100`,
			)
		).json();
		expect(jobs.jobs[0]).toMatchObject({
			id: job.id,
			name: "lint",
			labels: ["ubuntu-24.04"],
			runner_name: "GitHub Actions 1",
			conclusion: "failure",
			steps: [
				{ name: "Set up job", number: 1, conclusion: "success" },
				{ name: "Run npm run lint", number: 2, conclusion: "failure" },
			],
		});
		const log = await api(sim, `/repos/${REPO}/actions/jobs/${job.id}/logs`);
		expect(log.status).toBe(200);
		expect(await log.text()).toBe("npm ERR! missing script: lint\n");
		const manual = await api(
			sim,
			`/repos/${REPO}/actions/jobs/${job.id}/logs`,
			{
				redirect: "manual",
			},
		);
		expect(manual.status).toBe(302);

		const repository = await (await api(sim, `/repos/${REPO}`)).json();
		expect(repository).toMatchObject({
			full_name: REPO,
			private: false,
			default_branch: "main",
		});
	});

	it("serves runners and their labels for a repository and an organization", async () => {
		const sim = new GithubSimulator();
		sim.registerRunner({ name: "mac", labels: ["macos"], repository: REPO });
		const org = await api(
			sim,
			"/orgs/octo/actions/runners/generate-jitconfig",
			{
				method: "POST",
				body: JSON.stringify({
					name: "org-1",
					runner_group_id: 1,
					labels: ["hobo-relay"],
				}),
			},
		);
		expect(org.status).toBe(201);
		const duplicate = await api(
			sim,
			"/orgs/octo/actions/runners/generate-jitconfig",
			{
				method: "POST",
				body: JSON.stringify({
					name: "org-1",
					runner_group_id: 1,
					labels: ["x"],
				}),
			},
		);
		expect(duplicate.status).toBe(409);
		const invalid = await api(
			sim,
			`/repos/${REPO}/actions/runners/generate-jitconfig`,
			{ method: "POST", body: JSON.stringify({ name: "n", labels: [] }) },
		);
		expect(invalid.status).toBe(422);

		const view = await readRepositoryRunners(
			simulatorTransport(sim),
			{ installationId: 1, repository: REPO },
			sim.nowMs(),
		);
		expect(view?.runners).toEqual([
			{
				name: "mac",
				online: true,
				busy: false,
				labels: ["self-hosted", "macos"],
			},
		]);
		const mac = sim.runners().find((runner) => runner.name === "mac");
		const base = `/repos/${REPO}/actions/runners/${mac?.id}/labels`;
		const added = await api(sim, base, {
			method: "POST",
			body: JSON.stringify({ labels: ["hobo-machine-mac"] }),
		});
		expect(added.status).toBe(200);
		expect(
			(await added.json()).labels.map(
				(label: { name: string; type: string }) => [label.name, label.type],
			),
		).toEqual([
			["self-hosted", "read-only"],
			["macos", "custom"],
			["hobo-machine-mac", "custom"],
		]);
		const one = await api(sim, `${base}/macos`, { method: "DELETE" });
		expect(one.status).toBe(200);
		const set = await api(sim, base, {
			method: "PUT",
			body: JSON.stringify({ labels: ["only"] }),
		});
		expect(
			(await set.json()).labels.map((label: { name: string }) => label.name),
		).toEqual(["self-hosted", "only"]);
		const cleared = await api(sim, base, { method: "DELETE" });
		expect(
			(await cleared.json()).labels.map(
				(label: { name: string }) => label.name,
			),
		).toEqual(["self-hosted"]);
		const removed = await api(
			sim,
			`/repos/${REPO}/actions/runners/${mac?.id}`,
			{
				method: "DELETE",
			},
		);
		expect(removed.status).toBe(204);
		const listed = await (
			await api(sim, "/orgs/octo/actions/runners?name=org-1")
		).json();
		expect(listed.total_count).toBe(1);
		expect(
			listed.runners[0].labels.map((label: { name: string }) => label.name),
		).toEqual(["self-hosted", "hobo-relay"]);
	});

	it("serves contents and the git ref and commit the routing slip uses", async () => {
		const sim = new GithubSimulator();
		sim.putFile(REPO, ".hobo/ci.json", '{"version":1}\n');
		const contents = await (
			await api(sim, `/repos/${REPO}/contents/.hobo%2Fci.json?ref=main`)
		).json();
		expect(contents).toMatchObject({
			encoding: "base64",
			path: ".hobo/ci.json",
		});
		expect(Buffer.from(contents.content, "base64").toString("utf8")).toBe(
			'{"version":1}\n',
		);
		expect(
			(await api(sim, `/repos/${REPO}/contents/missing.json`)).status,
		).toBe(404);

		expect(
			(await api(sim, `/repos/${REPO}/git/ref/hobo/routing-slip`)).status,
		).toBe(404);
		const transport = simulatorTransport(sim);
		const written = await writeRoutingSlipCommit(transport, {
			installationId: 1,
			repository: REPO,
			message: "slip one",
		});
		expect(written.ok).toBe(true);
		const again = await writeRoutingSlipCommit(transport, {
			installationId: 1,
			repository: REPO,
			message: "slip two",
			treeSha: written.ok ? written.treeSha : undefined,
		});
		expect(again.ok).toBe(true);
		const ref = await (
			await api(sim, `/repos/${REPO}/git/ref/hobo/routing-slip`)
		).json();
		expect(ref).toMatchObject({
			ref: ROUTING_SLIP_REF,
			object: { type: "commit" },
		});
		const commit = await (
			await api(sim, `/repos/${REPO}/git/commits/${ref.object.sha}`)
		).json();
		expect(commit).toMatchObject({ message: "slip two", parents: [] });
		const head = await (
			await api(sim, `/repos/${REPO}/git/ref/heads/main`)
		).json();
		expect(head.object.sha).toMatch(/^[0-9a-f]{40}$/u);
	});

	it("serves billing usage for a user and an organization, filtered by month", async () => {
		const sim = new GithubSimulator();
		const item = {
			date: "2026-11-02T00:00:00Z",
			product: "actions",
			sku: "actions_linux",
			quantity: 120,
			unitType: "minutes",
			pricePerUnit: 0.006,
			grossAmount: 0.72,
			discountAmount: 0.72,
			netAmount: 0,
			repositoryName: REPO,
		};
		sim.addBillingUsage("user", "octo", item);
		sim.addBillingUsage("user", "octo", {
			...item,
			date: "2026-10-30T00:00:00Z",
		});
		sim.addBillingUsage("organization", "acme", item);
		const november = await (
			await api(sim, "/users/octo/settings/billing/usage?year=2026&month=11")
		).json();
		expect(november.usageItems).toEqual([item]);
		const all = await (
			await api(sim, "/users/octo/settings/billing/usage")
		).json();
		expect(all.usageItems).toHaveLength(2);
		const org = await (
			await api(sim, "/organizations/acme/settings/billing/usage?year=2026")
		).json();
		expect(org.usageItems).toEqual([{ ...item, organizationName: "acme" }]);
	});

	it("records every request so a scenario can show what was never asked for", async () => {
		const sim = new GithubSimulator();
		const job = sim.queueJob({ repository: REPO, name: "a", labels: ["x"] });
		await api(sim, `/repos/${REPO}/actions/jobs/${job.id}`, {
			headers: { authorization: "Bearer test" },
		});
		await api(sim, "/nowhere");
		expect(sim.requests()).toEqual([
			expect.objectContaining({
				method: "GET",
				path: `/repos/${REPO}/actions/jobs/${job.id}`,
				status: 200,
				authorized: true,
			}),
			expect.objectContaining({ path: "/nowhere", status: 404 }),
		]);
		expect(
			sim
				.requests()
				.some(
					(request) =>
						request.path.endsWith("/logs") ||
						request.path.includes("/contents/"),
				),
		).toBe(false);
		await expect(sim.fetch("https://api.github.com/zen")).rejects.toThrow(
			/network/u,
		);
	});

	it("mounts a runner service under its base URL and records what reaches it", async () => {
		const sim = new GithubSimulator();
		await expect(
			(await api(sim, `${RUNNER_SERVICE_PATH}/sessions`)).status,
		).toBe(501);
		sim.mountRunnerService(async (request, github) => {
			const path = new URL(request.url).pathname;
			return Response.json({ path, runners: github.runners().length });
		});
		const response = await api(sim, `${RUNNER_SERVICE_PATH}/sessions`, {
			method: "POST",
		});
		expect(await response.json()).toEqual({
			path: `${RUNNER_SERVICE_PATH}/sessions`,
			runners: 0,
		});
		expect(sim.requests().at(-1)).toMatchObject({
			area: "runner-service",
			method: "POST",
		});
	});

	it("passes the wave 0 runner service conformance", async () => {
		await runnerServiceClientConformance(
			() => {
				const sim = new GithubSimulator();
				const jit = testJitConfig("conformance");
				sim.registerRunner({ name: "conformance", labels: ["hobo-relay"] });
				return {
					client: new SimulatedRunnerService(sim),
					jit,
					queue: (message) => {
						sim.queueRelayMessage(message, ["hobo-relay"]);
					},
				};
			},
			{
				message: (jobId) => ({
					...sampleMessage(),
					jobId,
				}),
				answer: (jobId) => answer(jobId, "plan", [["runner", "hobo"]]),
			},
		);
	});

	it("refuses a session for a runner it never registered", async () => {
		const sim = new GithubSimulator();
		await expect(
			new SimulatedRunnerService(sim).open(testJitConfig("ghost")),
		).rejects.toThrow(/ghost/u);
	});
});

function sampleMessage(): RelayJobMessage {
	const sim = new GithubSimulator();
	const job = sim.queueJob({ repository: REPO, name: "route", labels: ["r"] });
	return sim.relayJobMessage(job.id);
}
