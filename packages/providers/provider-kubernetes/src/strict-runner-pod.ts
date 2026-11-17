import { createHash } from "node:crypto";
import { canonicalJson } from "@hobo/core";
import { parseApiStatus } from "./api.js";
import { errorForApiResponse } from "./client.js";
import { KubernetesProviderError } from "./errors.js";
import {
	asJsonObject,
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type KubernetesTransport,
	type TransportMethod,
	type TransportPolicy,
	type TransportResponse,
} from "./transport.js";

export type RunnerPodToleration = {
	readonly key: string;
	readonly operator: "Equal" | "Exists";
	readonly value?: string;
	readonly effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

export type StrictRunnerPodBinding = {
	readonly connectionId: string;
	readonly namespace: string;
	readonly slotId: string;
	readonly claimId: string;
	readonly accountId: string;
	readonly profileId: string;
	readonly ownerName: string;
	readonly ownerUid: string;
	readonly serviceAccount: string;
	readonly runnerImage: string;
	readonly hookImage: string;
	readonly startFenceUrl: string;
	readonly cpu: string;
	readonly memory: string;
	readonly nodeSelector?: Readonly<Record<string, string>>;
	readonly tolerations?: readonly RunnerPodToleration[];
	readonly runtimeClassName?: string;
};

export type StrictRunnerPodReceipt = {
	readonly connectionId: string;
	readonly namespace: string;
	readonly name: string;
	readonly uid: string;
	readonly specHash: string;
	readonly resourceVersion: string;
	readonly phase: "pending" | "running" | "succeeded" | "failed" | "unknown";
	readonly created: boolean;
};

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/u;
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const IMAGE = /^\S+@sha256:[a-f0-9]{64}$/u;
const LABEL = /^[A-Za-z0-9](?:[-A-Za-z0-9_./]{0,251}[A-Za-z0-9])?$/u;
const POD_ANNOTATION = "hobo.dev/";
const HOOK_PATH = "/opt/hobo/hooks/pre-job";
const DEFAULT_TOLERATIONS = [
	"node.kubernetes.io/not-ready",
	"node.kubernetes.io/unreachable",
];

function refuse(message: string): never {
	throw new KubernetesProviderError("PLACEMENT_REJECTED", message);
}

function validate(binding: StrictRunnerPodBinding): void {
	if (
		!ID.test(binding.connectionId) ||
		!ID.test(binding.claimId) ||
		!ID.test(binding.accountId) ||
		!ID.test(binding.profileId)
	)
		refuse("invalid runner binding identity");
	if (!/^[a-z0-9](?:[-a-z0-9]{0,98}[a-z0-9])?$/u.test(binding.slotId))
		refuse("invalid runner slot ID");
	if (
		![binding.namespace, binding.ownerName, binding.serviceAccount].every(
			(value) => DNS_LABEL.test(value),
		) ||
		!UID.test(binding.ownerUid)
	)
		refuse("invalid runner namespace or ownership");
	if (!IMAGE.test(binding.runnerImage) || !IMAGE.test(binding.hookImage))
		refuse("runner and hook images must be digest-pinned");
	if (
		!/^(?:[1-9]\d*m|[1-9]\d*)$/u.test(binding.cpu) ||
		!/^[1-9]\d*(?:Mi|Gi)$/u.test(binding.memory)
	)
		refuse("invalid runner resource limits");
	let fence: URL;
	try {
		fence = new URL(binding.startFenceUrl);
	} catch {
		refuse("invalid start-fence URL");
	}
	if (
		fence.protocol !== "https:" ||
		fence.username ||
		fence.password ||
		fence.search ||
		fence.hash ||
		fence.pathname !== "/v1/fleet/start-fence"
	)
		refuse("invalid start-fence URL");
	if (binding.runtimeClassName && !DNS_LABEL.test(binding.runtimeClassName))
		refuse("invalid runtime class");
	const selectors = Object.entries(binding.nodeSelector ?? {});
	if (selectors.length > 32) refuse("too many node selectors");
	for (const [key, value] of selectors) {
		if (!LABEL.test(key) || !LABEL.test(value)) refuse("invalid node selector");
	}
	const tolerations = binding.tolerations ?? [];
	if (tolerations.length > 32) refuse("too many runner tolerations");
	const keys = new Set<string>();
	for (const item of tolerations) {
		if (
			!LABEL.test(item.key) ||
			DEFAULT_TOLERATIONS.includes(item.key) ||
			keys.has(item.key) ||
			!["Equal", "Exists"].includes(item.operator) ||
			!["NoSchedule", "PreferNoSchedule", "NoExecute"].includes(item.effect) ||
			(item.operator === "Equal" && (!item.value || !LABEL.test(item.value))) ||
			(item.operator === "Exists" && item.value !== undefined)
		)
			refuse("invalid runner toleration");
		keys.add(item.key);
	}
}

export function strictRunnerPodName(slotId: string): string {
	if (!/^[a-z0-9](?:[-a-z0-9]{0,98}[a-z0-9])?$/u.test(slotId))
		refuse("invalid runner slot ID");
	return `hobo-runner-${createHash("sha256").update(slotId).digest("hex").slice(0, 32)}`;
}

function secretEnv(name: string, secretName: string, key: string): JsonObject {
	return {
		name,
		valueFrom: { secretKeyRef: { name: secretName, key, optional: false } },
	};
}

function securityContext(): JsonObject {
	return {
		allowPrivilegeEscalation: false,
		privileged: false,
		readOnlyRootFilesystem: true,
		runAsNonRoot: true,
		capabilities: { drop: ["ALL"] },
		seccompProfile: { type: "RuntimeDefault" },
	};
}

function runnerPod(binding: StrictRunnerPodBinding) {
	validate(binding);
	const name = strictRunnerPodName(binding.slotId);
	const env: JsonValue[] = [
		{ name: "ACTIONS_RUNNER_HOOK_JOB_STARTED", value: HOOK_PATH },
		{ name: "HOBO_START_FENCE_URL", value: binding.startFenceUrl },
		{ name: "HOBO_SLOT_ID", value: binding.slotId },
		{ name: "HOBO_CLAIM_ID", value: binding.claimId },
		{ name: "HOBO_ACCOUNT_ID", value: binding.accountId },
		{ name: "HOBO_PROFILE_ID", value: binding.profileId },
		secretEnv("HOBO_JIT_CONFIG", name, "jit-config"),
		secretEnv("HOBO_BINDING_SECRET", name, "binding-secret"),
		secretEnv("HOBO_EXECUTION_KEY_JSON", name, "execution-key.json"),
	];
	const resources = {
		requests: { cpu: binding.cpu, memory: binding.memory },
		limits: { cpu: binding.cpu, memory: binding.memory },
	};
	const spec: JsonBag = {
		serviceAccountName: binding.serviceAccount,
		automountServiceAccountToken: false,
		restartPolicy: "Never",
		securityContext: {
			runAsNonRoot: true,
			seccompProfile: { type: "RuntimeDefault" },
		},
		volumes: [
			{ name: "hook", emptyDir: {} },
			{ name: "work", emptyDir: {} },
			{ name: "tmp", emptyDir: {} },
		],
		initContainers: [
			{
				name: "install-hook",
				image: binding.hookImage,
				imagePullPolicy: "IfNotPresent",
				command: [
					"/bin/sh",
					"-ec",
					"cp /opt/hobo/fleet/pre-job.sh /hooks/pre-job && chmod 0555 /hooks/pre-job",
				],
				securityContext: securityContext(),
				volumeMounts: [{ name: "hook", mountPath: "/hooks" }],
			},
		],
		containers: [
			{
				name: "runner",
				image: binding.runnerImage,
				imagePullPolicy: "IfNotPresent",
				args: ["--jitconfig", "$(HOBO_JIT_CONFIG)"],
				env,
				resources,
				securityContext: securityContext(),
				volumeMounts: [
					{ name: "hook", mountPath: "/opt/hobo/hooks", readOnly: true },
					{ name: "work", mountPath: "/opt/actions-runner/_work" },
					{ name: "tmp", mountPath: "/tmp" },
				],
			},
		],
	};
	if (binding.nodeSelector) spec.nodeSelector = binding.nodeSelector;
	if (binding.tolerations)
		spec.tolerations = binding.tolerations.map(asJsonObject);
	if (binding.runtimeClassName)
		spec.runtimeClassName = binding.runtimeClassName;
	const specHash = createHash("sha256")
		.update(canonicalJson(spec))
		.digest("hex");
	return {
		name,
		specHash,
		manifest: {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name,
				namespace: binding.namespace,
				annotations: {
					[`${POD_ANNOTATION}connection-id`]: binding.connectionId,
					[`${POD_ANNOTATION}slot-id`]: binding.slotId,
					[`${POD_ANNOTATION}claim-id`]: binding.claimId,
					[`${POD_ANNOTATION}spec-sha256`]: specHash,
				},
				ownerReferences: [
					{
						apiVersion: "v1",
						kind: "ConfigMap",
						name: binding.ownerName,
						uid: binding.ownerUid,
						controller: true,
						blockOwnerDeletion: true,
					},
				],
			},
			spec,
		},
	};
}

