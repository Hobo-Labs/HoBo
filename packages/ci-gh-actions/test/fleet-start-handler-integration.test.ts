import { createHash } from "node:crypto";
import {
	FleetEventType,
	parseCapacityGroup,
	parseCiDemand,
	parseControllerIncarnation,
	parseEffect,
	parseExecutionKey,
	parseExecutionProfile,
	parseOfferAdmission,
	parseOutbox,
	parseRunnerSlot,
	SqliteStrictFleetStore,
} from "@hobo/ci/fleet-v2";
import { expect, it } from "vitest";
import { createStrictGithubAssignmentLookup } from "../src/fleet-v2/github-assignment.js";
import { createStartFenceHandler } from "../src/fleet-v2/start-handler.js";
import { createRelayHandler } from "../src/http-handler.js";

const now = "2026-11-03T00:00:00Z";
const secret = "x".repeat(64);
const executionKey = {
	githubJob: {
		kind: "github-job",
		accountId: "account",
		engineId: "gh-actions",
		installationId: "10",
		repositoryId: "101",
		runId: "9",
		jobId: "1",
		runAttempt: 1,
	},
};
const body = {
	slotId: "slot-1",
	claimId: "claim-1",
	bindingSecret: secret,
	accountId: "account",
	profileId: "profile",
	runnerName: "hobo-slot-1",
	executionKey,
};
const json = JSON.stringify;
const job = {
	id: 1,
	run_id: 9,
	run_attempt: 1,
	status: "in_progress",
	runner_id: 42,
	runner_group_id: 7,
	runner_name: "hobo-slot-1",
	labels: ["self-hosted", "hobo"],
};
const run = {
	id: 9,
	run_attempt: 1,
	event: "push",
	head_sha: "abc",
	head_branch: "main",
	path: ".github/workflows/ci.yml",
	display_title: "CI",
	status: "in_progress",
	conclusion: null,
	run_started_at: null,
	updated_at: "2026-01-01T00:00:00Z",
	actor: { id: 1 },
	repository: { id: 101, private: true },
	head_repository: { id: 101 },
};

async function initializedStore() {
	const store = new SqliteStrictFleetStore(":memory:");
	await store.initialize();
	await store.createIncarnation(
		parseControllerIncarnation(
			json({ id: "incarnation-1", createdAt: now, reason: "bootstrap" }),
		),
	);
	await store.putExecutionProfile(
		parseExecutionProfile(
			json({
				id: "profile",
				os: "linux",
				architecture: "x64",
				isolation: "trusted-process",
				lifecycle: "persistent-capacity",
				guarantee: "start-fenced",
			}),
		),
	);
	await store.putOfferAdmission(
		parseOfferAdmission(
			json({
				offerId: "offer",
				accountId: "account",
				observationHash: "b".repeat(64),
				policyRevision: 1,
				state: "active",
			}),
		),
	);
	await store.putCapacityGroup(
		parseCapacityGroup(
			json({
				id: "device",
				accountId: "account",
				approvedUnits: 1,
				reservedUnits: 0,
				seq: 0,
				state: "active",
			}),
		),
	);
	await store.intake(
		parseCiDemand(
			json({
				key: executionKey,
				state: "observed",
				firstObservedAt: now,
				lastObservedAt: now,
				policyRevision: 1,
				requiredProfileId: "profile",
				source: "webhook",
				sourceDeliveryIds: ["delivery"],
			}),
		),
	);
	const slot = parseRunnerSlot(
		json({
			id: "slot-1",
			accountId: "account",
			offerId: "offer",
			workerBindingId: "worker",
			profileId: "profile",
			runnerName: "hobo-slot-1",
			state: "reserved",
			capacityGroupId: "device",
			capacityCostUnits: 1,
			policyHash: "a".repeat(64),
			offerObservationHash: "b".repeat(64),
			quoteHash: "c".repeat(64),
			bindingSecretHash: createHash("sha256").update(secret).digest("hex"),
			incarnationId: "incarnation-1",
			createdAt: now,
		}),
	);
	const effect = parseEffect(
		json({
			id: "effect",
			subjectType: "runner-slot",
			subjectId: slot.id,
			kind: "github.provision-runner",
			sequence: 1,
			state: "planned",
			idempotencyKey: "provision",
			externalLocator: slot.runnerName,
			createdAt: now,
			providerScope: "github:10:101",
		}),
	);
	const outbox = parseOutbox(
		json({
			id: "outbox",
			effectId: effect.id,
			state: "pending",
			availableAt: now,
			createdAt: now,
		}),
	);
	await store.reserveCapacity({
		demandKey: parseExecutionKey(json(executionKey)),
		slot,
		effect,
		outbox,
		expectedCapacitySeq: 0,
		expectedPolicyRevision: 1,
	});
	await store.transitionRunnerSlot(slot.id, "reserved", "provisioning");
	await store.transitionRunnerSlot(slot.id, "provisioning", "registered", "42");
	return store;
}

