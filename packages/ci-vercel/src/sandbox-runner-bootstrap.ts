import type { Session } from "@vercel/sandbox";
import {
	downloadSandboxRunner,
	SANDBOX_RUNNER_SHA256,
} from "./sandbox-runner-archive.js";
import {
	downloadSandboxIcu,
	SANDBOX_ICU_SHA256,
} from "./sandbox-runner-icu.js";
import { ensureSandboxWorkdir } from "./sandbox-workdir.js";

/**
 * Install and start exactly one ephemeral GitHub runner inside a fresh Sandbox VM.
 * The caller owns the sandbox lifecycle, durable intent, billing and recovery.
 * Never use this on a reused or persistent sandbox.
 */
// Kept entirely constant: neither workflow data nor credentials are interpolated
// into shell code. The tarball is extracted only after the pinned digest matches.
// public-contract: the runner bootstrap contract verifies this exact preparation script.
export const PREPARE_SANDBOX_RUNNER = `set -eu
umask 077
cd /vercel/sandbox
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test -r /etc/os-release
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 26.04
test -r /etc/ssl/certs/ca-certificates.crt
test -s /etc/ssl/certs/ca-certificates.crt
test -f hobo-ci-icu.deb
printf '%s  %s\\n' ${SANDBOX_ICU_SHA256} hobo-ci-icu.deb | sha256sum --check --status
sudo -n env DEBIAN_FRONTEND=noninteractive dpkg -i hobo-ci-icu.deb
rm -f hobo-ci-icu.deb
test -f hobo-ci-runner.tar.gz
printf '%s  %s\\n' ${SANDBOX_RUNNER_SHA256} hobo-ci-runner.tar.gz | sha256sum --check --status
mkdir -m 700 hobo-ci-runner
tar -xzf hobo-ci-runner.tar.gz -C hobo-ci-runner
rm -f hobo-ci-runner.tar.gz
test -x hobo-ci-runner/run.sh
mkdir -m 700 .hobo-ci-home
: > .hobo-ci-prepared
`;

// The JIT payload is consumed only inside the VM, never passed to the Vercel
// command API in argv or environment. The mkdir provides an in-VM one-shot
// guard; the caller must still use durable external fencing for ambiguous calls.
// public-contract: the runner bootstrap contract verifies this exact single-use start script.
export const START_SANDBOX_RUNNER = `set -eu
umask 077
cd /vercel/sandbox
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
exec env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/vercel/sandbox/.hobo-ci-home USER="$(id -un)" LANG=C.UTF-8 NODE_EXTRA_CA_CERTS="$ca_bundle" NODE_USE_SYSTEM_CA=1 AWS_CA_BUNDLE="$ca_bundle" CARGO_HTTP_CAINFO="$ca_bundle" CURL_CA_BUNDLE="$ca_bundle" GIT_SSL_CAINFO="$ca_bundle" GRPC_DEFAULT_SSL_ROOTS_FILE_PATH="$ca_bundle" NPM_CONFIG_CAFILE="$ca_bundle" PIP_CERT="$ca_bundle" REQUESTS_CA_BUNDLE="$ca_bundle" SSL_CERT_FILE="$ca_bundle" ./run.sh --jitconfig "$jit"
`;

export interface SandboxRunnerBootstrapPort {
	writeFiles(
		files: { path: string; content: Buffer; mode: number }[],
	): Promise<void>;
	runCommand(options: {
		cmd: string;
		args: string[];
		cwd: string;
		detached: false;
	}): Promise<{ exitCode: number }>;
	runCommand(options: {
		cmd: string;
		args: string[];
		cwd: string;
		detached: true;
	}): Promise<{ cmdId: string }>;
}

/** Use a specific session: a Sandbox handle may auto-resume after stop. */
export function sandboxRunnerBootstrapPort(
	session: Session,
): SandboxRunnerBootstrapPort {
	return session;
}

/** Must finish successfully before requesting a GitHub JIT registration. */
export async function prepareSandboxRunner(
	sandbox: SandboxRunnerBootstrapPort,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const archive = await downloadSandboxRunner(fetcher);
	const icu = await downloadSandboxIcu(fetcher);
	await ensureSandboxWorkdir(sandbox);
	await sandbox.writeFiles([
		{
			path: "/vercel/sandbox/hobo-ci-runner.tar.gz",
			content: archive,
			mode: 0o600,
		},
		{
			path: "/vercel/sandbox/hobo-ci-icu.deb",
			content: icu,
			mode: 0o600,
		},
	]);
	const result = await sandbox.runCommand({
		cmd: "bash",
		args: ["-c", PREPARE_SANDBOX_RUNNER],
		cwd: "/vercel/sandbox",
		detached: false,
	});
	if (result.exitCode !== 0)
		throw new Error("sandbox runner preparation failed");
}

/** The caller must persist start intent before invoking this non-idempotent operation. */
export async function startSandboxRunner(
	sandbox: SandboxRunnerBootstrapPort,
	encodedJitConfig: string,
): Promise<{ cmdId: string }> {
	if (
		encodedJitConfig.length > 262144 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedJitConfig)
	)
		throw new Error("invalid runner JIT configuration");
	await sandbox.writeFiles([
		{
			path: "/vercel/sandbox/.hobo-ci-jit",
			content: Buffer.from(encodedJitConfig, "utf8"),
			mode: 0o600,
		},
	]);
	const command = await sandbox.runCommand({
		cmd: "bash",
		args: ["-c", START_SANDBOX_RUNNER],
		cwd: "/vercel/sandbox",
		detached: true,
	});
	if (!command.cmdId) throw new Error("sandbox command identity missing");
	return command;
}
