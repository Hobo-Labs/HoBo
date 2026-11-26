import {
	type Agent37Client,
	Agent37Error,
	type Agent37ExecResult,
	type Agent37Instance,
} from "@hobo/provider-agent37";
import type { IsolatedSandboxConfiguration } from "./isolated-sandbox.js";
import type {
	IsolatedSandboxDriver,
	SandboxUsage,
} from "./sandbox-controller.js";
import {
	SANDBOX_RUNNER_SHA256,
	SANDBOX_RUNNER_URL,
} from "./sandbox-runner-archive.js";

export type Agent37SandboxPool = {
	template: string;
	type: "default" | "vm" | "performance";
	region?: "us" | "eu" | "ap-south";
	cpu?: number;
	memory?: number;
	disk?: number;
	network?: "allow-all" | "deny-all" | { readonly allow: readonly string[] };
	idleTimeoutSeconds?: number;
	label?: string;
};

export type Agent37SandboxDriverOptions = {
	client: Agent37Client;
	pool: Agent37SandboxPool;
	now?: () => number;
};

const sandboxNamePattern = /^hobo-([a-f0-9-]{36})$/;
const hostnamePattern =
	/^(?=.{1,253}$)(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|\*\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63})$/;
const maximumJitBytes = 262_144;

function leaseIdOf(name: string): string {
	const leaseId = sandboxNamePattern.exec(name)?.[1];
	if (!leaseId) throw new Error("invalid sandbox name");
	return leaseId;
}

export function validAgent37NetworkHostname(value: string): boolean {
	return hostnamePattern.test(value);
}

export function parseAgent37NetworkAllow(values: readonly string[]): string[] {
	if (values.length === 0 || values.length > 100)
		throw new Error(
			"agent37 sandbox network allowlist must contain 1-100 entries",
		);
	if (
		new Set(values).size !== values.length ||
		values.some((value) => !validAgent37NetworkHostname(value))
	)
		throw new Error("invalid or repeated agent37 network hostname");
	return [...values];
}

export function resolveAgent37Network(pool: Agent37SandboxPool) {
	const { network } = pool;
	if (network === undefined)
		throw new Error("agent37 sandbox network allowlist required");
	if (network === "allow-all" || network === "deny-all")
		throw new Error("agent37 sandbox network must be an explicit allow list");
	return { allow: parseAgent37NetworkAllow(network.allow) };
}

function idleTimeoutSeconds(
	timeoutMs: number,
	configured: number | undefined,
): number {
	const seconds = Math.ceil(timeoutMs / 1000);
	return Math.min(Math.max(configured ?? seconds, 300), 86_400);
}

function resourcesOf(
	config: IsolatedSandboxConfiguration,
	pool: Agent37SandboxPool,
) {
	return {
		cpu: pool.cpu ?? (config.vcpus <= 2 ? 2 : config.vcpus <= 4 ? 4 : 8),
		memory: pool.memory ?? 4,
		disk: pool.disk ?? 20,
	};
}

function metadataOf(pool: Agent37SandboxPool, leaseId: string) {
	if (pool.label === undefined) return { hobo: "ci", leaseId };
	return { hobo: "ci", leaseId, pool: pool.label };
}

function sameNetwork(
	instance: Agent37Instance,
	pool: Agent37SandboxPool,
): boolean {
	const expected = resolveAgent37Network(pool).allow;
	if (instance.network === "allow-all" || instance.network === "deny-all")
		return false;
	return (
		instance.network.allow.length === expected.length &&
		instance.network.allow.every((entry, index) => entry === expected[index])
	);
}

function verifyReusableInstance(
	instance: Agent37Instance,
	config: IsolatedSandboxConfiguration,
	pool: Agent37SandboxPool,
	leaseId: string,
): void {
	const resources = resourcesOf(config, pool);
	if (
		instance.status !== "running" ||
		instance.name !== config.name ||
		instance.metadata?.leaseId !== leaseId ||
		instance.template !== pool.template ||
		instance.type !== pool.type ||
		instance.region !== (pool.region ?? "us") ||
		instance.resources.cpu !== resources.cpu ||
		instance.resources.memory !== resources.memory ||
		instance.resources.disk !== resources.disk ||
		!sameNetwork(instance, pool)
	)
		throw new Error("agent37 instance does not match the requested lease");
}

