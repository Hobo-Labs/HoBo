import { createHmac } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	OfferSchema,
} from "@hobo/ci";

import type { GithubTransport } from "../src/github.js";
import type { GithubClaims, IdentityVerifier } from "../src/oidc.js";
import { Relay } from "../src/relay.js";
import { LeaseStore } from "../src/store.js";

export const NOW = "2026-10-26T12:00:00Z";
export const SHA = "a".repeat(40);
export const SECRET = "test-webhook-secret-at-least-32-chars";
export function config() {
	return create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "account-a",
				budgetMicros: 1000000,
				maxRuntimeMinutes: 9,
				startupMinutes: 1,
				offers: [
					create(OfferSchema, {
						id: "blacksmith-a",
						provider: "blacksmith",
						providerAccountId: "owned-blacksmith-account",
						enabled: true,
						runsOn: "blacksmith-2vcpu-ubuntu-2404",
						freeMinutes: 10,
						priceMicrosPerMinute: 4000,
						budgetMicros: 1000000,
						concurrency: 1,
						observedAt: "2026-10-26T00:00:00Z",
						validUntil: "2026-10-27T00:00:00Z",
						sourceUrl: "https://example.test/usage",
						bridgeAcknowledged: true,
					}),
				],
			}),
		],
		connections: [
			create(ConnectionSchema, {
				accountId: "account-a",
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				bridgeWorkflow: "host.yml",
				bridgeSha: SHA,
				runnerGroupId: 1,
				allowedEvents: ["push"],
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
				bridgeRef: "hobo-ci-v1",
				dispatcherActorId: 123,
			}),
		],
	});
}
function noRunner(): string | null {
	return null;
}
export function queued(id = 1) {
	return {
		action: "queued",
		installation: { id: 10 },
		repository: { id: 101, full_name: "org/repo" },
		workflow_job: {
			id,
			run_id: 11,
			run_attempt: 1,
			labels: ["hobo"],
			runner_name: noRunner(),
		},
	};
}
export function job(id = 1) {
	return create(JobSchema, {
		id,
		runId: 11,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "org/repo",
		labels: ["hobo"],
		action: "queued",
	});
}
export function signed(payload: ReturnType<typeof queued>) {
	const body = Buffer.from(JSON.stringify(payload));
	return {
		body,
		signature: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
	};
}
export function run() {
	return {
		id: 11,
		run_attempt: 1,
		event: "push",
		head_sha: SHA,
		head_branch: "main",
		actor: { id: 123 },
		path: ".github/workflows/test.yml",
		display_title: "CI",
		status: "in_progress",
		conclusion: null,
		run_started_at: NOW,
		updated_at: "2026-10-26T12:01:00Z",
		repository: { id: 101, private: true },
		head_repository: { id: 101 },
	};
}
export function claims(): GithubClaims {
	return {
		iss: "https://token.actions.githubusercontent.com",
		aud: "https://relay.example",
		exp: 1793016600,
		nbf: 1793016000,
		iat: 1793016000,
		repository_id: "101",
		repository: "org/repo",
		run_id: "22",
		run_attempt: "1",
		workflow_sha: SHA,
		workflow_ref: `org/repo/.github/workflows/host.yml@${SHA}`,
		event_name: "workflow_dispatch",
	};
}
export class ContractApi implements GithubTransport {
	original = run();
	host = {
		...run(),
		id: 22,
		event: "workflow_dispatch",
		path: ".github/workflows/host.yml",
		display_title: "",
	};
	jobStatus = "queued";
	/** The one label the original job asks for; the JIT runner must register with it. */
	jobLabel = "hobo";
	dispatches = 0;
	registrations = 0;
	deletes = 0;
	uncertain = false;
	invalidJit = false;
	deleteStatus = 204;
	leaseId = "";
	strictLeaseId = true;
	hostLabel = "blacksmith-2vcpu-ubuntu-2404";
	violations: string[] = [];
	private equal(actual: string, expected: string): void {
		if (actual !== expected) {
			this.violations.push(`expected ${expected}; received ${actual}`);
			throw new Error("contract mismatch");
		}
	}
	async request(
		installation: number,
		path: string,
		method = "GET",
		body?: string,
	): Promise<Response> {
		this.equal(String(installation), "10");
		if (method === "GET" && path === "/repos/org/repo/actions/runs/11")
			return Response.json(this.original);
		if (method === "GET" && path === "/repos/org/repo/actions/runs/22/jobs")
			return Response.json({
				jobs: [
					{
						name: "host",
						labels: [this.hostLabel],
						status: this.host.status,
						started_at: this.host.run_started_at,
						completed_at:
							this.host.status === "completed" ? this.host.updated_at : null,
					},
				],
			});
		if (method === "GET" && path.includes("/actions/workflows/host.yml/runs?"))
			return Response.json({
				workflow_runs: [{ id: 22, display_title: this.host.display_title }],
			});
		if (method === "GET" && path === "/repos/org/repo/actions/runs/22")
			return Response.json(this.host);
		if (
			method === "GET" &&
			/^\/repos\/org\/repo\/actions\/jobs\/\d+$/.test(path)
		)
			return Response.json({
				id: Number(path.split("/").at(-1)),
				run_id: 11,
				run_attempt: 1,
				status: this.jobStatus,
				labels: [this.jobLabel],
			});
		if (
			method === "POST" &&
			path === "/repos/org/repo/actions/workflows/host.yml/dispatches"
		) {
			this.dispatches += 1;
			if (!this.strictLeaseId)
				this.leaseId = String(JSON.parse(body ?? "null").inputs.lease_id);
			this.equal(
				JSON.stringify(JSON.parse(body ?? "null")),
				JSON.stringify({
					ref: "hobo-ci-v1",
					inputs: {
						lease_id: this.leaseId,
						runs_on: this.hostLabel,
						timeout_minutes: "10",
					},
				}),
			);
			if (this.uncertain)
				throw new Error("lost response after dispatch accepted");
			return new Response(null, { status: 204 });
		}
		if (
			method === "POST" &&
			path === "/repos/org/repo/actions/runners/generate-jitconfig"
		) {
			this.registrations += 1;
			this.equal(
				JSON.stringify(JSON.parse(body ?? "null")),
				JSON.stringify({
					name: `hobo-${this.leaseId}`,
					runner_group_id: 1,
					labels: [this.jobLabel],
					work_folder: "_hobo_work",
				}),
			);
			return Response.json(
				this.invalidJit
					? { bad: true }
					: {
							runner: { id: 42, name: `hobo-${this.leaseId}` },
							encoded_jit_config: "c2VjcmV0",
						},
				{ status: 201 },
			);
		}
		if (method === "DELETE" && path === "/repos/org/repo/actions/runners/42") {
			this.deletes += 1;
			return new Response(null, { status: this.deleteStatus });
		}
		this.violations.push(`unmatched contract: ${method} ${path}`);
		throw new Error(`unmatched contract: ${method} ${path}`);
	}
}
export function harness(path = ":memory:") {
	const store = new LeaseStore(path);
	const api = new ContractApi();
	const identityClaims = claims();
	const identity: IdentityVerifier = {
		async verify(token) {
			if (token !== "valid") throw new Error("bad identity");
			return identityClaims;
		},
	};
	const configuration = config();
	const clock = { now: NOW };
	const relay = new Relay({
		config: configuration,
		store,
		github: api,
		identity,
		webhookSecret: SECRET,
		now: () => clock.now,
	});
	return { store, api, relay, configuration, identityClaims, clock };
}
export async function reserve(h: ReturnType<typeof harness>, id = 1) {
	const request = signed(queued(id));
	const result = await h.relay.webhook(
		request.body,
		request.signature,
		"workflow_job",
	);
	const lease = h.store.all().find((entry) => entry.jobId === id);
	if (!lease) throw new Error(`missing lease: ${result}`);
	h.api.leaseId = lease.id;
	h.api.host.display_title = `HoBo lease ${lease.id}`;
	return lease;
}