it("routes a verified GitHub assignment through SQLite, with an idempotent receipt retry", async () => {
	const store = await initializedStore();
	try {
		let githubCalls = 0;
		const api = {
			async request(installationId: number, path: string) {
				expect(installationId).toBe(10);
				githubCalls++;
				if (path.includes("/actions/runs?"))
					return Response.json({ workflow_runs: [{ id: 9 }] });
				if (path.includes("/actions/runs/9/jobs?"))
					return Response.json({ jobs: [job] });
				if (path.endsWith("/actions/jobs/1")) return Response.json(job);
				if (path.endsWith("/actions/runs/9")) return Response.json(run);
				throw new Error(`unexpected request ${path}`);
			},
		};
		const scope = {
			installationId: 10,
			repository: "org/repo",
			repositoryId: 101,
			accountId: "account",
			engineId: "gh-actions",
			runnerId: 42,
			runnerGroupId: 7,
			runnerName: "hobo-slot-1",
			requiredLabels: ["self-hosted", "hobo"],
			inProgressRunLimit: 3,
		};
		const startFence = createStartFenceHandler({
			store,
			lookupForSlot: async () => createStrictGithubAssignmentLookup(api, scope),
		});
		const handle = createRelayHandler({
			webhookSecret: "webhook-secret-with-at-least-32-bytes",
			application: {
				ingestWebhook: async () => "accepted",
				claim: async () => Response.json({}),
				control: async () => undefined,
				ready: async () => true,
				startFence,
			},
		});
		const request = (value: typeof body) =>
			new Request("https://ci.example/v2/fleet/start-fence", {
				method: "POST",
				body: json(value),
			});
		const first = await handle(request(body));
		expect(first.status).toBe(200);
		const receipt = await first.text();
		expect(JSON.parse(receipt)).toMatchObject({
			authorized: true,
			slotId: body.slotId,
			claimId: body.claimId,
			executionKey,
		});
		expect(receipt).not.toContain(secret);
		const events = await store.events();
		expect(
			events.filter(
				(event) => event.type === FleetEventType.EXECUTION_START_AUTHORIZED,
			),
		).toHaveLength(1);
		expect((await handle(request(body))).status).toBe(200);
		expect(await store.events()).toEqual(events);
		expect(
			(await handle(request({ ...body, claimId: "another-claim" }))).status,
		).toBe(503);
		expect(await store.events()).toEqual(events);
		await store.completeExecution({
			claimId: body.claimId,
			state: "completed",
			teardownConfirmed: true,
		});
		expect((await handle(request(body))).status).toBe(503);
		expect(
			(await store.events()).filter(
				(event) => event.type === FleetEventType.EXECUTION_START_AUTHORIZED,
			),
		).toHaveLength(1);
		expect(githubCalls).toBeGreaterThan(0);
	} finally {
		store.close();
	}
});
