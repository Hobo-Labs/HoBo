import { z } from "zod";

export const NODE_CACHE_ROOT = "/var/lib/hobo-ci";
export const POD_PNPM_STORE = "/pnpm-store";
export const POD_IMAGE_CACHE = "/var/cache/hobo-ci/images";
export const RUNNER_UID = 1000;
export const STORE_PREWARM_LABEL = "hobo.ci/store-prewarm";
export const STORE_PREWARM_REF_LABEL = "hobo.ci/store-prewarm-ref";

const NamedEntrySchema = z.looseObject({ name: z.string() });
type NamedEntry = Readonly<{ name: string }>;

const RunnerContainerSchema = z.looseObject({
	name: z.string(),
	image: z.string().optional(),
	env: z.array(NamedEntrySchema).optional(),
	volumeMounts: z.array(NamedEntrySchema).optional(),
});

export const AutoscalingRunnerSetSchema = z.looseObject({
	metadata: z.looseObject({
		name: z.string(),
		namespace: z.string(),
		resourceVersion: z.string().optional(),
	}),
	spec: z.looseObject({
		template: z.looseObject({
			spec: z.looseObject({
				containers: z.array(RunnerContainerSchema),
				initContainers: z.array(NamedEntrySchema).optional(),
				volumes: z.array(NamedEntrySchema).optional(),
			}),
		}),
	}),
});

export const AutoscalingRunnerSetListSchema = z.looseObject({
	items: z.array(
		z.looseObject({ metadata: z.looseObject({ name: z.string() }) }),
	),
});

export type AutoscalingRunnerSet = z.infer<typeof AutoscalingRunnerSetSchema>;
export type RunnerPodSpec = z.input<
	typeof AutoscalingRunnerSetSchema
>["spec"]["template"]["spec"];

export type JsonPatchOp = Readonly<{
	op: "add";
	path: string;
	value: NamedEntry | NamedEntry[];
}>;

type NodeCache = Readonly<{
	volume: string;
	hostPath: string;
	mountPath: string;
	env: string;
}>;

const PNPM_STORE_CACHE: NodeCache = {
	volume: "hobo-pnpm-store",
	hostPath: `${NODE_CACHE_ROOT}/pnpm-store`,
	mountPath: POD_PNPM_STORE,
	env: "HOBO_CI_PNPM_STORE_DIR",
};

const CACHES: readonly NodeCache[] = [
	PNPM_STORE_CACHE,
	{
		volume: "hobo-image-cache",
		hostPath: `${NODE_CACHE_ROOT}/images`,
		mountPath: POD_IMAGE_CACHE,
		env: "HOBO_CI_IMAGE_CACHE_DIR",
	},
];

export const CACHE_OWNER_INIT = "hobo-cache-owner";

type ListAddition = Readonly<{
	path: string;
	existing: readonly NamedEntry[] | undefined;
	missing: readonly NamedEntry[];
}>;

function listAddition<Entry extends NamedEntry>(
	path: string,
	existing: readonly NamedEntry[] | undefined,
	wanted: readonly Entry[],
): ListAddition {
	const present = new Set((existing ?? []).map((entry) => entry.name));
	return {
		path,
		existing,
		missing: wanted.filter((entry) => !present.has(entry.name)),
	};
}

function patchOps(addition: ListAddition): JsonPatchOp[] {
	if (addition.missing.length === 0) return [];
	if (addition.existing === undefined)
		return [{ op: "add", path: addition.path, value: [...addition.missing] }];
	return addition.missing.map((value) => ({
		op: "add",
		path: `${addition.path}/-`,
		value,
	}));
}

function appended(addition: ListAddition): NamedEntry[] {
	return [...(addition.existing ?? []), ...addition.missing];
}

export function runnerContainerIndex(set: AutoscalingRunnerSet): number {
	const index = set.spec.template.spec.containers.findIndex(
		(container) => container.name === "runner",
	);
	if (index < 0) {
		throw new Error(
			`${set.metadata.namespace}/${set.metadata.name} has no container named runner`,
		);
	}
	return index;
}

function runnerCacheAdditions(set: AutoscalingRunnerSet) {
	const pod = set.spec.template.spec;
	const index = runnerContainerIndex(set);
	const runner = pod.containers[index];
	if (runner?.image === undefined) {
		throw new Error("the runner container names no image");
	}
	const base = "/spec/template/spec";
	const mounts = CACHES.map((cache) => ({
		name: cache.volume,
		mountPath: cache.mountPath,
	}));
	return {
		index,
		runner,
		volumes: listAddition(
			`${base}/volumes`,
			pod.volumes,
			CACHES.map((cache) => ({
				name: cache.volume,
				hostPath: { path: cache.hostPath, type: "DirectoryOrCreate" },
			})),
		),
		initContainers: listAddition(`${base}/initContainers`, pod.initContainers, [
			{
				name: CACHE_OWNER_INIT,
				image: runner.image,
				command: [
					"install",
					"-d",
					"-o",
					String(RUNNER_UID),
					"-g",
					String(RUNNER_UID),
					...CACHES.map((cache) => cache.mountPath),
				],
				securityContext: { runAsUser: 0, runAsGroup: 0 },
				volumeMounts: mounts,
			},
		]),
		volumeMounts: listAddition(
			`${base}/containers/${index}/volumeMounts`,
			runner.volumeMounts,
			mounts,
		),
		env: listAddition(
			`${base}/containers/${index}/env`,
			runner.env,
			CACHES.map((cache) => ({ name: cache.env, value: cache.mountPath })),
		),
	};
}

