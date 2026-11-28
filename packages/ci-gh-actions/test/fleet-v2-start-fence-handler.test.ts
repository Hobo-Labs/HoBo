import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	createStartFenceHandler,
	type StartFencePolicy,
} from "../src/fleet-v2/start-fence-handler.js";
import { type GithubTransport, githubApiUrl } from "../src/github.js";
import { createRelayHandler } from "../src/http-handler.js";

const now = "2026-11-03T00:00:00Z";
const secret = "a".repeat(64);
const policy: StartFencePolicy = {
	accountId: "hobo-labs",
	engineId: "gh-actions",
	installationId: 10,
	profileId: "trusted-linux-x64",
	runnerGroupId: 7,
	requiredLabels: ["self-hosted", "trusted-linux-x64"],
	repositories: [{ id: 101, name: "owner/repository" }],
};
const githubJob = {
	kind: "github-job",
	accountId: "hobo-labs",
	engineId: "gh-actions",
	installationId: "10",
	repositoryId: "101",
	runId: "900",
	jobId: "1",
	runAttempt: 1,
};
const executionKey = { githubJob };
const payload = {
	slotId: "slot-1",
	claimId: "claim-1",
	bindingSecret: secret,
	accountId: "hobo-labs",
	runnerName: "hobo-slot-1",
	profileId: "trusted-linux-x64",
	executionKey,
};
const assignedJob = {
	id: 1,
	run_id: 900,
	run_attempt: 1,
	status: "in_progress",
	runner_id: 44,
	runner_name: "hobo-slot-1",
	runner_group_id: 7,
	labels: ["self-hosted", "trusted-linux-x64"],
};
let store: SqliteStrictFleetStore;
let githubServer: ReturnType<typeof createServer>;
let githubOrigin: string;
let jobs: (typeof assignedJob)[];
let githubRequests: number;
let githubStatus: number;

const github: GithubTransport = {
	async request(installationId, path) {
		if (installationId !== 10) throw new Error("wrong installation");
		const url = new URL(githubApiUrl(path));
		return fetch(`${githubOrigin}${url.pathname}${url.search}`);
	},
};

beforeAll(async () => {
	githubServer = createServer((request, response) => {
		githubRequests++;
		const url = new URL(request.url ?? "/", githubOrigin);
		response.setHeader("content-type", "application/json");
		if (githubStatus !== 200) {
			response.writeHead(githubStatus).end("{}");
			return;
		}
		if (url.pathname === "/repos/owner/repository") {
			response.end(JSON.stringify({ id: 101 }));
		} else if (url.pathname.endsWith("/attempts/1/jobs")) {
			response.end(JSON.stringify({ total_count: jobs.length, jobs }));
		} else if (url.pathname.endsWith("/attempts/1")) {
			response.end(
				JSON.stringify({
					id: 900,
					run_attempt: 1,
					status: "in_progress",
					repository: { id: 101 },
				}),
			);
		} else response.writeHead(404).end("{}");
	});
	githubServer.listen(0, "127.0.0.1");
	await once(githubServer, "listening");
	const address = githubServer.address();
	if (!(address instanceof Object) || !("port" in address))
		throw new Error("server did not bind");
	githubOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolveClose, rejectClose) =>
		githubServer.close((error) =>
			error ? rejectClose(error) : resolveClose(),
		),
	);
});