async function findInstance(
	client: Agent37Client,
	name: string,
	leaseId: string,
): Promise<Agent37Instance | undefined> {
	const matches = (await client.listInstances()).filter(
		(instance) =>
			instance.metadata?.leaseId === leaseId || instance.name === name,
	);
	if (matches.length > 1) throw new Error("agent37 instance lookup ambiguous");
	return matches[0];
}

function completedExec(result: Agent37ExecResult) {
	return "stdout" in result ? result : undefined;
}

function commandIdOf(result: Agent37ExecResult, fallback: string): string {
	if ("pid" in result) return String(result.pid);
	if ("id" in result && result.id) return result.id;
	return fallback;
}

// public-contract: the runner bootstrap contract verifies this single-use script.
export const START_AGENT37_RUNNER = `set -eu
umask 077
cd "$HOME"
trap 'rm -f .hobo-ci-jit' EXIT
test -f .hobo-ci-prepared
test -f .hobo-ci-jit
mkdir -m 700 .hobo-ci-started
jit=$(cat .hobo-ci-jit)
rm -f .hobo-ci-jit
trap - EXIT
test -n "$jit"
test -d .hobo-ci-home
ca_bundle=/etc/ssl/certs/ca-certificates.crt
test -r "$ca_bundle"
test -s "$ca_bundle"
cd hobo-ci-runner
set +e
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME="$HOME/.hobo-ci-home" USER="$(id -un)" LANG=C.UTF-8 NODE_EXTRA_CA_CERTS="$ca_bundle" NODE_USE_SYSTEM_CA=1 AWS_CA_BUNDLE="$ca_bundle" CARGO_HTTP_CAINFO="$ca_bundle" CURL_CA_BUNDLE="$ca_bundle" GIT_SSL_CAINFO="$ca_bundle" GRPC_DEFAULT_SSL_ROOTS_FILE_PATH="$ca_bundle" NPM_CONFIG_CAFILE="$ca_bundle" PIP_CERT="$ca_bundle" REQUESTS_CA_BUNDLE="$ca_bundle" SSL_CERT_FILE="$ca_bundle" ./run.sh --jitconfig "$jit"
code=$?
set -e
printf '%s\\n' "$code" > "$HOME/.hobo-ci-exit"
exit "$code"
`;

const PREPARE_AGENT37_RUNNER = `set -eu
umask 077
cd "$HOME"
test "$(uname -s)" = Linux
if command -v dockerd >/dev/null 2>&1 && ! pgrep -x dockerd >/dev/null 2>&1; then
  (dockerd --data-root "$HOME/docker" >/dev/null 2>&1 &)
fi
curl -fsSL ${SANDBOX_RUNNER_URL} -o hobo-ci-runner.tar.gz
printf '%s  %s\\n' ${SANDBOX_RUNNER_SHA256} hobo-ci-runner.tar.gz | sha256sum --check --status
mkdir -m 700 hobo-ci-runner
tar -xzf hobo-ci-runner.tar.gz -C hobo-ci-runner
rm -f hobo-ci-runner.tar.gz
test -x hobo-ci-runner/run.sh
mkdir -m 700 .hobo-ci-home
: > .hobo-ci-prepared
`;

function stageRunnerJitCommand(jit: string): string {
	return `set -eu
umask 077
cd "$HOME"
test -f .hobo-ci-prepared
cat > .hobo-ci-jit <<'HOBO_RUNNER_JIT'
${jit}
HOBO_RUNNER_JIT
chmod 600 .hobo-ci-jit
test -s .hobo-ci-jit
`;
}

function inspectCommand(commandId: string): string {
	const probe = /^\d+$/.test(commandId)
		? `kill -0 ${commandId} 2>/dev/null`
		: "pgrep -f 'hobo-ci-runner/.*Runner.Listener' >/dev/null 2>&1";
	return `set -eu
cd "$HOME"
if [ -f .hobo-ci-exit ]; then
  printf 'exit:%s\\n' "$(cat .hobo-ci-exit)"
elif ${probe}; then
  printf 'running\\n'
else
  printf 'gone\\n'
fi
`;
}