export function arcRunnerCachePatch(set: AutoscalingRunnerSet): JsonPatchOp[] {
	const additions = runnerCacheAdditions(set);
	return [
		additions.volumes,
		additions.initContainers,
		additions.volumeMounts,
		additions.env,
	].flatMap(patchOps);
}

export function withRunnerCaches(
	set: AutoscalingRunnerSet,
): AutoscalingRunnerSet {
	const additions = runnerCacheAdditions(set);
	const pod = set.spec.template.spec;
	return AutoscalingRunnerSetSchema.parse({
		...set,
		spec: {
			...set.spec,
			template: {
				...set.spec.template,
				spec: {
					...pod,
					volumes: appended(additions.volumes),
					initContainers: appended(additions.initContainers),
					containers: pod.containers.map((container, index) =>
						index === additions.index
							? {
									...container,
									volumeMounts: appended(additions.volumeMounts),
									env: appended(additions.env),
								}
							: container,
					),
				},
			},
		},
	});
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export function isStorePrewarmRef(ref: string): boolean {
	return COMMIT_SHA.test(ref);
}

export function storePrewarmJobName(
	set: AutoscalingRunnerSet,
	ref: string,
): string {
	return `${set.metadata.name}-store-prewarm-${ref.slice(0, 12)}`;
}

export function storePrewarmJob(
	set: AutoscalingRunnerSet,
	repository: string,
	ref: string,
) {
	if (!REPOSITORY.test(repository)) {
		throw new Error("repository must have the form owner/name");
	}
	if (!isStorePrewarmRef(ref)) {
		throw new Error("the prewarm ref must be a full commit SHA");
	}
	const image =
		set.spec.template.spec.containers[runnerContainerIndex(set)]?.image;
	if (image === undefined) {
		throw new Error("the runner container names no image");
	}
	const store = PNPM_STORE_CACHE;
	const lockfile = `https://raw.githubusercontent.com/${repository}/${ref}/pnpm-lock.yaml`;
	return {
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: {
			name: storePrewarmJobName(set, ref),
			namespace: set.metadata.namespace,
			labels: {
				[STORE_PREWARM_LABEL]: set.metadata.name,
				[STORE_PREWARM_REF_LABEL]: ref,
			},
		},
		spec: {
			backoffLimit: 2,
			template: {
				spec: {
					restartPolicy: "Never",
					securityContext: { runAsUser: RUNNER_UID, runAsGroup: RUNNER_UID },
					initContainers: [
						{
							name: CACHE_OWNER_INIT,
							image,
							command: [
								"install",
								"-d",
								"-o",
								String(RUNNER_UID),
								"-g",
								String(RUNNER_UID),
								store.mountPath,
							],
							securityContext: { runAsUser: 0, runAsGroup: 0 },
							volumeMounts: [
								{ name: store.volume, mountPath: store.mountPath },
							],
						},
					],
					containers: [
						{
							name: "prewarm",
							image,
							workingDir: "/tmp",
							command: [
								"sh",
								"-ec",
								`mkdir -p /tmp/lock && curl -fsSL --retry 3 ${lockfile} -o /tmp/lock/pnpm-lock.yaml && cd /tmp/lock && pnpm fetch --frozen-lockfile --store-dir ${store.mountPath}`,
							],
							volumeMounts: [
								{ name: store.volume, mountPath: store.mountPath },
							],
						},
					],
					volumes: [
						{
							name: store.volume,
							hostPath: { path: store.hostPath, type: "DirectoryOrCreate" },
						},
					],
				},
			},
		},
	};
}

const StorePrewarmJobSchema = z.looseObject({
	metadata: z.looseObject({
		name: z.string(),
		creationTimestamp: z.string().optional(),
		labels: z.record(z.string(), z.string()).optional(),
	}),
	spec: z.looseObject({ backoffLimit: z.number().optional() }).optional(),
	status: z
		.looseObject({
			succeeded: z.number().optional(),
			failed: z.number().optional(),
			conditions: z
				.array(z.looseObject({ type: z.string(), status: z.string() }))
				.optional(),
		})
		.optional(),
});

export const StorePrewarmJobListSchema = z.looseObject({
	items: z.array(StorePrewarmJobSchema),
});

export type StorePrewarmState = "succeeded" | "failed" | "running";

export type StorePrewarmObservation = Readonly<{
	job: string;
	ref: string;
	state: StorePrewarmState;
}>;

function prewarmState(
	job: z.infer<typeof StorePrewarmJobSchema>,
): StorePrewarmState {
	const conditions = job.status?.conditions ?? [];
	const holds = (type: string) =>
		conditions.some(
			(condition) => condition.type === type && condition.status === "True",
		);
	if (holds("Complete") || (job.status?.succeeded ?? 0) > 0) return "succeeded";
	if (
		holds("Failed") ||
		(job.status?.failed ?? 0) > (job.spec?.backoffLimit ?? 6)
	)
		return "failed";
	return "running";
}

export function latestStorePrewarm(
	list: z.infer<typeof StorePrewarmJobListSchema>,
): StorePrewarmObservation | undefined {
	const latest = [...list.items].sort((left, right) =>
		(right.metadata.creationTimestamp ?? "").localeCompare(
			left.metadata.creationTimestamp ?? "",
		),
	)[0];
	if (latest === undefined) return undefined;
	return {
		job: latest.metadata.name,
		ref: latest.metadata.labels?.[STORE_PREWARM_REF_LABEL] ?? "",
		state: prewarmState(latest),
	};
}
