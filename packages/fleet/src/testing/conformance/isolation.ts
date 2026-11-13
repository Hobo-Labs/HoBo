/**
 * `runSandboxIsolationProbe` (design §7.3, §6.11, O10): creates real
 * sandboxes from `make` and runs probe programs inside them with
 * `Sandbox.exec`, from `probeImage` (a busybox image: `sh`, `grep`, `find`,
 * `wget`, `touch`, `sleep`). No fake passes it; the fake driver fails it.
 *
 * Each probe is a shell script that prints raw facts as lines starting with
 * `@@`, ending with `@@done`; the suite judges the facts, so a probe that
 * printed nothing proves nothing and fails. The probe's name travels in the
 * `HOBO_PROBE` environment variable.
 *
 * Network probes classify each `wget` attempt: `direct` attempts bypass the
 * proxy (`-Y off`) and must get no HTTP answer at all; `proxy` attempts go
 * through the proxy the driver configures inside the sandbox, which must
 * refuse with 403 (or 407) or by closing the connection. The allowed host
 * must answer through the proxy (any status but 403 and 407) and not directly.
 *
 * Assumptions an adapter must meet, recorded with L29: the driver sets the
 * proxy environment (`http_proxy`, `https_proxy`) inside the sandbox from
 * `egressProxyUrl`; declared mounts appear at their `target`; and the host's
 * `/proc` shows a container's processes (for the destroy check; on a host
 * without `/proc` that check finds nothing left by construction).
 */
import { randomBytes } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EgressProxyFactory,
	ObservedAssignment,
	Sandbox,
	SandboxDriver,
} from "../../ports.js";
import {
	type ConformanceAssertion,
	ensure,
	eventually,
	pause,
} from "./assertion.js";
import { fenceArgv, run } from "./sandbox.js";

export type IsolationProbe = Readonly<{
	make: () => Promise<SandboxDriver>;
	options: Readonly<{
		probeImage: string;
		allowedHost: string;
		egress: EgressProxyFactory;
	}>;
}>;

/** Where the probe mounts its one declared, read-only directory. */
// public-contract: the target a driver under runSandboxIsolationProbe must mount the declared directory at.
export const PROBE_MOUNT = "/hobo-probe-ro";
/** The pids limit the probe asks for; the fork probe must stop below it. */
export const PROBE_PIDS = 64;
const MARKER_FILE = "marker";
const PROBE_TIMEOUT_MS = 60_000;

/** Pseudo and memory file systems a sandbox may mount anywhere. */
const PSEUDO_FILESYSTEMS = new Set([
	"proc",
	"sysfs",
	"devpts",
	"mqueue",
	"tmpfs",
	"devtmpfs",
	"cgroup",
	"cgroup2",
	"securityfs",
	"shm",
	"none",
]);
/** Files every OCI runtime bind-mounts from the host, read-only or not. */
const RUNTIME_FILES = new Set([
	"/etc/hosts",
	"/etc/hostname",
	"/etc/resolv.conf",
]);

type Facts = Readonly<{
	output: string;
	exitCode: number;
	/** `@@<name> <rest>` lines, by name. */
	facts: ReadonlyMap<string, string>;
	done: boolean;
}>;

function readFacts(output: string, exitCode: number): Facts {
	const facts = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = /^@@(\S+)\s?(.*)$/u.exec(line.trim());
		if (match?.[1] !== undefined) facts.set(match[1], match[2] ?? "");
	}
	return { output, exitCode, facts, done: facts.has("done") };
}

async function probe(
	sandbox: Sandbox,
	name: string,
	script: string,
	stdin?: Uint8Array,
): Promise<Facts> {
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	const options = { env: { HOBO_PROBE: name }, signal };
	const result = await run(
		sandbox,
		["sh", "-c", script],
		stdin === undefined ? options : { ...options, stdin },
	);
	return readFacts(result.output, result.exitCode);
}

const requireDone = (facts: Facts, name: string) =>
	ensure(
		facts.done,
		`the ${name} probe printed no facts (exit ${facts.exitCode}): ${facts.output.slice(0, 200)}`,
	);

