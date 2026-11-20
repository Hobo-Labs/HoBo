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

const sandboxName = /^hobo-([a-f0-9-]{36})$/;
const maximumJitBytes = 262144;

function leaseIdOf(name: string): string {
	const match = sandboxName.exec(name);
	if (!match?.[1]) throw new Error("invalid sandbox name");
	return match[1];
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
	const cpu = pool.cpu ?? (config.vcpus <= 2 ? 2 : config.vcpus <= 4 ? 4 : 8);
	return {
		cpu,
		memory: pool.memory ?? 4,
		disk: pool.disk ?? 20,
	};
}

function metadataOf(pool: Agent37SandboxPool, leaseId: string) {
	return pool.label
		? { hobo: "ci", leaseId, pool: pool.label }
		: { hobo: "ci", leaseId };
}

export function resolveAgent37Network(pool: Agent37SandboxPool) {
	const network = pool.network;
	if (network === undefined)
		throw new Error("agent37 sandbox network allowlist required");
	if (network === "allow-all" || network === "deny-all")
		throw new Error("agent37 sandbox network must be an explicit allow list");
	const allow = network.allow;
	if (allow.length === 0)
		throw new Error("agent37 sandbox network allowlist must not be empty");
	return { allow: [...allow] };
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

function usageOf(
	instance: Agent37Instance | undefined,
	pool: Agent37SandboxPool,
	stoppedAt: number,
): SandboxUsage {
	const startedAt = instance?.created_at
		? Date.parse(instance.created_at)
		: Number.NaN;
	const durationMs =
		Number.isFinite(startedAt) && startedAt <= stoppedAt
			? stoppedAt - startedAt
			: 0;
	const vcpus = instance?.resources.cpu ?? pool.cpu ?? 2;
	return {
		cpuMs: durationMs * vcpus,
		durationMs,
		memoryMb: (instance?.resources.memory ?? pool.memory ?? 4) * 1024,
		vcpus,
		egressBytes: 0,
		ingressBytes: 0,
		creations: 1,
		stoppedAt,
	};
}

function completed(result: Agent37ExecResult) {
	if (!("stdout" in result)) return undefined;
	return result;
}

function commandIdOf(result: Agent37ExecResult, fallback: string): string {
	if ("pid" in result) return String(result.pid);
	if ("id" in result && result.id) return result.id;
	return fallback;
}

// public-contract: the Agent37 runner bootstrap contract verifies this exact single-use start script.
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

export function createAgent37SandboxDriver(
	options: Agent37SandboxDriverOptions,
): IsolatedSandboxDriver {
	const { client, pool } = options;
	const now = options.now ?? Date.now;

	return {
		async create(config) {
			const leaseId = leaseIdOf(config.name);
			const existing = await findInstance(client, config.name, leaseId);
			if (existing) {
				if (existing.status !== "running")
					throw new Error("agent37 instance is not running");
				return { name: config.name, sessionId: existing.id };
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
				network: resolveAgent37Network(pool),
			});
			if (!instance.id) throw new Error("agent37 instance identity missing");
			return { name: config.name, sessionId: instance.id };
		},
		async discover(name) {
			const leaseId = leaseIdOf(name);
			const instance = await findInstance(client, name, leaseId);
			if (!instance) throw new Error("agent37 instance not found");
			return { sessionId: instance.id };
		},
		async prepare(name, sessionId) {
			const result = await client.exec(sessionId, {
				command: PREPARE_AGENT37_RUNNER,
				user: "root",
				name: `prep-${leaseIdOf(name)}`,
			});
			const completedResult = completed(result);
			if (completedResult?.exit_code !== 0)
				throw new Error("agent37 runner preparation failed");
		},
		async start(name, sessionId, jit) {
			if (jit.length > maximumJitBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(jit))
				throw new Error("invalid runner JIT configuration");
			const leaseId = leaseIdOf(name);
			const staged = await client.exec(sessionId, {
				command: stageRunnerJitCommand(jit),
				user: "root",
				name: `jit-${leaseId}`,
			});
			const stagedResult = completed(staged);
			if (stagedResult?.exit_code !== 0)
				throw new Error("agent37 runner JIT staging failed");
			const result = await client.exec(sessionId, {
				command: START_AGENT37_RUNNER,
				user: "root",
				background: true,
				name: `start-${leaseId}`,
			});
			return { cmdId: commandIdOf(result, `start-${leaseId}`) };
		},
		async inspect(_name, sessionId, commandId) {
			const result = await client.exec(sessionId, {
				command: inspectCommand(commandId),
				user: "root",
			});
			const completedResult = completed(result);
			if (!completedResult)
				throw new Error("agent37 command observation unavailable");
			const line = completedResult.stdout.trim().split("\n").at(-1) ?? "";
			if (line.startsWith("exit:")) {
				const code = Number(line.slice("exit:".length));
				return {
					commandId,
					exitCode: Number.isInteger(code) ? code : null,
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
			const usage = usageOf(instance, pool, stoppedAt);
			try {
				await client.deleteInstance(sessionId);
			} catch (error) {
				if (!(error instanceof Agent37Error) || error.status !== 404)
					throw error;
			}
			return usage;
		},
	};
}