beforeEach(async () => {
	jobs = [{ ...assignedJob }];
	githubRequests = 0;
	githubStatus = 200;
	store = new SqliteStrictFleetStore(":memory:");
	await store.initialize();
	await store.createIncarnation(
		parseControllerIncarnation(
			JSON.stringify({
				id: "incarnation-1",
				createdAt: now,
				reason: "bootstrap",
			}),
		),
	);
	await store.putExecutionProfile(
		parseExecutionProfile(
			JSON.stringify({
				id: "trusted-linux-x64",
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
			JSON.stringify({
				offerId: "offer-1",
				accountId: "hobo-labs",
				observationHash: "b".repeat(64),
				policyRevision: 1,
				state: "active",
			}),
		),
	);
	await store.putCapacityGroup(
		parseCapacityGroup(
			JSON.stringify({
				id: "device-1",
				accountId: "hobo-labs",
				approvedUnits: 2,
				reservedUnits: 0,
				seq: 0,
				state: "active",
			}),
		),
	);
	await reserve("1", 44, "1", 0);
});

afterEach(() => store.close());

async function reserve(
	suffix: string,
	runnerId: number,
	jobId: string,
	sequence: number,
) {
	const key = { githubJob: { ...githubJob, jobId } };
	const parsedKey = parseExecutionKey(JSON.stringify(key));
	await store.intake(
		parseCiDemand(
			JSON.stringify({
				key,
				state: "observed",
				firstObservedAt: now,
				lastObservedAt: now,
				policyRevision: 1,
				requiredProfileId: "trusted-linux-x64",
				source: "webhook",
				sourceDeliveryIds: [`delivery-${suffix}`],
			}),
		),
	);
	const slot = parseRunnerSlot(
		JSON.stringify({
			id: `slot-${suffix}`,
			accountId: "hobo-labs",
			offerId: "offer-1",
			workerBindingId: `worker-${suffix}`,
			profileId: "trusted-linux-x64",
			runnerName: `hobo-slot-${suffix}`,
			state: "reserved",
			capacityGroupId: "device-1",
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
		JSON.stringify({
			id: `effect-${suffix}`,
			subjectType: "runner-slot",
			subjectId: slot.id,
			kind: "github.provision-runner",
			sequence: 1,
			state: "planned",
			idempotencyKey: `provision-${suffix}`,
			externalLocator: slot.runnerName,
			createdAt: now,
			providerScope: "github:10:101",
		}),
	);
	const outbox = parseOutbox(
		JSON.stringify({
			id: `outbox-${suffix}`,
			effectId: effect.id,
			state: "pending",
			availableAt: now,
			createdAt: now,
		}),
	);
	await store.reserveCapacity({
		demandKey: parsedKey,
		slot,
		effect,
		outbox,
		expectedCapacitySeq: sequence,
		expectedPolicyRevision: 1,
	});
	await store.transitionRunnerSlot(slot.id, "reserved", "provisioning");
	await store.transitionRunnerSlot(
		slot.id,
		"provisioning",
		"registered",
		String(runnerId),
	);
}

function relay(policies: readonly StartFencePolicy[] = [policy]) {
	const control = createStartFenceHandler({ store, github, policies });
	return createRelayHandler({
		webhookSecret: "w".repeat(32),
		application: {
			control,
			ingestWebhook: async () => "accepted",
			claim: async () => new Response(null, { status: 403 }),
			ready: async () => true,
		},
	});
}

function request(
	body: string,
	path = "/v1/fleet/start-fence",
	contentType = "application/json",
) {
	return new Request(`https://ci.example.test${path}`, {
		method: "POST",
		headers: { "content-type": contentType },
		body,
	});
}

describe("strict start-fence controller", () => {
	it("runs the pre-job hook through HTTPS and commits the actual GitHub assignment", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fence-e2e-"));
		const key = join(directory, "key.pem");
		const certificate = join(directory, "certificate.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-sha256",
				"-nodes",
				"-days",
				"1",
				"-keyout",
				key,
				"-out",
				certificate,
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost,IP:127.0.0.1",
			],
			{ stdio: "ignore" },
		);
		const handle = relay();
		const https = createHttpsServer(
			{ key: readFileSync(key), cert: readFileSync(certificate) },
			(incoming, outgoing) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("end", () => {
					const forwarded = new Request(
						"https://ci.example.test/v1/fleet/start-fence",
						{
							method: "POST",
							headers: {
								"content-type": incoming.headers["content-type"] ?? "",
							},
							body: Buffer.concat(chunks),
						},
					);
					void handle(forwarded).then(async (result) => {
						outgoing.writeHead(
							result.status,
							Object.fromEntries(result.headers),
						);
						outgoing.end(await result.text());
					});
				});
			},
		);
		try {
			https.listen(0, "127.0.0.1");
			await once(https, "listening");
			const address = https.address();
			if (!(address instanceof Object) || !("port" in address))
				throw new Error("server did not bind");
			const child = spawn(
				"bash",
				[resolve("templates/fleet-pre-job-hook.sh")],
				{
					env: {
						PATH: process.env.PATH,
						NODE_EXTRA_CA_CERTS: certificate,
						HOBO_START_FENCE_URL: `https://127.0.0.1:${address.port}/v1/fleet/start-fence`,
						HOBO_SLOT_ID: payload.slotId,
						HOBO_CLAIM_ID: payload.claimId,
						HOBO_BINDING_SECRET: secret,
						HOBO_ACCOUNT_ID: payload.accountId,
						HOBO_PROFILE_ID: payload.profileId,
						HOBO_EXECUTION_KEY_JSON: JSON.stringify(executionKey),
						GITHUB_REPOSITORY: "owner/repository",
						GITHUB_RUN_ID: "900",
						GITHUB_RUN_ATTEMPT: "1",
						GITHUB_JOB: "build",
						RUNNER_NAME: payload.runnerName,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout.setEncoding("utf8").on("data", (text) => {
				output += text;
			});
			child.stderr.setEncoding("utf8").on("data", (text) => {
				output += text;
			});
			const [code] = await once(child, "close");
			expect(code).toBe(0);
			expect(output).not.toContain(secret);
			expect(
				await store.executionClaim(
					parseExecutionKey(JSON.stringify(executionKey)),
				),
			).toMatchObject({
				id: "claim-1",
				state: "start-authorized",
			});
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				https.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("commits the verified claim before returning a matching receipt and handles retries", async () => {
		const handle = relay();
		const first = await handle(request(JSON.stringify(payload)));
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		expect(await first.json()).toEqual({
			authorized: true,
			slotId: "slot-1",
			claimId: "claim-1",
			accountId: "hobo-labs",
			profileId: "trusted-linux-x64",
			runnerName: "hobo-slot-1",
			executionKey,
		});
		expect(
			await store.executionClaim(
				parseExecutionKey(JSON.stringify(executionKey)),
			),
		).toMatchObject({
			id: "claim-1",
			runnerSlotId: "slot-1",
			state: "start-authorized",
		});
		expect((await handle(request(JSON.stringify(payload)))).status).toBe(200);
		expect(
			(await store.events()).filter(
				(event) => event.type === FleetEventType.EXECUTION_START_AUTHORIZED,
			),
		).toHaveLength(1);
	});

	it("rejects bad credentials before querying GitHub", async () => {
		const result = await relay()(
			request(JSON.stringify({ ...payload, bindingSecret: "x".repeat(64) })),
		);
		expect(result.status).toBe(403);
		expect(githubRequests).toBe(0);
		expect(
			await store.executionClaim(
				parseExecutionKey(JSON.stringify(executionKey)),
			),
		).toBeUndefined();
	});

	it("does not return a retry receipt after the offer is revoked", async () => {
		const handle = relay();
		expect((await handle(request(JSON.stringify(payload)))).status).toBe(200);
		await store.putOfferAdmission(
			parseOfferAdmission(
				JSON.stringify({
					offerId: "offer-1",
					accountId: "hobo-labs",
					observationHash: "b".repeat(64),
					policyRevision: 1,
					state: "revoked",
				}),
			),
		);
		expect((await handle(request(JSON.stringify(payload)))).status).toBe(409);
	});

	it("rejects foreign runner assignments, forged jobs, and unknown policies", async () => {
		jobs = [{ ...assignedJob, runner_group_id: 8 }];
		expect((await relay()(request(JSON.stringify(payload)))).status).toBe(403);
		jobs = [{ ...assignedJob }];
		const forged = {
			...payload,
			executionKey: { githubJob: { ...githubJob, jobId: "2" } },
		};
		expect((await relay()(request(JSON.stringify(forged)))).status).toBe(403);
		expect((await relay([])(request(JSON.stringify(payload)))).status).toBe(
			403,
		);
		expect(
			await store.executionClaim(
				parseExecutionKey(JSON.stringify(executionKey)),
			),
		).toBeUndefined();
	});

	it("rejects both duplicate policies and unavailable GitHub verification", async () => {
		expect(
			(await relay([policy, policy])(request(JSON.stringify(payload)))).status,
		).toBe(403);
		githubStatus = 503;
		expect((await relay()(request(JSON.stringify(payload)))).status).toBe(503);
		expect(
			await store.executionClaim(
				parseExecutionKey(JSON.stringify(executionKey)),
			),
		).toBeUndefined();
	});

	it("authorizes at most one slot when conflicting assignments race", async () => {
		await reserve("2", 45, "2", 1);
		jobs.push({ ...assignedJob, runner_id: 45, runner_name: "hobo-slot-2" });
		const second = {
			...payload,
			slotId: "slot-2",
			runnerName: "hobo-slot-2",
			claimId: "claim-2",
		};
		const handle = relay();
		const results = await Promise.all([
			handle(request(JSON.stringify(payload))),
			handle(request(JSON.stringify(second))),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
		expect(
			(await store.events()).filter(
				(event) => event.type === FleetEventType.EXECUTION_START_AUTHORIZED,
			),
		).toHaveLength(1);
	});

	it("rejects invalid and oversized requests without consulting GitHub", async () => {
		const handle = relay();
		expect((await handle(request("{"))).status).toBe(400);
		expect(
			(
				await handle(
					request(
						JSON.stringify(payload),
						"/v1/fleet/start-fence",
						"text/plain",
					),
				)
			).status,
		).toBe(415);
		expect((await handle(request("x".repeat(17000)))).status).toBe(413);
		expect(
			(
				await handle(
					request(
						JSON.stringify(payload),
						"/v1/fleet/start-fence?unexpected=1",
					),
				)
			).status,
		).toBe(403);
		expect(githubRequests).toBe(0);
	});
});
