import { createHash, createPublicKey } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
	ContainerSpecSchema,
	DeliveryEnvelopeSchema,
	StartEnvelopeSchema,
	WorkerIdentitySchema,
	type ContainerSpec,
	type CryptoKey,
	type DeliveryEnvelope,
	type StartEnvelope,
	type WorkerIdentity,
} from "./vm-delivery.mts";
import {
	publicKeyFingerprint,
	sealDelivery,
	signStart,
	validateContainer,
} from "./vm-delivery.mts";

export const ReadyArtifactSchema = WorkerIdentitySchema.extend({
	version: z.literal(1),
	kind: z.literal("hobo-worker-ready"),
	publicKey: z.string().min(1).max(8191),
	preflight: z
		.object({
			ok: z.literal(true),
			imageId: z.string(),
			architecture: z.literal("x64"),
		})
		.strict(),
}).strict();
export type ReadyArtifact = z.infer<typeof ReadyArtifactSchema>;
export const CompletionArtifactSchema = WorkerIdentitySchema.extend({
	version: z.literal(1),
	kind: z.literal("hobo-worker-complete"),
	exitCode: z.number().int().min(0).max(255),
	oomKilled: z.boolean(),
	runnerExited: z.literal(true),
}).strict();
export type CompletionArtifact = z.infer<typeof CompletionArtifactSchema>;
const NativeRunSchema = z.object({
	id: z.number().int().positive(),
	run_attempt: z.number().int().positive(),
	head_sha: z.string(),
	head_branch: z.string(),
	workflow_id: z.number().int().positive(),
	event: z.string(),
	display_title: z.string(),
	repository: z.object({ id: z.number().int().positive() }),
	status: z.enum([
		"requested",
		"queued",
		"pending",
		"waiting",
		"in_progress",
		"completed",
	]),
	conclusion: z.string().nullable().optional(),
});
export type NativeRun = z.infer<typeof NativeRunSchema>;
const RunListSchema = z.object({ workflow_runs: z.array(NativeRunSchema) });
const RepositorySchema = z.object({
	id: z.number().int().positive(),
	full_name: z.string(),
	private: z.boolean(),
});
const ArtifactMetadataSchema = z.object({
	id: z.number().int().positive(),
	name: z.string(),
	expired: z.boolean(),
	digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	workflow_run: z.object({
		id: z.number().int().positive(),
		head_sha: z.string(),
	}),
});
const ReadyResultSchema = z.object({
	artifact: ArtifactMetadataSchema,
	value: ReadyArtifactSchema,
});
const CompletionResultSchema = z.object({
	artifact: ArtifactMetadataSchema,
	value: CompletionArtifactSchema,
});
const RecordSchema = z
	.object({
		leaseId: z.string(),
		dispatchedAt: z.number().int().positive(),
		lifetimeMs: z.number().int().positive(),
		container: ContainerSpecSchema,
		dispatchAttempted: z.literal(true),
		removed: z.boolean(),
		runId: z.number().int().positive().optional(),
		runAttempt: z.number().int().positive().optional(),
		containerId: z.string().optional(),
		ready: ReadyArtifactSchema.optional(),
		delivery: DeliveryEnvelopeSchema.optional(),
		jitHash: z.string().optional(),
		deliveryPublished: z.boolean().optional(),
		start: StartEnvelopeSchema.optional(),
		startPublished: z.boolean().optional(),
	})
	.strict();
const ActiveRecordSchema = RecordSchema.extend({
	runId: z.number().int().positive(),
	runAttempt: z.number().int().positive(),
	containerId: z.string(),
});
type WorkerRecord = z.infer<typeof RecordSchema>;
type ActiveRecord = z.infer<typeof ActiveRecordSchema>;
const StateSchema = z
	.object({
		version: z.literal(1),
		records: z.record(z.string(), RecordSchema),
	})
	.strict();
export const WorkflowDispatchSchema = z
	.object({ ref: z.string(), inputs: z.record(z.string(), z.string()) })
	.strict();
