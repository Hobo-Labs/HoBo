import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { create, toJson } from "@bufbuild/protobuf";
import type { CredentialResolver } from "@hobo/cd";
import {
	type AutoscalingRunnerSet,
	AutoscalingRunnerSetListSchema,
	AutoscalingRunnerSetSchema,
	arcRunnerCachePatch,
	isStorePrewarmRef,
	latestStorePrewarm,
	STORE_PREWARM_LABEL,
	StorePrewarmJobListSchema,
	storePrewarmJob,
	storePrewarmJobName,
} from "@hobo/ci-gh-actions/arc-runner-caches";
import {
	parseCiProjectConfig,
	selectCiEnvironment,
} from "@hobo/ci-gh-actions/project-config";
import type { CommandResult } from "@hobo/cli";
import {
	type HttpTransport,
	type JsonValue,
	TransportGuardError,
} from "@hobo/core";
import {
	type ArcRunnerSetClient,
	createArcRunnerSetClient,
	createKubernetesHttpsTransport,
	type KubernetesClusterAccess,
	KubernetesProviderError,
	type KubernetesTlsMaterial,
	parseKubeconfig,
} from "@hobo/provider-kubernetes";
import { ZodError, z } from "zod";

import {
	type CiFleetCachePrewarm,
	CiFleetCachePrewarmSchema,
	type CiFleetCacheScaleSet,
	CiFleetCacheScaleSetSchema,
	CiFleetCachesSchema,
} from "./_generated/ci_fleet_pb.js";

const CREDENTIAL_SCOPE = "hobo-ci-fleet-caches";
const CI_PROJECT_PATH = ".hobo/ci.json";
const KUBERNETES_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const CACHES_USAGE =
	"Use hobo ci fleet caches [--scale-set <name>...] [--namespace <ns>] [--cluster <pool>] [--prewarm <sha>] [--plan|--apply|--status].";

export type FleetCluster = Readonly<{
	id: string;
	connectionRef: string;
	namespace: string;
}>;

type CachesMode = "plan" | "apply" | "status";

const CACHES_MODES: readonly CachesMode[] = ["plan", "apply", "status"];

export function kubeconfigEntryName(connectionRef: string): string {
	return `${connectionRef.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_KUBECONFIG`;
}

const CiProjectEnvironmentsSchema = z.looseObject({
	defaultEnvironment: z.string().optional(),
	templates: z.record(z.string(), z.json()).optional(),
	environments: z.record(z.string(), z.json()),
});

export async function loadFleetClusters(
	repositoryRoot: string,
): Promise<readonly FleetCluster[]> {
	const document = CiProjectEnvironmentsSchema.parse(
		JSON.parse(await readFile(join(repositoryRoot, CI_PROJECT_PATH), "utf8")),
	);
	const name = document.defaultEnvironment ?? "ci";
	const config = parseCiProjectConfig(
		JSON.stringify({
			defaultEnvironment: name,
			...(document.templates !== undefined
				? { templates: document.templates }
				: undefined),
			environments: { [name]: document.environments[name] ?? null },
		}),
	);
	return selectCiEnvironment(config, name).policy.providers.flatMap(
		(provider) =>
			provider.kind === "kubernetes" && provider.capacity.case === "scaleSet"
				? [
						{
							id: provider.id,
							connectionRef: provider.connectionRef,
							namespace: provider.capacity.value.namespace,
						},
					]
				: [],
	);
}

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function refused(code: string, message: string): CommandResult {
	return { ok: false, status: "refused", code, message };
}

function credentialUnavailable(entry: string): CommandResult {
	return {
		ok: false,
		status: "credential_unavailable",
		code: "HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE",
		message: `hobo ci fleet caches needs owner://${entry} from the owner's store session, and none resolved. Run HoBo MCP's choose_secret_store to connect the owner's store, then ask again.`,
		remediation: [
			"Call the HoBo MCP tool choose_secret_store for this project directory.",
			`Have the owner store the cluster's kubeconfig in that store under ${entry}.`,
		],
	};
}

