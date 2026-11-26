/** Explicit live lane. No credentials or permanent provider accounts are used.
 * Private provider replies stay outside the checkout; only hashed diagnostics
 * go to stdout. SQLite claims forbid replay after any uncertain allocation. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createBoundedFetchTransport,
	createClaimableOperationKeyDeriver,
	type JsonObject,
} from "../../packages/core/src/index.js";
import { createDurableHostingMutationJournal } from "../../packages/hobo/src/hosting-mutation-journal.js";
import * as cloudflare from "../../packages/providers/provider-cloudflare/src/index.js";
import * as lakebed from "../../packages/providers/provider-lakebed/src/index.js";
import * as neon from "../../packages/providers/provider-neon/src/index.js";
import * as netlify from "../../packages/providers/provider-netlify/src/index.js";
import * as prisma from "../../packages/providers/provider-prisma-postgres/src/index.js";
import * as upstash from "../../packages/providers/provider-upstash/src/index.js";
import { createRuntimeLocalEventStore } from "../../packages/runtimes/runtime-local/src/index.js";

export type AnonymousAcceptanceProvider =
	| "cloudflare"
	| "neon"
	| "upstash"
	| "prisma-postgres"
	| "netlify"
	| "lakebed";
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const repositoryRoot = realpathSync(
	fileURLToPath(new URL("../../", import.meta.url)),
);
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

/** Real SQLite persistence used by the live lane and its offline race tests. */
export async function openAnonymousAcceptanceRun(input: {
	readonly provider: AnonymousAcceptanceProvider;
	readonly stateDir: string;
	readonly clock?: () => number;
}) {
	const at = input.clock ?? Date.now;
	const provider = input.provider;
	await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
	const stateDir = await realpath(input.stateDir);
	if (
		stateDir === repositoryRoot ||
		stateDir.startsWith(`${repositoryRoot}${path.sep}`)
	)
		throw new Error("private acceptance state must be outside the checkout");
	const entries = await readdir(stateDir);
	if (entries.length && !entries.includes("run-id.txt"))
		throw new Error(
			"acceptance requires an empty dedicated directory or an existing acceptance run",
		);
	await chmod(stateDir, 0o700);
	const runFile = path.join(stateDir, "run-id.txt");
	try {
		const handle = await open(runFile, "wx", 0o600);
		try {
			await handle.writeFile(randomUUID());
			await handle.sync();
		} finally {
			await handle.close();
		}
		const directory = await open(stateDir, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		if (!existsSync(runFile)) throw error;
	}
	const runFileMetadata = await lstat(runFile);
	if (!runFileMetadata.isFile() || runFileMetadata.isSymbolicLink())
		throw new Error("private run identity must be a regular file");
	const runId = await readFile(runFile, "utf8");
	if (!UUID_V4.test(runId))
		throw new Error(
			"private acceptance run id is invalid; refusing allocation",
		);
	await chmod(runFile, 0o600);
	const hostKeyFile = path.join(stateDir, "host-key-v1.bin");
	try {
		const handle = await open(hostKeyFile, "wx", 0o600);
		try {
			await handle.writeFile(randomBytes(32));
			await handle.sync();
		} finally {
			await handle.close();
		}
		const directory = await open(stateDir, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		if (!existsSync(hostKeyFile)) throw error;
	}
	const hostKeyMetadata = await lstat(hostKeyFile);
	if (!hostKeyMetadata.isFile() || hostKeyMetadata.isSymbolicLink())
		throw new Error("manual host key must be a private regular file");
	await chmod(hostKeyFile, 0o600);
	const hostKey = await readFile(hostKeyFile);
	if (hostKey.byteLength !== 32)
		throw new Error("manual host key has an invalid size");
	const deriveOperationKey = createClaimableOperationKeyDeriver(hostKey);
	hostKey.fill(0);
	const privateDir = path.join(stateDir, provider);
	await mkdir(privateDir, { recursive: true, mode: 0o700 });
	if ((await realpath(privateDir)) !== privateDir)
		throw new Error(
			"private provider state may not redirect through a symlink",
		);
	await chmod(privateDir, 0o700);
	const journalDir = path.join(stateDir, "journal");
	await mkdir(journalDir, { recursive: true, mode: 0o700 });
	if ((await realpath(journalDir)) !== journalDir)
		throw new Error("private journal may not redirect through a symlink");
	const store = createRuntimeLocalEventStore({
		dataDir: journalDir,
	});
	const journal = createDurableHostingMutationJournal({
		store,
		tenantId: "anonymous-manual-acceptance",
		actor: { kind: "service", id: "anonymous-provider-acceptance" },
		fenceToken: 1n,
		nowMs: at,
	});
	const mutationId = `anonymous-acceptance:${runId}:${provider}`;
	const requestDigest = `sha256:${digest(JSON.stringify(["hobo.anonymous-hosting-acceptance/v1", runId, provider]))}`;
	async function writePrivate<T>(filename: string, value: T): Promise<void> {
		if (!/^[a-z0-9][a-z0-9.-]{0,100}$/u.test(filename))
			throw new Error("invalid private acceptance filename");
		const encoded = JSON.stringify(value, null, 2);
		if (encoded === undefined)
			throw new Error("private provider reply has no JSON representation");
		const handle = await open(path.join(privateDir, filename), "wx", 0o600);
		try {
			await handle.writeFile(encoded);
			await handle.sync();
		} finally {
			await handle.close();
		}
		const directory = await open(privateDir, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	return {
		runId,
		privateDir,
		writePrivate,
		deriveOperationKey,
		close: () => store.close(),
		async once<T>(work: () => Promise<T>) {
			const claim = await journal.claim({ mutationId, requestDigest });
			if (claim.status !== "claimed")
				return { status: "not-replayed" as const, previousState: claim.status };
			try {
				const value = await work();
				await journal.acknowledge(mutationId, requestDigest);
				return { status: "completed" as const, value };
			} catch (error) {
				await journal.uncertain(mutationId, requestDigest);
				await writePrivate(
					"failure.json",
					error instanceof Error
						? { name: error.name, message: error.message }
						: { message: "non-Error provider failure" },
				);
				return { status: "uncertain" as const };
			}
		},
	};
}

type AcceptanceRun = Awaited<ReturnType<typeof openAnonymousAcceptanceRun>>;

function fileCustody(run: AcceptanceRun) {
	const material = new Map<string, string>();
	let sequence = 0;
	return {
		async deposit(
			value: string,
			scope: {
				readonly providerId: string;
				readonly resourceRef: string;
				readonly purpose: string;
			},
		) {
			sequence += 1;
			const ref = `hobo-secret://manual/${run.runId}/secret-${sequence}`;
			await run.writePrivate(`secret-${sequence}.json`, { ref, value, scope });
			material.set(ref, value);
			return ref;
		},
		async resolve(ref: string) {
			const value = material.get(ref);
			if (value === undefined)
				throw new Error("unknown private custody reference");
			return value;
		},
	};
}

function anonymousProcessEnvironment(cliHome: string) {
	const env: Record<string, string> = {};
	for (const key of [
		"PATH",
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"https_proxy",
		"http_proxy",
		"all_proxy",
		"no_proxy",
		"NODE_EXTRA_CA_CERTS",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_USE_ENV_PROXY",
		"npm_config_cache",
		"TMPDIR",
		"SystemRoot",
		"COMSPEC",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.HOME = cliHome;
	env.USERPROFILE = cliHome;
	env.XDG_CONFIG_HOME = path.join(cliHome, "config");
	env.XDG_DATA_HOME = path.join(cliHome, "data");
	return env;
}

async function acceptCloudflare(
	run: AcceptanceRun,
	fetchImpl: typeof fetch,
): Promise<JsonObject> {
	const account = await cloudflare.solveAndProvisionAccount(
		cloudflare.createCloudflareTemporaryAccountTransport(fetchImpl),
	);
	await run.writePrivate("native-account.json", account);
	const apiToken = account.apiToken;
	const resolver = cloudflare
		.cloudflareResolverRegistry({
			accountId: account.accountId,
			resolveCredential: async () => apiToken,
		})
		.get(cloudflare.CLOUDFLARE_WORKERS_PRODUCT_ID);
	if (!resolver?.read)
		throw new Error(
			"Cloudflare generic Worker resolver requires independent observation",
		);
	const transport = createBoundedFetchTransport({ fetchImpl });
	const scriptName = `hobo-budget-${run.runId}`;
	const marker = "hobo-budget-generic-acceptance";
	const script = `export default { async fetch() { return new Response("${marker}", {headers:{"content-type":"text/plain"}}); } };`;
	const request = {
		ref: {
			slot: "service" as const,
			productId: cloudflare.CLOUDFLARE_WORKERS_PRODUCT_ID,
			logicalId: scriptName,
			physicalId: scriptName,
		},
		desired: {
			name: scriptName,
			script,
			mainModule: "worker.js",
			compatibilityDate: "2026-10-29",
			workersDev: true,
		},
		credentialRef: "hobo-secret://manual/cloudflare-api-token",
	};
	const createRequest = {
		...request,
		ref: {
			slot: "service" as const,
			productId: request.ref.productId,
			logicalId: scriptName,
		},
	};
	let createConfirmed = false;
	let observation: JsonObject = {};
	try {
		const created = await resolver.reconcile(createRequest, transport);
		createConfirmed = true;
		await run.writePrivate("native-create.json", created);
		const observed = await resolver.read(
			{ ...request, ref: { ...request.ref, physicalId: created.physicalId } },
			transport,
		);
		await run.writePrivate("native-observation.json", observed ?? null);
		const expectedDigest = `sha256:${digest(script)}`;
		if (
			!observed ||
			observed.outputs.ready !== true ||
			observed.outputs.operationConfirmed !== true ||
			observed.outputs.artifactDigest !== expectedDigest
		)
			throw new Error(
				"Cloudflare generic Worker artifact/readiness was not confirmed",
			);
		const response = await transport({
			method: "GET",
			url: new URL(String(observed.outputs.servingEndpoint)).toString(),
			headers: {},
			timeoutMs: 20000,
			maxResponseBytes: 1024 * 1024,
		});
		await run.writePrivate("serving-response.json", response);
		observation = {
			provider: "cloudflare",
			resourceHash: digest(created.physicalId),
			artifactDigest: expectedDigest,
			artifactObserved: true,
			httpStatus: response.status,
			expectedMarker: response.body === marker,
			dataPlaneValidated: response.status === 200 && response.body === marker,
			accountRetirementConfirmed: false,
		};
	} finally {
		await resolver.delete(request, transport);
		const after = await resolver.read(request, transport);
		const absence = after === undefined;
		const confirmed = absence && createConfirmed;
		await run.writePrivate("cleanup.json", {
			workerAbsenceObserved: absence,
			createConfirmed,
			workerAbsenceConfirmed: confirmed,
			observedAt: new Date().toISOString(),
		});
		observation = { ...observation, workerAbsenceConfirmed: confirmed };
	}
	return observation;
}

async function acceptNeon(
	run: AcceptanceRun,
	fetchImpl: typeof fetch,
): Promise<JsonObject> {
	const client = neon.createNeonClient({
		transport: neon.createFetchTransport({ fetchImpl }),
		store: neon.createInMemoryIdempotencyStore(),
		clock: Date.now,
		maxReadAttempts: 1,
	});
	const created = await client.createDatabase({
		ref: "hobo-budget-validation",
		idempotencyKey: `hobo:${run.runId}`,
	});
	await run.writePrivate("native-create.json", created);
	const observed = await client.getDatabase(created.response.databaseId);
	await run.writePrivate("native-observation.json", observed);
	let sqlValidated = false;
	if (created.response.connectionString) {
		const parts = neon.parsePostgresConnectionUri(
			created.response.connectionString,
		);
		if (!parts.host.endsWith(".neon.tech") || parts.port !== 5432)
			throw new Error("Neon SQL endpoint leaves its native authority");
		const response = await createBoundedFetchTransport({ fetchImpl })({
			method: "POST",
			url: `https://${parts.host}/sql`,
			headers: {
				"content-type": "application/json",
				"Neon-Connection-String": created.response.connectionString,
			},
			body: JSON.stringify({
				query: "SELECT 1 AS hobo_validation",
				params: [],
			}),
			timeoutMs: 20000,
			maxResponseBytes: 1024 * 1024,
		});
		await run.writePrivate("sql-response.json", response);
		sqlValidated =
			response.status === 200 && neon.confirmsNeonSqlProbe(response.body);
	}
	return {
		provider: "neon",
		resourceHash: digest(observed.databaseId),
		providerStatus: observed.status,
		sqlValidated,
		dataPlaneValidated: sqlValidated,
		expiresAt: observed.expiresAtIso,
		expirySource: "provider-reported",
		retirementConfirmed: false,
	};
}

async function acceptUpstash(
	run: AcceptanceRun,
	fetchImpl: typeof fetch,
): Promise<JsonObject> {
	const actual = upstash.createFetchTransport({ fetchImpl });
	const transport: upstash.UpstashTransport = {
		async request(request) {
			const response = await actual.request(request);
			if (
				request.method === "POST" &&
				request.url === upstash.UPSTASH_START_REDIS_URL
			)
				await run.writePrivate("native-create.json", response);
			return response;
		},
	};
	const custody = fileCustody(run);
	const client = upstash.createUpstashClient({
		transport,
		store: upstash.createInMemoryIdempotencyStore(),
		clock: Date.now,
		maxReadAttempts: 1,
	});
	const driver = upstash.createUpstashTemporaryRedisDriver({
		client,
		custody,
		clock: Date.now,
	});
	const nativeKey = await run.deriveOperationKey(
		{ tenantId: "manual", providerAccountId: "anonymous", scopeId: run.runId },
		{
			ref: {
				slot: "kv",
				productId: "upstash.temporary-redis/v1",
				logicalId: "database",
			},
			desired: { idempotencyKey: run.runId },
			credentialRef: "hobo-secret://manual/host-key-v1",
		},
	);
	const record = await driver.provision({
		idempotencyKey: nativeKey,
		resourceRef: `hobo-budget-${run.runId}`,
	});
	await run.writePrivate("receipt.json", record);
	if (!record.credentialRef)
		throw new Error("Upstash native reply lacks a custody reference");
	const restRef = record.credentialRef;
	const executor = upstash.createUpstashRestExecutor({
		transport: actual,
		restEndpointUrl: record.restEndpointUrl,
		resolveToken: () => custody.resolve(restRef),
	});
	const ping = await executor.execute(["PING"]);
	await run.writePrivate("ping-response.json", ping);
	const metrics = await driver.observeMetrics(record.databaseId);
	await run.writePrivate("native-observation.json", metrics);
	return {
		provider: "upstash",
		resourceHash: digest(record.databaseId),
		pingValidated: ping.kind === "value" && ping.value === "PONG",
		dataPlaneValidated: ping.kind === "value" && ping.value === "PONG",
		nativeRedisUrlDeposited: record.redisProtocolUrlRef !== undefined,
		expiresAt: record.expiresAtIso,
		expirySource: "provider-reported",
		retirementConfirmed: false,
	};
}

async function acceptPrisma(run: AcceptanceRun): Promise<JsonObject> {
	const cliHome = path.join(run.privateDir, "cli-home");
	await mkdir(cliHome, { mode: 0o700 });
	const actual = prisma.createNodeProcessRunner();
	const runner: prisma.ProcessRunner = {
		async run(argv, options) {
			const result = await actual.run(argv, options);
			await run.writePrivate("native-cli-response.json", result);
			return result;
		},
	};
	try {
		const client = prisma.createPrismaClient({
			runner,
			store: prisma.createInMemoryIdempotencyStore(),
			clock: Date.now,
			invocation: { ttl: "30m", timeoutMs: 180000 },
			env: anonymousProcessEnvironment(cliHome),
		});
		const created = await client.create({
			idempotencyKey: `hobo:${run.runId}`,
		});
		await run.writePrivate("receipt.json", created);
		return {
			provider: "prisma-postgres",
			provisionConfirmed: created.kind === "created",
			dataPlaneValidated: false,
			expirySource: "cli-local-clock",
			requestedTtl: "30m",
			retirementConfirmed: false,
		};
	} finally {
		await rm(cliHome, { recursive: true, force: true });
	}
}

async function acceptNetlify(
	run: AcceptanceRun,
	fetchImpl: typeof fetch,
): Promise<JsonObject> {
	const actual = netlify.createNodeProcessRunner();
	const runner: netlify.ProcessRunner = {
		async run(argv, options) {
			const result = await actual.run(argv, options);
			await run.writePrivate("native-cli-response.json", result);
			return result;
		},
	};
	const receipt = await netlify.provisionTemporaryEnvironmentStation({
		stationId: `hobo-budget-${run.runId}`,
		workDir: path.join(run.privateDir, "static-site"),
		transport: netlify.createNetlifyAnonymousCliTransport({ runner }),
	});
	await run.writePrivate("receipt.json", receipt);
	const observation = await netlify.observeNetlifyAnonymousSite({
		stationUrl: receipt.stationUrl,
		claimUrl: receipt.claimUrl,
		expectedMarker: "data-hobo-station",
		transport: createBoundedFetchTransport({ fetchImpl }),
	});
	await run.writePrivate("native-observation.json", observation);
	return {
		provider: "netlify",
		resourceHash: digest(receipt.stationId),
		httpStatus: observation.httpStatus,
		expectedMarker: observation.markerObserved,
		dataPlaneValidated:
			observation.httpStatus === 200 && observation.markerObserved,
		passwordGateObserved: observation.passwordGateObserved,
		expirySource: "local-policy",
		retirementConfirmed: false,
	};
}

async function acceptLakebed(
	run: AcceptanceRun,
	fetchImpl: typeof fetch,
): Promise<JsonObject> {
	const capsuleDir = await lakebed.materializeEnvironmentStationCapsule({
		stationId: `hobo-budget-${run.runId}`,
		rootDir: path.join(run.privateDir, "capsule"),
	});
	const transport = lakebed.createLakebedAnonymousCliTransport({
		async captureOutput(result) {
			await run.writePrivate("native-cli-response.json", result);
			const nativeMetadata = path.join(capsuleDir, ".lakebed", "deploy.json");
			if (existsSync(nativeMetadata)) await chmod(nativeMetadata, 0o600);
		},
	});
	const receipt = await lakebed.provisionTemporaryEnvironmentStation({
		stationId: `hobo-budget-${run.runId}`,
		capsuleDir,
		transport,
	});
	await run.writePrivate("receipt.json", receipt);
	const response = await createBoundedFetchTransport({ fetchImpl })({
		method: "GET",
		url: new URL("/health", receipt.stationUrl).toString(),
		headers: {},
		timeoutMs: 20000,
		maxResponseBytes: 1024 * 1024,
	});
	await run.writePrivate("native-observation.json", response);
	return {
		provider: "lakebed",
		resourceHash: digest(receipt.accountId ?? receipt.stationId),
		httpStatus: response.status,
		expectedMarker: response.body.includes("environment-station"),
		dataPlaneValidated:
			response.status === 200 && response.body.includes("environment-station"),
		expiresAt: receipt.expiresAt,
		expirySource: "provider-reported",
		retirementConfirmed: false,
	};
}

export async function runAnonymousAcceptance(input: {
	readonly provider: AnonymousAcceptanceProvider;
	readonly stateDir: string;
	readonly fetchImpl?: typeof fetch;
}) {
	const config = Object.freeze({ ...input });
	const run = await openAnonymousAcceptanceRun(config);
	try {
		const fetchImpl = config.fetchImpl ?? fetch;
		return await run.once(async () => {
			let result: JsonObject;
			switch (config.provider) {
				case "cloudflare":
					result = await acceptCloudflare(run, fetchImpl);
					break;
				case "neon":
					result = await acceptNeon(run, fetchImpl);
					break;
				case "upstash":
					result = await acceptUpstash(run, fetchImpl);
					break;
				case "prisma-postgres":
					result = await acceptPrisma(run);
					break;
				case "netlify":
					result = await acceptNetlify(run, fetchImpl);
					break;
				case "lakebed":
					result = await acceptLakebed(run, fetchImpl);
					break;
			}
			await run.writePrivate("safe-evidence.json", result);
			return result;
		});
	} finally {
		run.close();
	}
}

function providerArgument(
	value: string | undefined,
): AnonymousAcceptanceProvider {
	switch (value) {
		case "cloudflare":
		case "neon":
		case "upstash":
		case "prisma-postgres":
		case "netlify":
		case "lakebed":
			return value;
		default:
			throw new Error("select an anonymous provider explicitly");
	}
}
async function main() {
	process.umask(0o077);
	const provider = providerArgument(
		process.argv
			.find((arg) => arg.startsWith("--provider="))
			?.slice("--provider=".length),
	);
	const stateDir = process.argv
		.find((arg) => arg.startsWith("--state-dir="))
		?.slice("--state-dir=".length);
	if (!stateDir || !path.isAbsolute(stateDir))
		throw new Error(
			"supply an absolute private state directory outside the checkout",
		);
	const result = await runAnonymousAcceptance({ provider, stateDir });
	console.log(JSON.stringify(result));
	if (
		result.status === "uncertain" ||
		(result.status === "completed" &&
			(result.value.dataPlaneValidated !== true ||
				(provider === "cloudflare" &&
					result.value.workerAbsenceConfirmed !== true)))
	)
		process.exitCode = 1;
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	void main().catch(() => {
		console.error(
			"Anonymous acceptance did not complete; provider outcome is unconfirmed. Inspect the private state directory. No allocation was replayed.",
		);
		process.exitCode = 1;
	});
}
