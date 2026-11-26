import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, parseAllDocuments } from "yaml";
import { z } from "zod";

const mount = z.union([
	z.string(),
	z.object({
		source: z.string(),
		target: z.string(),
		read_only: z.boolean().optional(),
	}),
]);
const composeSchema = z.object({
	services: z.record(
		z.string(),
		z.object({
			user: z.string().optional(),
			read_only: z.boolean().optional(),
			privileged: z.boolean().optional(),
			cap_drop: z.array(z.string()).optional(),
			security_opt: z.array(z.string()).optional(),
			tmpfs: z.array(z.string()).optional(),
			stop_grace_period: z.string().optional(),
			ports: z.array(z.string()).optional(),
			deploy: z.object({ replicas: z.number().optional() }).optional(),
			environment: z.record(z.string(), z.string()),
			volumes: z.array(mount),
			secrets: z.array(z.object({ source: z.string(), target: z.string() })),
		}),
	),
	secrets: z.record(z.string(), z.object({ file: z.string() })),
});
const environment = z.object({
	name: z.string(),
	value: z.string().optional(),
	valueFrom: z
		.object({
			secretKeyRef: z.object({ name: z.string(), key: z.string() }).optional(),
			configMapKeyRef: z
				.object({ name: z.string(), key: z.string() })
				.optional(),
		})
		.optional(),
});
const probe = z.object({
	httpGet: z.object({ path: z.string(), port: z.string() }),
});
const deploymentSchema = z.object({
	kind: z.literal("Deployment"),
	spec: z.object({
		replicas: z.number(),
		strategy: z.object({ type: z.string() }),
		template: z.object({
			spec: z.object({
				automountServiceAccountToken: z.boolean(),
				terminationGracePeriodSeconds: z.number(),
				securityContext: z.object({
					runAsNonRoot: z.boolean(),
					runAsUser: z.number(),
					runAsGroup: z.number(),
					fsGroup: z.number(),
				}),
				containers: z.array(
					z.object({
						name: z.string(),
						env: z.array(environment),
						securityContext: z.object({
							allowPrivilegeEscalation: z.boolean(),
							readOnlyRootFilesystem: z.boolean(),
							privileged: z.boolean().optional(),
							capabilities: z.object({ drop: z.array(z.string()) }),
						}),
						startupProbe: probe,
						readinessProbe: probe,
						livenessProbe: probe,
						volumeMounts: z.array(
							z.object({
								name: z.string(),
								mountPath: z.string(),
								readOnly: z.boolean().optional(),
							}),
						),
					}),
				),
				volumes: z.array(
					z.object({
						name: z.string(),
						persistentVolumeClaim: z
							.object({ claimName: z.string() })
							.optional(),
						secret: z
							.object({
								secretName: z.string(),
								defaultMode: z.number(),
								items: z.array(z.object({ key: z.string(), path: z.string() })),
							})
							.optional(),
						hostPath: z.object({ path: z.string() }).optional(),
					}),
				),
			}),
		}),
	}),
});
const pvcSchema = z.object({
	kind: z.literal("PersistentVolumeClaim"),
	metadata: z.object({ name: z.string() }),
	spec: z.object({ accessModes: z.array(z.string()) }),
});
const serviceSchema = z.object({
	kind: z.literal("Service"),
	spec: z.object({ type: z.string() }),
});

function requireInvariant(condition: boolean, reason: string): void {
	if (!condition) throw new Error(`deployment invariant: ${reason}`);
}