async function resolveKubeconfig(
	credentials: CredentialResolver,
	entry: string,
): Promise<string | undefined> {
	for (const ref of [`owner://${entry}`, `env://${entry}`]) {
		const material = await credentials
			.resolve(ref, CREDENTIAL_SCOPE)
			.catch(() => undefined);
		const kubeconfig = material?.token;
		if (kubeconfig !== undefined && kubeconfig !== "") return kubeconfig;
	}
	return undefined;
}

function parseCachesArgs(args: readonly string[]) {
	try {
		return parseArgs({
			args: [...args],
			allowPositionals: false,
			strict: true,
			options: {
				"scale-set": { type: "string", multiple: true },
				namespace: { type: "string" },
				cluster: { type: "string" },
				prewarm: { type: "string" },
				repo: { type: "string" },
				plan: { type: "boolean" },
				apply: { type: "boolean" },
				status: { type: "boolean" },
			},
		}).values;
	} catch {
		return undefined;
	}
}

function chosenMode(values: {
	plan?: boolean;
	apply?: boolean;
	status?: boolean;
}): CachesMode | undefined {
	const chosen = CACHES_MODES.filter((mode) => values[mode] === true);
	if (chosen.length > 1) return undefined;
	return chosen[0] ?? "plan";
}

function chooseCluster(
	clusters: readonly FleetCluster[],
	wanted: string | undefined,
): FleetCluster | CommandResult {
	if (wanted !== undefined) {
		const found = clusters.find((cluster) => cluster.id === wanted);
		return (
			found ??
			refused(
				"HOBO_CI_FLEET_CACHES_NO_CLUSTER",
				`.hobo/ci.json has no kubernetes pool ${wanted} with a scale set.`,
			)
		);
	}
	const [only, ...others] = clusters;
	if (only === undefined)
		return refused(
			"HOBO_CI_FLEET_CACHES_NO_CLUSTER",
			".hobo/ci.json declares no kubernetes pool with a scale set, so hobo ci fleet caches has no cluster to reach.",
		);
	if (others.length > 0)
		return usage(
			`.hobo/ci.json declares several kubernetes pools (${clusters.map((cluster) => cluster.id).join(", ")}); name one with --cluster.`,
		);
	return only;
}

function scrubbed(text: string, secrets: readonly string[]): string {
	return secrets
		.filter((secret) => secret.length >= 8)
		.reduce((clean, secret) => clean.split(secret).join("[redacted]"), text);
}

type WireOperation = Readonly<{
	op: "test" | "add";
	path: string;
	value: JsonValue;
}>;

function patchRecord(set: AutoscalingRunnerSet) {
	const additions: WireOperation[] = arcRunnerCachePatch(set).map(
		(operation) => ({
			op: operation.op,
			path: operation.path,
			value: operation.value,
		}),
	);
	const version = set.metadata.resourceVersion;
	const wire: WireOperation[] =
		additions.length > 0 && version !== undefined
			? [
					{ op: "test", path: "/metadata/resourceVersion", value: version },
					...additions,
				]
			: additions;
	return { additions, wire };
}

function operationRecords(wire: readonly WireOperation[]) {
	return wire.map((operation) => ({
		op: operation.op,
		path: operation.path,
		valueJson: JSON.stringify(operation.value),
	}));
}

async function observedPrewarm(
	client: ArcRunnerSetClient,
	set: AutoscalingRunnerSet,
): Promise<CiFleetCachePrewarm> {
	const latest = latestStorePrewarm(
		StorePrewarmJobListSchema.parse(
			await client.listJobs(
				set.metadata.namespace,
				`${STORE_PREWARM_LABEL}=${set.metadata.name}`,
			),
		),
	);
	return create(
		CiFleetCachePrewarmSchema,
		latest === undefined ? { state: "absent" } : latest,
	);
}