function object(value: JsonValue | undefined): JsonObject {
	if (!isJsonObject(value))
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"apiserver returned an invalid Pod",
		);
	return value;
}

function matches(expected: JsonValue, actual: JsonValue | undefined): boolean {
	if (isJsonArray(expected))
		return (
			isJsonArray(actual) &&
			expected.length === actual.length &&
			expected.every((entry, index) => matches(entry, actual[index]))
		);
	if (isJsonObject(expected))
		return (
			isJsonObject(actual) &&
			Object.entries(expected).every(([key, value]) =>
				matches(value, actual[key]),
			)
		);
	return expected === actual;
}

function allowedKeys(value: JsonObject, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function verifyContainer(
	expected: JsonValue,
	actual: JsonValue | undefined,
): boolean {
	if (
		!isJsonObject(expected) ||
		!isJsonObject(actual) ||
		!matches(expected, actual)
	)
		return false;
	if (
		!allowedKeys(actual, [
			"name",
			"image",
			"imagePullPolicy",
			"command",
			"args",
			"env",
			"resources",
			"securityContext",
			"volumeMounts",
			"terminationMessagePath",
			"terminationMessagePolicy",
		])
	)
		return false;
	const expectedSecurity = object(expected.securityContext);
	const actualSecurity = object(actual.securityContext);
	if (!allowedKeys(actualSecurity, Object.keys(expectedSecurity))) return false;
	const expectedCapabilities = object(expectedSecurity.capabilities);
	const actualCapabilities = object(actualSecurity.capabilities);
	if (!allowedKeys(actualCapabilities, Object.keys(expectedCapabilities)))
		return false;
	if (
		canonicalJson(actualSecurity.seccompProfile) !==
		canonicalJson(expectedSecurity.seccompProfile)
	)
		return false;
	if (expected.resources === undefined) {
		if (canonicalJson(actual.resources ?? {}) !== canonicalJson({}))
			return false;
	} else if (
		canonicalJson(actual.resources) !== canonicalJson(expected.resources)
	)
		return false;
	if (canonicalJson(actual.env ?? []) !== canonicalJson(expected.env ?? []))
		return false;
	if (
		!isJsonArray(actual.volumeMounts) ||
		actual.volumeMounts.some(
			(mount) =>
				!isJsonObject(mount) ||
				!allowedKeys(mount, ["name", "mountPath", "readOnly"]),
		)
	)
		return false;
	if (
		canonicalJson(actual.volumeMounts) !== canonicalJson(expected.volumeMounts)
	)
		return false;
	if (
		actual.terminationMessagePath !== undefined &&
		actual.terminationMessagePath !== "/dev/termination-log"
	)
		return false;
	return (
		actual.terminationMessagePolicy === undefined ||
		actual.terminationMessagePolicy === "File"
	);
}

function verifyTolerations(
	expected: JsonValue | undefined,
	actual: JsonValue | undefined,
): boolean {
	const wanted = expected ?? [];
	const found = actual ?? [];
	if (!isJsonArray(wanted) || !isJsonArray(found)) return false;
	const remaining = [...found];
	for (const entry of wanted) {
		const index = remaining.findIndex(
			(candidate) => canonicalJson(candidate) === canonicalJson(entry),
		);
		if (index < 0) return false;
		remaining.splice(index, 1);
	}
	const seen = new Set<string>();
	return remaining.every((item) => {
		if (
			!isJsonObject(item) ||
			!isJsonString(item.key) ||
			!DEFAULT_TOLERATIONS.includes(item.key) ||
			seen.has(item.key)
		)
			return false;
		seen.add(item.key);
		return (
			canonicalJson(item) ===
			canonicalJson({
				key: item.key,
				operator: "Exists",
				effect: "NoExecute",
				tolerationSeconds: 300,
			})
		);
	});
}

function verifySpec(expected: JsonObject, actual: JsonObject): boolean {
	if (
		!allowedKeys(actual, [
			"volumes",
			"initContainers",
			"containers",
			"restartPolicy",
			"terminationGracePeriodSeconds",
			"dnsPolicy",
			"serviceAccountName",
			"serviceAccount",
			"automountServiceAccountToken",
			"nodeName",
			"securityContext",
			"schedulerName",
			"tolerations",
			"priority",
			"enableServiceLinks",
			"preemptionPolicy",
			"nodeSelector",
			"runtimeClassName",
			"hostNetwork",
			"hostPID",
			"hostIPC",
			"shareProcessNamespace",
			"ephemeralContainers",
		])
	)
		return false;
	if (
		!Object.entries(expected).every(
			([key, value]) => key === "tolerations" || matches(value, actual[key]),
		)
	)
		return false;
	if (!verifyTolerations(expected.tolerations, actual.tolerations))
		return false;
	if (actual.dnsPolicy !== undefined && actual.dnsPolicy !== "ClusterFirst")
		return false;
	if (
		actual.schedulerName !== undefined &&
		actual.schedulerName !== "default-scheduler"
	)
		return false;
	if (
		actual.serviceAccount !== undefined &&
		actual.serviceAccount !== expected.serviceAccountName
	)
		return false;
	if (
		actual.terminationGracePeriodSeconds !== undefined &&
		actual.terminationGracePeriodSeconds !== 30
	)
		return false;
	if (
		actual.enableServiceLinks !== undefined &&
		actual.enableServiceLinks !== true
	)
		return false;
	if (actual.priority !== undefined && actual.priority !== 0) return false;
	if (
		actual.preemptionPolicy !== undefined &&
		actual.preemptionPolicy !== "PreemptLowerPriority"
	)
		return false;
	if (
		canonicalJson(actual.securityContext) !==
		canonicalJson(expected.securityContext)
	)
		return false;
	if (
		["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"].some(
			(key) => actual[key] === true,
		)
	)
		return false;
	if (
		isJsonArray(actual.ephemeralContainers) &&
		actual.ephemeralContainers.length > 0
	)
		return false;
	for (const key of ["containers", "initContainers"]) {
		const wanted = expected[key];
		const found = actual[key];
		if (
			!isJsonArray(wanted) ||
			!isJsonArray(found) ||
			wanted.length !== found.length ||
			!wanted.every((entry, index) => verifyContainer(entry, found[index]))
		)
			return false;
	}
	const volumes = actual.volumes;
	if (
		!isJsonArray(volumes) ||
		volumes.some(
			(entry) =>
				!isJsonObject(entry) ||
				!allowedKeys(entry, ["name", "emptyDir"]) ||
				!isJsonObject(entry.emptyDir) ||
				!allowedKeys(entry.emptyDir, ["medium"]) ||
				(entry.emptyDir.medium !== undefined && entry.emptyDir.medium !== ""),
		)
	)
		return false;
	if (actual.runtimeClassName !== expected.runtimeClassName) return false;
	if (
		canonicalJson(actual.nodeSelector ?? {}) !==
		canonicalJson(expected.nodeSelector ?? {})
	)
		return false;
	return true;
}

function podPhase(
	value: JsonValue | undefined,
): StrictRunnerPodReceipt["phase"] {
	switch (value) {
		case "Pending":
			return "pending";
		case "Running":
			return "running";
		case "Succeeded":
			return "succeeded";
		case "Failed":
			return "failed";
		default:
			return "unknown";
	}
}

function receipt(
	body: string,
	binding: StrictRunnerPodBinding,
	expectedUid: string | undefined,
	created: boolean,
): StrictRunnerPodReceipt {
	let raw: JsonValue;
	try {
		raw = JSON.parse(body);
	} catch {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"apiserver returned invalid Pod JSON",
		);
	}
	const actual = object(raw);
	const expected = runnerPod(binding);
	const metadata = object(actual.metadata);
	const expectedMetadata = object(expected.manifest.metadata);
	const uid = metadata.uid;
	const resourceVersion = metadata.resourceVersion;
	if (
		actual.apiVersion !== "v1" ||
		actual.kind !== "Pod" ||
		!isJsonString(uid) ||
		!UID.test(uid) ||
		!isJsonString(resourceVersion) ||
		!/^[A-Za-z0-9]{1,128}$/u.test(resourceVersion) ||
		metadata.deletionTimestamp !== undefined ||
		(isJsonArray(metadata.finalizers) && metadata.finalizers.length > 0) ||
		(expectedUid !== undefined && uid !== expectedUid) ||
		!matches(expectedMetadata, metadata) ||
		!verifySpec(object(expected.manifest.spec), object(actual.spec))
	) {
		throw new KubernetesProviderError(
			"PROVISIONING_CONFLICT",
			"runner Pod identity or specification does not match the recorded claim",
		);
	}
	const status = isJsonObject(actual.status) ? actual.status : {};
	return {
		connectionId: binding.connectionId,
		namespace: binding.namespace,
		name: expected.name,
		uid,
		specHash: expected.specHash,
		resourceVersion,
		phase: podPhase(status.phase),
		created,
	};
}