export type WorkflowDispatch = z.infer<typeof WorkflowDispatchSchema>;
export type GithubMethod = "GET" | "POST";
export type GithubTransport = {
	request: (
		installationId: number,
		path: string,
		method?: GithubMethod,
		body?: string,
	) => Promise<Response>;
};
export type DeliveryMessage = {
	path: string;
	value: DeliveryEnvelope | StartEnvelope;
};
export type VmSpec = {
	name: string;
	image: string;
	timeoutMs: number;
	env: Readonly<Record<string, string>>;
	command: readonly string[];
	runAsUser?: string;
	memoryMb?: number;
	volumes?: readonly { source: string; target: string; readonly?: boolean }[];
};
export type ImageInspection = {
	id: string;
	repoTags: readonly string[];
	labels: Readonly<Record<string, string>>;
};
export type VmHandle = { name: string; containerId: string };
export type VmContainerState = {
	name: string;
	containerId: string;
	state: "exited" | "running" | "created";
};
export type VmDockerDriver = {
	inspectImage: (image: string) => Promise<ImageInspection>;
	probeImage: (
		image: string,
		argv: readonly string[],
		user: string,
	) => Promise<{ exitCode: number }>;
	create: (spec: VmSpec) => Promise<VmHandle>;
	start: (name: string, id: string) => Promise<void>;
	writeSecret: (
		name: string,
		id: string,
		path: string,
		content: string,
	) => Promise<void>;
	execDetached: (
		name: string,
		id: string,
		argv: readonly string[],
	) => Promise<{ exitCode: number }>;
	exec: (
		name: string,
		id: string,
		argv: readonly string[],
	) => Promise<{ exitCode: number }>;
	isRunning: (name: string, id: string) => Promise<boolean>;
	exists: (name: string, id: string, path: string) => Promise<boolean>;
	exitState: (
		name: string,
		id: string,
	) => Promise<{ exitCode: number; oomKilled: boolean }>;
	memoryPeak: () => Promise<number | undefined>;
	stop: (name: string, id: string) => Promise<void>;
	remove: (name: string, id: string) => Promise<void>;
	list: (label: string) => Promise<VmContainerState[]>;
};
export type GithubVmDockerDriverOptions = {
	github: GithubTransport;
	installationId: number;
	workflowId: number;
	sourceRef: string;
	sourceSha: string;
	controlBranch: string;
	imageRef: string;
	imageDigest: string;
	imageId: string;
	localImage: string;
	stateFile: string;
	signingPrivateKey: CryptoKey;
	readArtifact: (input: {
		runId: number;
		runAttempt: number;
		name: string;
	}) => Promise<Parameters<typeof ReadyResultSchema.parse>[0]>;
	writeDelivery: (input: DeliveryMessage) => Promise<void>;
	inspectPinnedImage: (image: string) => Promise<ImageInspection>;
	probePinnedImage: (
		image: string,
		argv: readonly string[],
		user: string,
	) => Promise<{ exitCode: number }>;
	expectedStartArgv: readonly string[];
	clock?: () => number;
	wait?: (milliseconds: number) => Promise<void>;
	pollMs?: number;
	readyTimeoutMs?: number;
	cancelTimeoutMs?: number;
	maxWorkerMemoryMb?: number;
	deadlineForLease?: (leaseId: string) => Promise<string | null | undefined>;
};
function active(record: WorkerRecord): asserts record is ActiveRecord {
	ActiveRecordSchema.parse(record);
}
const REPO = "Hobo-Labs/HoBo";
const REPO_ID = 1274791462;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const JIT_PATH = "/tmp/hobo-ci-jit";
const EXITED_PATH = "/tmp/hobo-ci-runner-exited";
type ComparedValue = ContainerSpec | readonly string[];
function equal(first: ComparedValue, second: ComparedValue): boolean {
	return JSON.stringify(first) === JSON.stringify(second);
}
function positive(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}
function invariant(
	value:
		| boolean
		| string
		| number
		| null
		| undefined
		| WorkerRecord
		| NativeRun
		| ReadyArtifact
		| CompletionArtifact
		| DeliveryEnvelope,
	message: string,
): asserts value {
	if (!value) throw new Error(message);
}
function leaseForName(name: string): string {
	invariant(
		name.startsWith("hobo-") && UUID.test(name.slice(5)),
		"invalid VM lease name",
	);
	return name.slice(5);
}
function idFor(runId: number, attempt: number): string {
	return createHash("sha256")
		.update(`hobo-github-vm:${runId}:${attempt}`)
		.digest("hex");
}