async function requestedPrewarm(
	client: ArcRunnerSetClient,
	set: AutoscalingRunnerSet,
	mode: CachesMode,
	repository: string,
	ref: string,
): Promise<CiFleetCachePrewarm> {
	const job = storePrewarmJob(set, repository, ref);
	const state =
		mode === "apply"
			? await client.createJob(set.metadata.namespace, job)
			: "planned";
	return create(CiFleetCachePrewarmSchema, {
		job: storePrewarmJobName(set, ref),
		ref,
		state,
	});
}

async function cacheScaleSet(input: {
	client: ArcRunnerSetClient;
	namespace: string;
	name: string;
	mode: CachesMode;
	prewarm: Readonly<{ repository: string; ref: string }> | undefined;
}): Promise<CiFleetCacheScaleSet | CommandResult> {
	const raw = await input.client.readRunnerSet(input.namespace, input.name);
	if (raw === undefined)
		return refused(
			"HOBO_CI_FLEET_SCALE_SET_NOT_FOUND",
			`No AutoscalingRunnerSet ${input.namespace}/${input.name} on the cluster.`,
		);
	const set = AutoscalingRunnerSetSchema.parse(raw);
	const { additions, wire } = patchRecord(set);
	const applying = input.mode === "apply" && additions.length > 0;
	if (applying)
		await input.client.patchRunnerSet(input.namespace, input.name, wire);
	const prewarm =
		input.mode === "status"
			? await observedPrewarm(input.client, set)
			: input.prewarm !== undefined
				? await requestedPrewarm(
						input.client,
						set,
						input.mode,
						input.prewarm.repository,
						input.prewarm.ref,
					)
				: undefined;
	return create(CiFleetCacheScaleSetSchema, {
		name: input.name,
		namespace: input.namespace,
		cachesMounted: additions.length === 0 || applying,
		patchState:
			additions.length === 0 ? "current" : applying ? "applied" : "planned",
		patch: operationRecords(wire),
		...(prewarm !== undefined ? { prewarm } : undefined),
	});
}

function isRecord(
	value: CiFleetCacheScaleSet | CommandResult,
): value is CiFleetCacheScaleSet {
	return "$typeName" in value;
}

function prewarmLine(prewarm: CiFleetCachePrewarm | undefined): string {
	if (prewarm === undefined) return "";
	if (prewarm.state === "absent") return "; no store prewarm Job";
	return `; store prewarm ${prewarm.job} ${prewarm.state}`;
}

function scaleSetLine(record: CiFleetCacheScaleSet): string {
	const caches =
		record.patchState === "current"
			? "caches mounted"
			: record.patchState === "applied"
				? `caches mounted now (${record.patch.length} patch operations applied)`
				: `caches missing (${record.patch.length} patch operations planned; run with --apply)`;
	return `${record.namespace}/${record.name}: ${caches}${prewarmLine(record.prewarm)}`;
}

function failure(error: Error, secrets: readonly string[]): CommandResult {
	if (error instanceof KubernetesProviderError)
		return {
			ok: false,
			status:
				error.code === "PROVIDER_AUTH_FAILED" ||
				error.code === "ROUTE_REFUSED" ||
				error.code === "KUBECONFIG_UNSUPPORTED"
					? "refused"
					: "provider_error",
			code:
				error.code === "KUBECONFIG_UNSUPPORTED"
					? "HOBO_CI_FLEET_KUBECONFIG_UNSUPPORTED"
					: `KUBERNETES_${error.code}`,
			message: scrubbed(error.message, secrets),
		};
	if (error instanceof TransportGuardError)
		return refused(error.code, scrubbed(error.message, secrets));
	if (error instanceof ZodError)
		return {
			ok: false,
			status: "provider_error",
			code: "HOBO_CI_FLEET_CACHES_UNEXPECTED_OBJECT",
			message:
				"The apiserver returned an object that is not an AutoscalingRunnerSet or Job list.",
		};
	return {
		ok: false,
		status: "provider_error",
		code: "HOBO_CI_FLEET_CACHES_FAILED",
		message: scrubbed(error.message, secrets),
	};
}