export function createAgent37SandboxDriver(
	options: Agent37SandboxDriverOptions,
): IsolatedSandboxDriver {
	const { client, pool } = options;
	const now = options.now ?? Date.now;
	const creations = new Map<string, number>();

	return {
		async create(config) {
			const leaseId = leaseIdOf(config.name);
			const network = resolveAgent37Network(pool);
			const existing = await findInstance(client, config.name, leaseId);
			if (existing) {
				verifyReusableInstance(existing, config, pool, leaseId);
				if (!creations.has(existing.id)) creations.set(existing.id, 0);
				return {
					name: config.name,
					sessionId: existing.id,
					expiresAt: now() + config.timeoutMs,
				};
			}
			const instance = await client.createInstance({
				template: pool.template,
				type: pool.type,
				region: pool.region ?? "us",
				resources: resourcesOf(config, pool),
				name: config.name,
				metadata: metadataOf(pool, leaseId),
				env: { HOBO_LEASE_ID: leaseId },
				auto_sleep: false,
				idle_timeout_seconds: idleTimeoutSeconds(
					config.timeoutMs,
					pool.idleTimeoutSeconds,
				),
				network,
			});
			creations.set(instance.id, 1);
			return {
				name: config.name,
				sessionId: instance.id,
				expiresAt: now() + config.timeoutMs,
			};
		},
		async discover(name) {
			const leaseId = leaseIdOf(name);
			const instance = await findInstance(client, name, leaseId);
			if (
				!instance ||
				instance.name !== name ||
				instance.metadata?.leaseId !== leaseId
			)
				throw new Error("agent37 instance not found");
			const config: IsolatedSandboxConfiguration = {
				name,
				timeoutMs: (pool.idleTimeoutSeconds ?? 300) * 1000,
				vcpus: pool.cpu ?? 2,
				plan: "hobby",
				forwardUrl: "https://ci.example.com/sandbox/egress",
				allowedDomains: [],
			};
			verifyReusableInstance(instance, config, pool, leaseId);
			return { sessionId: instance.id };
		},
		async prepare(name, sessionId) {
			const result = completedExec(
				await client.exec(sessionId, {
					command: PREPARE_AGENT37_RUNNER,
					user: "root",
					name: `prep-${leaseIdOf(name)}`,
				}),
			);
			if (result?.exit_code !== 0)
				throw new Error("agent37 runner preparation failed");
		},
		async start(name, sessionId, jit) {
			if (
				jit.length === 0 ||
				jit.length > maximumJitBytes ||
				jit.length % 4 !== 0 ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(jit)
			)
				throw new Error("invalid runner JIT configuration");
			const leaseId = leaseIdOf(name);
			const staged = completedExec(
				await client.exec(sessionId, {
					command: stageRunnerJitCommand(jit),
					user: "root",
					name: `jit-${leaseId}`,
				}),
			);
			if (staged?.exit_code !== 0)
				throw new Error("agent37 runner JIT staging failed");
			const started = await client.exec(sessionId, {
				command: START_AGENT37_RUNNER,
				user: "root",
				background: true,
				name: `start-${leaseId}`,
			});
			return { cmdId: commandIdOf(started, `start-${leaseId}`) };
		},
		async inspect(_name, sessionId, commandId) {
			const result = completedExec(
				await client.exec(sessionId, {
					command: inspectCommand(commandId),
					user: "root",
				}),
			);
			if (!result) throw new Error("agent37 command observation unavailable");
			const line = result.stdout.trim().split("\n").at(-1) ?? "";
			if (line.startsWith("exit:")) {
				const code = Number(line.slice(5));
				return {
					commandId,
					exitCode: Number.isInteger(code) && code >= 0 ? code : null,
					terminal: true,
				};
			}
			if (line === "running")
				return { commandId, exitCode: null, terminal: false };
			return { commandId, exitCode: null, terminal: true };
		},
		async stop(_name, sessionId) {
			let instance: Agent37Instance | undefined;
			try {
				instance = await client.getInstance(sessionId);
			} catch (error) {
				if (!(error instanceof Agent37Error) || error.status !== 404)
					throw error;
			}
			const stoppedAt = now();
			const startedAt = instance?.created_at
				? Date.parse(instance.created_at)
				: Number.NaN;
			const durationMs =
				Number.isFinite(startedAt) && startedAt <= stoppedAt
					? stoppedAt - startedAt
					: 0;
			const vcpus = instance?.resources.cpu ?? pool.cpu ?? 2;
			const usage: SandboxUsage = {
				cpuMs: durationMs * vcpus,
				durationMs,
				memoryMb: (instance?.resources.memory ?? pool.memory ?? 4) * 1024,
				vcpus,
				egressBytes: 0,
				ingressBytes: 0,
				creations: creations.get(sessionId) ?? 0,
				stoppedAt,
			};
			try {
				await client.deleteInstance(sessionId);
			} catch (error) {
				if (!(error instanceof Agent37Error) || error.status !== 404)
					throw error;
			}
			creations.delete(sessionId);
			return usage;
		},
	};
}