type Session = Readonly<{
	driver: SandboxDriver;
	sandbox: Sandbox;
	fenceCalls: ObservedAssignment[];
	create: (
		fence: (observed: ObservedAssignment) => Promise<boolean>,
	) => Promise<Sandbox>;
}>;

/** Makes a driver, an egress proxy allowing only `allowedHost`, a declared read-only mount, and one sandbox. */
async function withSandbox(
	subject: IsolationProbe,
	use: (session: Session) => Promise<void>,
): Promise<void> {
	const driver = await subject.make();
	const proxy = await subject.options.egress.open([
		subject.options.allowedHost,
	]);
	const mount = mkdtempSync(join(tmpdir(), "hobo-probe-"));
	writeFileSync(join(mount, MARKER_FILE), "hobo-probe");
	const sandboxes: Sandbox[] = [];
	const fenceCalls: ObservedAssignment[] = [];
	const create = async (
		fence: (observed: ObservedAssignment) => Promise<boolean>,
	): Promise<Sandbox> => {
		const sandbox = await driver.create({
			orderId: `probe-${randomBytes(8).toString("hex")}`,
			image: subject.options.probeImage,
			limits: { memoryMb: 256, cpus: 1, pids: PROBE_PIDS, diskMb: 256 },
			egressProxyUrl: proxy.url,
			readOnlyMounts: [{ source: mount, target: PROBE_MOUNT }],
			hostDocker: false,
			fence,
		});
		sandboxes.push(sandbox);
		return sandbox;
	};
	try {
		const sandbox = await create(async (observed) => {
			fenceCalls.push(observed);
			return true;
		});
		await use({ driver, sandbox, fenceCalls, create });
	} finally {
		for (const sandbox of sandboxes)
			await sandbox.destroy().catch(() => undefined);
		await proxy.close();
		rmSync(mount, { recursive: true, force: true });
	}
}

/** One `wget` attempt per line: `@@<name> <exit code> <HTTP status or empty>`. */
const ATTEMPT = `attempt() {
  out=$(wget $3 -q -T 8 -O /dev/null "$2" 2>&1)
  code=$?
  status=$(printf '%s' "$out" | grep -o 'HTTP/1\\.[01] [0-9][0-9][0-9]' | head -n 1 | cut -d ' ' -f 2)
  echo "@@$1 $code $status"
}
`;

type Attempt = "answered" | "refused-by-proxy" | "unanswered";

function attemptOf(facts: Facts, name: string): Attempt {
	const fact = facts.facts.get(name);
	ensure(fact !== undefined, `the probe printed no result for ${name}`);
	const [code, status] = fact.split(" ");
	if (code === "0") return "answered";
	if (status === undefined || status === "") return "unanswered";
	return status === "403" || status === "407" ? "refused-by-proxy" : "answered";
}

/** The probe of one address: refused directly and through the proxy. */
async function refusedEverywhere(
	subject: IsolationProbe,
	name: string,
	url: string,
): Promise<void> {
	await withSandbox(subject, async ({ sandbox }) => {
		const facts = await probe(
			sandbox,
			name,
			`${ATTEMPT}attempt proxy '${url}' ''\nattempt direct '${url}' '-Y off'\necho @@done`,
		);
		requireDone(facts, name);
		ensure(
			attemptOf(facts, "direct") === "unanswered",
			`${url} answered a direct request from inside the sandbox`,
		);
		ensure(
			attemptOf(facts, "proxy") !== "answered",
			`${url} answered through the egress proxy`,
		);
	});
}

type Mount = Readonly<{
	target: string;
	fstype: string;
	options: readonly string[];
}>;

const mountsOf = (output: string): Mount[] =>
	output
		.split("\n")
		.map((line) => line.trim().split(/\s+/u))
		.filter(
			(fields) => fields.length >= 4 && !(fields[0] ?? "").startsWith("@@"),
		)
		.map((fields) => ({
			target: (fields[1] ?? "").replaceAll("\\040", " "),
			fstype: fields[2] ?? "",
			options: (fields[3] ?? "").split(","),
		}));