export async function runCiFleetCaches(input: {
	readonly args: readonly string[];
	readonly repository: string | undefined;
	readonly clusters: () => Promise<readonly FleetCluster[]>;
	readonly credentials: CredentialResolver | undefined;
	readonly transport: (tls: KubernetesTlsMaterial) => HttpTransport;
}): Promise<CommandResult> {
	const values = parseCachesArgs(input.args);
	if (values === undefined) return usage(CACHES_USAGE);
	const mode = chosenMode(values);
	if (mode === undefined)
		return usage("Choose one of --plan, --apply or --status.");
	const names = values["scale-set"] ?? [];
	if (
		!names.every((name) => KUBERNETES_NAME.test(name)) ||
		(values.namespace !== undefined && !KUBERNETES_NAME.test(values.namespace))
	)
		return usage("Scale set and namespace names are Kubernetes object names.");
	if (values.prewarm !== undefined && mode === "status")
		return usage("--prewarm creates a Job; use it with --plan or --apply.");
	if (values.prewarm !== undefined && !isStorePrewarmRef(values.prewarm))
		return usage("--prewarm takes a full 40-character commit SHA.");
	const repository = values.repo ?? input.repository;
	if (values.prewarm !== undefined && repository === undefined)
		return usage(
			"--prewarm needs the GitHub repository: run it in a checkout whose origin is on GitHub, or pass --repo <owner/name>.",
		);
	const clusters = await input.clusters().catch(() => []);
	const cluster = chooseCluster(clusters, values.cluster);
	if (!("connectionRef" in cluster)) return cluster;
	const entry = kubeconfigEntryName(cluster.connectionRef);
	if (input.credentials === undefined) return credentialUnavailable(entry);
	const kubeconfig = await resolveKubeconfig(input.credentials, entry);
	if (kubeconfig === undefined) return credentialUnavailable(entry);
	let access: KubernetesClusterAccess;
	try {
		access = parseKubeconfig(kubeconfig);
	} catch (error) {
		return failure(
			error instanceof Error ? error : new Error("kubeconfig refused"),
			[kubeconfig],
		);
	}
	const secrets = [kubeconfig, ...access.secrets];
	const namespace = values.namespace ?? cluster.namespace;
	const prewarm =
		values.prewarm !== undefined && repository !== undefined
			? { repository, ref: values.prewarm }
			: undefined;
	try {
		const client = createArcRunnerSetClient({
			transport: input.transport(access.tls),
			apiServerUrl: access.apiServerUrl,
			...(access.bearerToken !== undefined
				? { bearerToken: access.bearerToken }
				: undefined),
		});
		const targets =
			names.length > 0
				? names
				: AutoscalingRunnerSetListSchema.parse(
						await client.listRunnerSets(namespace),
					).items.map((item) => item.metadata.name);
		if (targets.length === 0)
			return refused(
				"HOBO_CI_FLEET_SCALE_SET_NOT_FOUND",
				`The cluster has no AutoscalingRunnerSet in namespace ${namespace}.`,
			);
		const scaleSets: CiFleetCacheScaleSet[] = [];
		for (const name of targets) {
			const outcome = await cacheScaleSet({
				client,
				namespace,
				name,
				mode,
				prewarm,
			});
			if (!isRecord(outcome)) return outcome;
			scaleSets.push(outcome);
		}
		const record = create(CiFleetCachesSchema, {
			cluster: cluster.id,
			namespace,
			mode,
			scaleSets,
		});
		return {
			message: [
				`ARC runner node caches on ${cluster.id} (${mode}):`,
				...scaleSets.map(scaleSetLine),
			].join("\n"),
			data: {
				fleetCaches: toJson(CiFleetCachesSchema, record, {
					alwaysEmitImplicit: true,
				}),
			},
		};
	} catch (error) {
		return failure(
			error instanceof Error ? error : new Error("the cluster call failed"),
			secrets,
		);
	}
}

export function defaultKubernetesTransport(
	tls: KubernetesTlsMaterial,
): HttpTransport {
	return createKubernetesHttpsTransport(tls);
}