export function createStrictRunnerPodClient(options: {
	readonly transport: KubernetesTransport;
	readonly apiServerUrl: string;
	readonly policy?: TransportPolicy;
}) {
	const policy = options.policy ?? DEFAULT_TRANSPORT_POLICY;
	const transport = createGuardedTransport(options.transport, policy);
	let base: URL;
	try {
		base = new URL(options.apiServerUrl);
	} catch {
		return refuse("invalid apiserver origin");
	}
	if (
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== "/"
	)
		refuse("invalid apiserver origin");
	async function call(
		method: TransportMethod,
		path: string,
		body?: JsonObject,
	): Promise<TransportResponse> {
		const request = {
			method,
			url: `${base.origin}${path}`,
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			timeoutMs: policy.timeoutMs,
			maxResponseBytes: policy.maxResponseBytes,
		};
		try {
			return await transport.request(
				body === undefined
					? request
					: { ...request, body: JSON.stringify(body) },
			);
		} catch (error) {
			if (method === "GET" && error instanceof KubernetesProviderError)
				throw error;
			throw new KubernetesProviderError(
				"PROVIDER_OPERATION_AMBIGUOUS",
				`apiserver ${method} did not complete`,
			);
		}
	}
	async function observe(
		binding: StrictRunnerPodBinding,
		uid: string,
	): Promise<StrictRunnerPodReceipt | undefined> {
		validate(binding);
		if (!UID.test(uid)) refuse("invalid recorded runner Pod UID");
		const response = await call(
			"GET",
			`/api/v1/namespaces/${binding.namespace}/pods/${strictRunnerPodName(binding.slotId)}`,
		);
		if (response.status === 404) return undefined;
		if (response.status !== 200)
			throw errorForApiResponse(response, {
				method: "GET",
				what: "runner Pod",
			});
		return receipt(response.body, binding, uid, false);
	}
	return {
		async create(
			binding: StrictRunnerPodBinding,
			recordedUid?: string,
		): Promise<StrictRunnerPodReceipt> {
			const desired = runnerPod(binding);
			if (recordedUid !== undefined) {
				const existing = await observe(binding, recordedUid);
				if (!existing)
					throw new KubernetesProviderError(
						"PROVIDER_OPERATION_AMBIGUOUS",
						"recorded runner Pod is absent; reconcile before retrying",
					);
				return existing;
			}
			const response = await call(
				"POST",
				`/api/v1/namespaces/${binding.namespace}/pods`,
				desired.manifest,
			);
			if (response.status === 201) {
				try {
					return receipt(response.body, binding, undefined, true);
				} catch {
					throw new KubernetesProviderError(
						"PROVIDER_OPERATION_AMBIGUOUS",
						"runner Pod was created but its identity could not be verified",
					);
				}
			}
			if (response.status === 409) {
				try {
					if (parseApiStatus(response.body).reason === "AlreadyExists")
						throw new KubernetesProviderError(
							"PROVISIONING_CONFLICT",
							"runner Pod name exists without a recorded UID",
						);
				} catch (error) {
					if (
						error instanceof KubernetesProviderError &&
						error.code === "PROVISIONING_CONFLICT"
					)
						throw error;
				}
			}
			throw errorForApiResponse(response, {
				method: "POST",
				what: "runner Pod",
			});
		},
		observe,
		async remove(
			binding: StrictRunnerPodBinding,
			uid: string,
		): Promise<boolean> {
			const existing = await observe(binding, uid);
			if (!existing) return false;
			const response = await call(
				"DELETE",
				`/api/v1/namespaces/${binding.namespace}/pods/${existing.name}`,
				{ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid } },
			);
			if (response.status === 200 || response.status === 202) return true;
			if (response.status === 404) return false;
			throw errorForApiResponse(response, {
				method: "DELETE",
				what: "runner Pod",
			});
		},
	};
}