/** Captures the shipped fixed script without launching it or handling a real credential. */
export async function captureRunnerStartArgv(
	startRunner: (
		driver: VmDockerDriver,
		name: string,
		id: string,
		credential: string,
	) => Promise<void>,
): Promise<readonly string[]> {
	let argv: string[] | undefined;
	await startRunner(
		{
			inspectImage: async () => {
				throw new Error("capture cannot inspect");
			},
			probeImage: async () => {
				throw new Error("capture cannot probe");
			},
			create: async () => {
				throw new Error("capture cannot create");
			},
			start: async () => {
				throw new Error("capture cannot start");
			},
			exec: async () => {
				throw new Error("capture cannot execute");
			},
			isRunning: async () => false,
			exists: async () => false,
			exitState: async () => {
				throw new Error("capture cannot inspect exit");
			},
			memoryPeak: async () => undefined,
			stop: async () => {},
			remove: async () => {},
			list: async () => [],
			writeSecret: async () => {},
			execDetached: async (_name, _id, passed) => {
				argv = [...passed];
				return { exitCode: 0 };
			},
		},
		"fixture",
		"fixture",
		"fixture",
	);
	invariant(
		Array.isArray(argv) &&
			argv.length === 3 &&
			argv[0] === "sh" &&
			argv[1] === "-ec",
		"invalid shipped runner script",
	);
	return argv;
}

/**
 * Operator-only bridge: trusted HoBo state remains local; each GitHub VM receives
 * one encrypted JIT credential. It never receives App, signing, or budget keys.
 * readArtifact must verify the downloaded archive against its native digest.
 */