/** Checks the shipped partition manifests before a renderer or cluster receives them. */
export function checkDeployment(input: {
	compose: string;
	kubernetes: string;
	dockerfile: string;
}): void {
	const compose = composeSchema.parse(parse(input.compose));
	const relay = compose.services.relay;
	if (!relay) throw new Error("deployment invariant: missing relay service");
	requireInvariant(
		relay.user === "1000:1000" &&
			relay.read_only === true &&
			relay.privileged !== true,
		"nonroot readonly relay",
	);
	requireInvariant(
		relay.cap_drop?.includes("ALL") === true &&
			relay.security_opt?.includes("no-new-privileges:true") === true,
		"relay capability confinement",
	);
	requireInvariant((relay.deploy?.replicas ?? 1) === 1, "one SQLite writer");
	requireInvariant(relay.stop_grace_period === "90s", "shutdown grace");
	requireInvariant(
		relay.ports?.every((port) => port.startsWith("127.0.0.1:")) === true,
		"HTTP requires loopback proxy boundary",
	);
	requireInvariant(
		relay.tmpfs?.some((entry) => entry.startsWith("/tmp:")) === true,
		"temporary writable filesystem",
	);
	requireInvariant(
		relay.volumes.includes("relay-data:/var/lib/hobo-ci") &&
			relay.environment.HOBO_CI_DB?.startsWith("/var/lib/hobo-ci/") === true,
		"persistent SQLite directory including WAL files",
	);
	for (const value of relay.volumes) {
		requireInvariant(
			!JSON.stringify(value).includes("docker.sock"),
			"no host Docker socket",
		);
		if (!z.string().safeParse(value).success) {
			const binding = z
				.object({ target: z.string(), read_only: z.boolean().optional() })
				.parse(value);
			requireInvariant(
				binding.read_only === true,
				"immutable bound configuration",
			);
		}
	}
	for (const key of [
		"HOBO_CI_GITHUB_APP_KEY_FILE",
		"HOBO_CI_WEBHOOK_SECRET_FILE",
		"HOBO_CI_CONTROL_TOKENS_FILE",
	]) {
		const file = relay.environment[key];
		requireInvariant(
			file?.startsWith("/run/secrets/") === true,
			`secret file ${key}`,
		);
		requireInvariant(
			relay.secrets.some(
				(secret) =>
					`/run/secrets/${secret.target}` === file &&
					compose.secrets[secret.source] !== undefined,
			),
			`mounted secret ${key}`,
		);
	}
	requireInvariant(
		!("HOBO_CI_WEBHOOK_SECRET" in relay.environment),
		"no plaintext webhook secret environment",
	);
	const documents = parseAllDocuments(input.kubernetes).map((document) => {
		if (document.errors.length) throw new Error("invalid Kubernetes YAML");
		return document.toJS();
	});
	const deployments = documents.flatMap((document) => {
		const result = deploymentSchema.safeParse(document);
		return result.success ? [result.data] : [];
	});
	requireInvariant(deployments.length === 1, "exactly one valid deployment");
	const deployment = deployments[0];
	if (!deployment) throw new Error("missing deployment");
	requireInvariant(
		deployment.spec.replicas === 1 &&
			deployment.spec.strategy.type === "Recreate",
		"one writer with Recreate updates",
	);
	const pod = deployment.spec.template.spec;
	requireInvariant(
		!pod.automountServiceAccountToken &&
			pod.terminationGracePeriodSeconds >= 90,
		"no cluster token and graceful shutdown",
	);
	requireInvariant(
		pod.securityContext.runAsNonRoot &&
			pod.securityContext.runAsUser === 1000 &&
			pod.securityContext.runAsGroup === 1000 &&
			pod.securityContext.fsGroup === 1000,
		"nonroot volume ownership",
	);
	requireInvariant(pod.containers.length === 1, "single relay container");
	const container = pod.containers[0];
	if (!container) throw new Error("missing relay container");
	requireInvariant(
		container.securityContext.readOnlyRootFilesystem &&
			!container.securityContext.allowPrivilegeEscalation &&
			container.securityContext.privileged !== true &&
			container.securityContext.capabilities.drop.includes("ALL"),
		"pod capability confinement",
	);
	requireInvariant(
		container.startupProbe.httpGet.path === "/readyz" &&
			container.readinessProbe.httpGet.path === "/readyz" &&
			container.livenessProbe.httpGet.path === "/healthz",
		"separate readiness and liveness contracts",
	);
	requireInvariant(
		pod.volumes.every((volume) => !volume.hostPath),
		"no host filesystem access",
	);
	const databaseMount = container.volumeMounts.find(
		(volume) => volume.mountPath === "/var/lib/hobo-ci",
	);
	const claim = pod.volumes.find(
		(volume) => volume.name === databaseMount?.name,
	)?.persistentVolumeClaim;
	const pvcs = documents.flatMap((document) => {
		const result = pvcSchema.safeParse(document);
		return result.success ? [result.data] : [];
	});
	requireInvariant(
		pvcs.some(
			(pvc) =>
				pvc.metadata.name === claim?.claimName &&
				pvc.spec.accessModes.includes("ReadWriteOnce"),
		),
		"persistent single-writer claim",
	);
	requireInvariant(
		container.env.some(
			(entry) =>
				entry.name === "HOBO_CI_DB" &&
				entry.value?.startsWith("/var/lib/hobo-ci/") === true,
		),
		"pod ledger on persistent directory",
	);
	requireInvariant(
		container.env.some(
			(entry) =>
				entry.name === "HOBO_CI_GITHUB_APP_ID" &&
				entry.valueFrom?.secretKeyRef !== undefined,
		),
		"App identity secret binding",
	);
	for (const key of [
		"HOBO_CI_GITHUB_APP_KEY_FILE",
		"HOBO_CI_WEBHOOK_SECRET_FILE",
		"HOBO_CI_CONTROL_TOKENS_FILE",
	]) {
		const file = container.env.find((entry) => entry.name === key)?.value;
		requireInvariant(
			file?.startsWith("/run/secrets/") === true,
			`pod secret file ${key}`,
		);
		requireInvariant(
			pod.volumes.some(
				(source) =>
					source.secret?.items.some(
						(item) => `/run/secrets/${item.path}` === file,
					) === true,
			),
			`projected secret file ${key}`,
		);
	}
	requireInvariant(
		container.volumeMounts.some(
			(volume) =>
				volume.mountPath === "/run/secrets" &&
				volume.readOnly === true &&
				pod.volumes.some(
					(source) =>
						source.name === volume.name && source.secret?.defaultMode === 0o440,
				),
		),
		"nonroot-readable readonly secret volume",
	);
	const services = documents.flatMap((document) => {
		const result = serviceSchema.safeParse(document);
		return result.success ? [result.data] : [];
	});
	requireInvariant(
		services.length === 1 && services[0]?.spec.type === "ClusterIP",
		"internal service requires external TLS ingress",
	);
	const entrypoint = input.dockerfile
		.split("\n")
		.find((line) => line.startsWith("ENTRYPOINT "));
	if (!entrypoint)
		throw new Error("deployment invariant: missing process entrypoint");
	const command = z
		.array(z.string())
		.parse(JSON.parse(entrypoint.slice("ENTRYPOINT ".length)));
	requireInvariant(
		command[0] === "node" && command.includes("dist/main.js"),
		"relay process receives signals directly",
	);
	requireInvariant(
		input.dockerfile.includes("--frozen-lockfile") &&
			input.dockerfile.includes(
				"turbo run build --filter=@hobo/ci-gh-actions",
			) &&
			input.dockerfile.includes(
				"deploy --prod --offline --config.inject-workspace-packages=true /out",
			),
		"filtered reproducible production build",
	);
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
	const root = new URL("../deploy/", import.meta.url);
	const [compose, kubernetes, dockerfile] = await Promise.all(
		["compose.yml", "kubernetes.yaml", "Dockerfile"].map((name) =>
			readFile(fileURLToPath(new URL(name, root)), "utf8"),
		),
	);
	if (
		compose === undefined ||
		kubernetes === undefined ||
		dockerfile === undefined
	)
		throw new Error("missing deployment inputs");
	checkDeployment({ compose, kubernetes, dockerfile });
	process.stdout.write("HoBo CI deployment invariants verified.\n");
}