/** Host processes whose argv is `sleep <marker>`; none when the host has no `/proc`. */
function hostProcessesRunning(marker: string): number {
	let entries: string[];
	try {
		entries = readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry));
	} catch {
		return 0;
	}
	let count = 0;
	for (const entry of entries) {
		try {
			const argv = readFileSync(join("/proc", entry, "cmdline"), "utf8").split(
				"\0",
			);
			if (argv.includes(marker) && argv.some((arg) => arg.endsWith("sleep")))
				count += 1;
		} catch {
			// The process ended between listing and reading.
		}
	}
	return count;
}

/** The isolation assertions, in the order they are registered. */
export const ISOLATION_ASSERTIONS: readonly ConformanceAssertion<IsolationProbe>[] =
	[
		{
			name: "the sandbox runs with no effective capabilities",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox }) => {
					const facts = await probe(
						sandbox,
						"capabilities",
						"echo \"@@capeff $(grep '^CapEff:' /proc/self/status | cut -f 2)\"; echo @@done",
					);
					requireDone(facts, "capabilities");
					const capeff = facts.facts.get("capeff") ?? "";
					ensure(
						/^[0-9a-f]+$/u.test(capeff) && BigInt(`0x${capeff}`) === 0n,
						`CapEff is ${capeff === "" ? "unreadable" : capeff}, want 0`,
					);
				});
			},
		},
		{
			name: "no Docker socket is reachable at any path",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox }) => {
					const facts = await probe(
						sandbox,
						"docker-socket",
						"find / \\( -path /proc -o -path /sys \\) -prune -o -type s -print 2>/dev/null | sed 's/^/@@socket /'; echo \"@@docker-host ${DOCKER_HOST:-}\"; echo @@done",
					);
					requireDone(facts, "docker-socket");
					const sockets = facts.output
						.split("\n")
						.filter((line) => line.startsWith("@@socket "))
						.map((line) => line.slice("@@socket ".length).trim());
					const docker = sockets.filter((path) =>
						/(docker|containerd|podman)[^/]*\.sock$/u.test(path),
					);
					ensure(
						docker.length === 0,
						`container sockets inside the sandbox: ${docker.join(", ")}`,
					);
					ensure(
						(facts.facts.get("docker-host") ?? "") === "",
						"DOCKER_HOST is set inside the sandbox",
					);
				});
			},
		},
		{
			name: "only declared mounts are present, besides pseudo file systems and the runtime's own files",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox }) => {
					const facts = await probe(
						sandbox,
						"mounts",
						`cat /proc/self/mounts; echo "@@marker $(cat ${PROBE_MOUNT}/${MARKER_FILE} 2>/dev/null)"; echo @@done`,
					);
					requireDone(facts, "mounts");
					ensure(
						facts.facts.get("marker") === "hobo-probe",
						`the declared mount ${PROBE_MOUNT} is not present`,
					);
					const extra = mountsOf(facts.output).filter(
						(mount) =>
							mount.target !== "/" &&
							mount.target !== PROBE_MOUNT &&
							!RUNTIME_FILES.has(mount.target) &&
							!PSEUDO_FILESYSTEMS.has(mount.fstype) &&
							// gVisor's sentry always mounts its own internal `dev` file system at /dev (D58); it is not a host mount.
							!(mount.target === "/dev" && mount.fstype === "dev"),
					);
					ensure(
						extra.length === 0,
						`undeclared mounts: ${extra.map((mount) => `${mount.target} (${mount.fstype})`).join(", ")}`,
					);
				});
			},
		},
		{
			name: "the root file system and the declared mount are read-only",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox }) => {
					const facts = await probe(
						sandbox,
						"read-only",
						`touch /.hobo-probe 2>/dev/null; echo "@@root $?"; touch ${PROBE_MOUNT}/.hobo-probe 2>/dev/null; echo "@@mount $?"; echo @@done`,
					);
					requireDone(facts, "read-only");
					ensure(
						facts.facts.get("root") !== "0",
						"the root file system is writable",
					);
					ensure(
						facts.facts.get("mount") !== "0",
						`the declared mount ${PROBE_MOUNT} is writable`,
					);
				});
			},
		},
		{
			name: "the metadata address is refused",
			async check(subject) {
				await refusedEverywhere(
					subject,
					"metadata",
					"http://169.254.169.254/latest/meta-data/",
				);
			},
		},
		{
			name: "a link-local address is refused",
			async check(subject) {
				await refusedEverywhere(subject, "link-local", "http://169.254.170.2/");
			},
		},
		{
			name: "a host outside the allow list is refused",
			async check(subject) {
				const host =
					subject.options.allowedHost === "example.com"
						? "example.org"
						: "example.com";
				await refusedEverywhere(subject, "outside-allow", `https://${host}/`);
			},
		},
		{
			name: "the allowed host is reached through the egress proxy, and only through it",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox }) => {
					const url = `https://${subject.options.allowedHost}/`;
					const facts = await probe(
						sandbox,
						"allowed",
						`${ATTEMPT}attempt proxy '${url}' ''\nattempt direct '${url}' '-Y off'\necho @@done`,
					);
					requireDone(facts, "allowed");
					ensure(
						attemptOf(facts, "proxy") === "answered",
						`${url} was not reached through the egress proxy`,
					);
					ensure(
						attemptOf(facts, "direct") === "unanswered",
						`${url} was reached directly, bypassing the egress proxy`,
					);
				});
			},
		},
		{
			name: "a fork loop is stopped at the pids limit",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox }) => {
					const facts = await probe(
						sandbox,
						"fork",
						`n=0; while [ $n -lt 512 ]; do sleep 30 & n=$((n+1)); done; echo "@@spawned $n"; echo "@@running $(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"; echo @@done`,
					);
					const stopped =
						/can't fork|Resource temporarily unavailable|fork: /iu.test(
							facts.output,
						);
					const running = Number(facts.facts.get("running") ?? "NaN");
					ensure(
						stopped || (facts.done && running <= PROBE_PIDS),
						`a fork loop ran ${facts.facts.get("spawned") ?? "?"} processes (${Number.isNaN(running) ? "unknown" : running} running) past a pids limit of ${PROBE_PIDS}`,
					);
				});
			},
		},
		{
			name: "a sandbox's controlUrl is unreachable from a second sandbox of the same driver",
			async check(subject) {
				await withSandbox(subject, async ({ sandbox, fenceCalls, create }) => {
					const body = new TextEncoder().encode(
						JSON.stringify({
							workKey: "probe/work#1",
							repository: "hobo/probe",
							ref: "refs/heads/main",
							author: "probe",
							origin: 1,
						}),
					);
					const fence = (url: string) =>
						`out=$(${fenceArgv(url)
							.map((arg) => `'${arg}'`)
							.join(
								" ",
							)} 2>/dev/null); code=$?; echo "@@answer $out"; echo "@@exit $code"; echo @@done`;
					const own = await probe(
						sandbox,
						"fence-own",
						fence(sandbox.controlUrl),
						body,
					);
					requireDone(own, "fence-own");
					ensure(
						(own.facts.get("answer") ?? "").includes('"allow":true') &&
							fenceCalls.length === 1,
						"the sandbox could not reach its own controlUrl, so the check proves nothing",
					);
					const second = await create(async () => true);
					const other = await probe(
						second,
						"fence-other",
						fence(sandbox.controlUrl),
						body,
					);
					requireDone(other, "fence-other");
					ensure(
						fenceCalls.length === 1 &&
							!(other.facts.get("answer") ?? "").includes("allow") &&
							other.facts.get("exit") !== "0",
						"a second sandbox reached the first sandbox's controlUrl",
					);
				});
			},
		},
		{
			name: "no container or VM is left after destroy",
			async check(subject) {
				const marker = `7${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
				await withSandbox(subject, async ({ sandbox }) => {
					const running = sandbox
						.exec({
							argv: ["sleep", marker],
							env: { HOBO_PROBE: "leftover" },
							signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
							onOutput() {},
						})
						.catch(() => ({ exitCode: -1 }));
					await eventually(
						() => hostProcessesRunning(marker) > 0,
						5_000,
						"unused",
					).catch(() => undefined);
					await sandbox.destroy();
					await Promise.race([running, pause(10_000)]);
				});
				await eventually(
					() => hostProcessesRunning(marker) === 0,
					10_000,
					`a process of a destroyed sandbox (sleep ${marker}) is still running`,
				);
			},
		},
	];