export function createGithubVmDockerDriver(
	options: GithubVmDockerDriverOptions,
): VmDockerDriver {
	const {
		github,
		installationId,
		workflowId,
		sourceRef,
		sourceSha,
		controlBranch,
		imageRef,
		imageDigest,
		imageId,
		localImage,
		stateFile,
		signingPrivateKey,
		readArtifact,
		writeDelivery,
		inspectPinnedImage,
		probePinnedImage,
		expectedStartArgv,
	} = options;
	invariant(
		positive(installationId) && positive(workflowId),
		"invalid GitHub VM API binding",
	);
	invariant(
		/^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$/.test(sourceRef) &&
			!sourceRef.includes("..") &&
			!sourceRef.endsWith("/"),
		"invalid VM source ref",
	);
	invariant(
		/^[0-9a-f]{40}$/.test(sourceSha) &&
			/^ops\/[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/.test(controlBranch) &&
			!controlBranch.includes(".."),
		"invalid VM source binding",
	);
	invariant(
		/^ttl\.sh\/[A-Za-z0-9_./:-]+@sha256:[0-9a-f]{64}$/.test(imageRef) &&
			imageRef.endsWith("@" + imageDigest) &&
			SHA.test(imageDigest) &&
			SHA.test(imageId),
		"invalid pinned VM image",
	);
	invariant(
		Boolean(localImage) && stateFile.startsWith("/"),
		"incomplete VM driver",
	);
	invariant(
		Array.isArray(expectedStartArgv) &&
			expectedStartArgv.length === 3 &&
			expectedStartArgv[0] === "sh" &&
			expectedStartArgv[1] === "-ec",
		"missing exact runner script",
	);
	const clock = options.clock ?? Date.now,
		wait =
			options.wait ??
			((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const pollMs = options.pollMs ?? 2000,
		readyTimeoutMs = options.readyTimeoutMs ?? 240000,
		cancelTimeoutMs = options.cancelTimeoutMs ?? 120000;
	invariant(
		positive(pollMs) &&
			positive(readyTimeoutMs) &&
			readyTimeoutMs <= 300000 &&
			positive(cancelTimeoutMs) &&
			cancelTimeoutMs <= 180000,
		"invalid VM deadlines",
	);
	const maxWorkerMemoryMb = options.maxWorkerMemoryMb ?? 6144;
	invariant(
		positive(maxWorkerMemoryMb) &&
			maxWorkerMemoryMb >= 512 &&
			maxWorkerMemoryMb <= 12288,
		"invalid VM memory ceiling",
	);
	const publicKey = createPublicKey(signingPrivateKey).export({
		type: "spki",
		format: "pem",
	});
	const state = StateSchema.parse(
		existsSync(stateFile)
			? JSON.parse(readFileSync(stateFile, "utf8"))
			: { version: 1, records: {} },
	);
	function persist() {
		const root = dirname(stateFile);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const temp = stateFile + ".next";
		const file = openSync(temp, "w", 0o600);
		try {
			fchmodSync(file, 0o600);
			writeFileSync(file, JSON.stringify(state));
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		renameSync(temp, stateFile);
		const directory = openSync(root, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	}
	function recordFor(name: string, containerId: string): ActiveRecord {
		leaseForName(name);
		const record = state.records[name];
		invariant(
			Boolean(record) && record?.containerId === containerId,
			"unknown VM handle",
		);
		invariant(record, "unknown VM handle");
		active(record);
		return record;
	}
	async function api(
		path: string,
		method: GithubMethod = "GET",
		body?: WorkflowDispatch,
	): Promise<Response> {
		const response = await github.request(
			installationId,
			`/repos/${REPO}${path}`,
			method,
			body === undefined ? undefined : JSON.stringify(body),
		);
		invariant(
			response && Number.isInteger(response.status),
			"invalid GitHub VM response",
		);
		return response;
	}
	async function json<S extends z.ZodType>(
		response: Response,
		schema: S,
		allowed: readonly number[] = [200],
	): Promise<z.infer<S>> {
		invariant(
			allowed.includes(response.status),
			`GitHub VM operation refused (${response.status})`,
		);
		return schema.parse(await response.json());
	}
	function validateRun(run: NativeRun, record: ActiveRecord): NativeRun {
		invariant(
			run &&
				run.id === record.runId &&
				run.run_attempt === record.runAttempt &&
				run.head_sha === sourceSha &&
				run.head_branch === sourceRef &&
				run.workflow_id === workflowId &&
				run.event === "workflow_dispatch" &&
				run.display_title === `hobo-bootstrap-worker-${record.leaseId}` &&
				run.repository?.id === REPO_ID,
			"native VM run identity mismatch",
		);
		invariant(
			[
				"requested",
				"queued",
				"pending",
				"waiting",
				"in_progress",
				"completed",
			].includes(run.status),
			"invalid native VM status",
		);
		return run;
	}
	async function nativeRun(record: ActiveRecord): Promise<NativeRun> {
		return validateRun(
			await json(
				await api(
					`/actions/runs/${record.runId}/attempts/${record.runAttempt}`,
				),
				NativeRunSchema,
			),
			record,
		);
	}
	async function discover(
		record: WorkerRecord,
	): Promise<NativeRun | undefined> {
		if (record.runId) {
			active(record);
			return nativeRun(record);
		}
		const found: NativeRun[] = [];
		for (let page = 1; page <= 5; page++) {
			const result = await json(
				await api(
					`/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(sourceRef)}&event=workflow_dispatch&per_page=100&page=${page}`,
				),
				RunListSchema,
			);
			invariant(
				Array.isArray(result.workflow_runs),
				"invalid native VM discovery",
			);
			for (const run of result.workflow_runs)
				if (run.display_title === `hobo-bootstrap-worker-${record.leaseId}`)
					found.push(run);
			if (result.workflow_runs.length < 100) break;
			if (page === 5) throw new Error("native VM discovery window exhausted");
		}
		invariant(found.length <= 1, "ambiguous duplicate native VM runs");
		if (!found.length) return undefined;
		const run = found.at(0);
		invariant(run, "missing native VM run");
		invariant(
			positive(run.id) && positive(run.run_attempt),
			"invalid native VM identity",
		);
		record.runId = run.id;
		record.runAttempt = run.run_attempt;
		record.containerId = idFor(run.id, run.run_attempt);
		active(record);
		validateRun(run, record);
		persist();
		return run;
	}
	function identity(record: ActiveRecord): WorkerIdentity {
		return {
			repositoryId: REPO_ID,
			leaseId: record.leaseId,
			runId: record.runId,
			runAttempt: record.runAttempt,
			sourceSha,
			imageDigest,
		};
	}
	function artifactIdentity(
		result:
			| z.infer<typeof ReadyResultSchema>
			| z.infer<typeof CompletionResultSchema>,
		record: ActiveRecord,
		kind: "ready" | "complete",
	): void {
		const name = `hobo-worker-${kind}-${record.runId}-${record.runAttempt}`;
		invariant(
			result.artifact.name === name &&
				result.artifact.expired === false &&
				result.artifact.workflow_run.id === record.runId &&
				result.artifact.workflow_run.head_sha === sourceSha,
			"native worker artifact identity mismatch",
		);
		const id = identity(record);
		invariant(
			result.value.repositoryId === id.repositoryId &&
				result.value.leaseId === id.leaseId &&
				result.value.runId === id.runId &&
				result.value.runAttempt === id.runAttempt &&
				result.value.sourceSha === id.sourceSha &&
				result.value.imageDigest === id.imageDigest,
			"worker artifact binding mismatch",
		);
	}
	async function readyArtifact(
		record: ActiveRecord,
	): Promise<ReadyArtifact | undefined> {
		const result = await readArtifact({
			runId: record.runId,
			runAttempt: record.runAttempt,
			name: `hobo-worker-ready-${record.runId}-${record.runAttempt}`,
		});
		if (!result) return undefined;
		const parsed = ReadyResultSchema.parse(result);
		artifactIdentity(parsed, record, "ready");
		const doc = parsed.value;
		invariant(
			doc.preflight?.ok === true &&
				doc.preflight.imageId === imageId &&
				doc.preflight.architecture === "x64" &&
				doc.publicKey.length < 8192,
			"worker image preflight failed",
		);
		const key = createPublicKey(doc.publicKey);
		invariant(
			key.asymmetricKeyType === "rsa" &&
				(key.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072,
			"invalid worker reply key",
		);
		if (record.ready)
			invariant(
				publicKeyFingerprint(doc.publicKey) ===
					publicKeyFingerprint(record.ready.publicKey),
				"worker reply key changed",
			);
		return doc;
	}
	async function completionArtifact(
		record: ActiveRecord,
		allowMissing = false,
	): Promise<CompletionArtifact | undefined> {
		const result = await readArtifact({
			runId: record.runId,
			runAttempt: record.runAttempt,
			name: `hobo-worker-complete-${record.runId}-${record.runAttempt}`,
		});
		if (!result && allowMissing) return undefined;
		invariant(Boolean(result), "worker completion proof unavailable");
		const parsed = CompletionResultSchema.parse(result);
		artifactIdentity(parsed, record, "complete");
		const doc = parsed.value;
		invariant(
			Number.isSafeInteger(doc.exitCode) &&
				doc.exitCode >= 0 &&
				doc.exitCode <= 255 &&
				doc.runnerExited === true,
			"invalid worker completion proof",
		);
		return doc;
	}
	async function deadline(record: ActiveRecord): Promise<number> {
		const maximum = Math.min(
			clock() + 60000,
			record.dispatchedAt + record.lifetimeMs,
		);
		if (!options.deadlineForLease) return maximum;
		const value = await options.deadlineForLease(record.leaseId);
		invariant(value !== undefined, "unknown local VM lease");
		const parsed = value === null ? maximum : Date.parse(value);
		invariant(Number.isFinite(parsed), "invalid local VM lease deadline");
		return Math.min(maximum, parsed);
	}
	function safeContainer(spec: VmSpec): ContainerSpec {
		const env = { ...spec.env };
		delete env.HOBO_CI_HOST_JOB_DIRECTORY;
		return validateContainer({
			env,
			memoryMb: spec.memoryMb,
			runAsUser: spec.runAsUser,
		});
	}
	const driver: VmDockerDriver = {
		async inspectImage(image) {
			invariant(image === localImage, "foreign VM image refused");
			const result = await inspectPinnedImage(image);
			invariant(result?.id === imageId, "local pinned image identity changed");
			return result;
		},
		async probeImage(image, argv, user) {
			invariant(
				image === localImage && user === "1000:1000",
				"foreign VM image probe refused",
			);
			return probePinnedImage(image, argv, user);
		},
		async create(spec) {
			const leaseId = leaseForName(spec.name);
			invariant(
				spec.image === localImage && equal(spec.command, ["sleep", "infinity"]),
				"unsupported VM container spec",
			);
			invariant(
				positive(spec.timeoutMs) && spec.timeoutMs <= 2400000,
				"invalid VM lifetime",
			);
			const container = safeContainer(spec);
			invariant(
				container.memoryMb <= maxWorkerMemoryMb,
				"VM memory limit exceeds host allowance",
			);
			let record = state.records[spec.name];
			if (record) {
				invariant(
					record.leaseId === leaseId &&
						equal(record.container, container) &&
						record.lifetimeMs === spec.timeoutMs &&
						!record.removed,
					"VM lease spec changed",
				);
			} else {
				const repository = await json(await api(""), RepositorySchema);
				invariant(
					repository?.id === REPO_ID &&
						repository.private === false &&
						repository.full_name.toLowerCase() === REPO.toLowerCase(),
					"zero-price GitHub VM requires the verified public repository",
				);
				record = {
					leaseId,
					dispatchedAt: clock(),
					lifetimeMs: spec.timeoutMs,
					container,
					dispatchAttempted: true,
					removed: false,
				};
				state.records[spec.name] = record;
				persist();
				const response = await api(
					`/actions/workflows/${workflowId}/dispatches`,
					"POST",
					{
						ref: sourceRef,
						inputs: {
							role: "worker",
							lease_id: leaseId,
							image_ref: imageRef,
							control_branch: controlBranch,
							signing_public_key: Buffer.from(publicKey).toString("base64"),
							lifetime_ms: String(spec.timeoutMs),
							timeout_minutes: String(Math.ceil(spec.timeoutMs / 60000)),
						},
					},
				);
				invariant(
					response.status === 204,
					`GitHub VM dispatch refused (${response.status})`,
				);
			}
			const until = Math.min(
				record.dispatchedAt + record.lifetimeMs,
				clock() + readyTimeoutMs,
			);
			while (clock() < until) {
				const run = await discover(record);
				if (run) {
					active(record);
					invariant(
						run.status !== "completed",
						"worker VM exited before readiness",
					);
					const ready = await readyArtifact(record);
					if (ready) {
						record.ready = ready;
						persist();
						return { name: spec.name, containerId: record.containerId };
					}
				}
				await wait(pollMs);
			}
			throw new Error("worker VM dispatch or readiness uncertain");
		},
		async start(name, id) {
			const record = recordFor(name, id);
			invariant(record.ready, "worker VM is not ready");
			const run = await nativeRun(record);
			invariant(run.status === "in_progress", "worker VM is not running");
		},
		async writeSecret(name, id, path, content) {
			const record = recordFor(name, id);
			invariant(
				path === JIT_PATH && record.ready && !record.startPublished,
				"unsupported worker secret",
			);
			const hash = createHash("sha256").update(content).digest("hex");
			if (record.delivery) {
				invariant(record.jitHash === hash, "different JIT for existing VM");
				invariant(
					record.delivery.notAfter > clock(),
					"worker JIT delivery expired",
				);
			} else {
				record.delivery = sealDelivery({
					jitConfig: content,
					container: record.container,
					identity: identity(record),
					workerPublicKey: record.ready.publicKey,
					signingPrivateKey,
					notAfter: await deadline(record),
					clock,
				});
				record.jitHash = hash;
				persist();
			}
			await writeDelivery({
				path: `workers/${record.leaseId}/delivery.json`,
				value: record.delivery,
			});
			record.deliveryPublished = true;
			persist();
		},
		async execDetached(name, id, argv) {
			const record = recordFor(name, id);
			invariant(
				equal(argv, expectedStartArgv) && record.deliveryPublished,
				"unsupported worker command",
			);
			invariant(record.delivery, "missing JIT delivery");
			if (!record.start) {
				record.start = signStart({
					envelope: record.delivery,
					identity: identity(record),
					signingPrivateKey,
					notAfter: Math.min(record.delivery.notAfter, await deadline(record)),
					clock,
				});
				persist();
			}
			invariant(record.start.notAfter > clock(), "worker start expired");
			await writeDelivery({
				path: `workers/${record.leaseId}/start.json`,
				value: record.start,
			});
			record.startPublished = true;
			persist();
			return { exitCode: 0 };
		},
		async exec(name, id, argv) {
			return driver.execDetached(name, id, argv);
		},
		async isRunning(name, id) {
			return (await nativeRun(recordFor(name, id))).status !== "completed";
		},
		async exists(name, id, path) {
			invariant(path === EXITED_PATH, "unsupported worker path");
			const record = recordFor(name, id);
			const run = await nativeRun(record);
			const proof = await completionArtifact(
				record,
				run.status !== "completed",
			);
			return proof?.runnerExited === true;
		},
		async exitState(name, id) {
			const record = recordFor(name, id);
			invariant(
				(await nativeRun(record)).status === "completed",
				"worker VM is still active",
			);
			const doc = await completionArtifact(record);
			invariant(doc, "worker completion proof unavailable");
			return { exitCode: doc.exitCode, oomKilled: doc.oomKilled };
		},
		async memoryPeak() {
			return undefined;
		},
		async stop(name, id) {
			const record = recordFor(name, id);
			let run = await nativeRun(record);
			if (run.status === "completed") return;
			// GitHub's cancellation endpoint targets the current attempt. Never cancel
			// a known replacement when reconciling this persisted historical handle.
			const latest = await json(
				await api(`/actions/runs/${record.runId}`),
				NativeRunSchema,
			);
			invariant(
				latest?.id === record.runId && latest.run_attempt === record.runAttempt,
				"worker VM attempt changed; cancellation refused",
			);
			if (latest.status === "completed") return;
			const response = await api(
				`/actions/runs/${record.runId}/cancel`,
				"POST",
			);
			invariant(
				[202, 409].includes(response.status),
				`GitHub VM cancel refused (${response.status})`,
			);
			const until = clock() + cancelTimeoutMs;
			while (clock() < until) {
				run = await nativeRun(record);
				if (run.status === "completed") return;
				await wait(pollMs);
			}
			throw new Error("worker VM cancellation unconfirmed");
		},
		async remove(name, id) {
			const record = recordFor(name, id);
			invariant(
				(await nativeRun(record)).status === "completed",
				"worker VM cleanup unconfirmed",
			);
			record.removed = true;
			persist();
		},
		async list(label) {
			invariant(label === "hobo.ci/isolated=1", "unsupported VM list scope");
			const result: VmContainerState[] = [];
			for (const [name, record] of Object.entries(state.records)) {
				if (record.removed) continue;
				const run = await discover(record);
				if (!run) continue;
				active(record);
				result.push({
					name,
					containerId: record.containerId,
					state:
						run.status === "completed"
							? "exited"
							: run.status === "in_progress"
								? "running"
								: "created",
				});
			}
			return result;
		},
	};
	return driver;
}
