/**
 * Local substrate auto-discovery: inspect the machine a default localhost
 * Station is running on and report, per *hosting substrate*, whether this box
 * can actually run a workload that way — then turn the substrates that are
 * present into Yards the Station can register.
 *
 * Today `seedLocalhostYard()` (ADR-0157) gives a localhost Station exactly one
 * Yard, `yard:local`, decided purely from capability observations. That seed is
 * substrate-blind: it does not know whether this machine has a WASM toolchain,
 * a container engine, a WSL2 guest kernel, LXC/Incus, systemd-nspawn, or KVM +
 * Firecracker. This module supplies the missing axis, and keeps three rules
 * that the seed already holds:
 *
 * - **Pure over injected probes.** Detection never reads `process.env`, never
 *   shells out, never touches the network, and never looks at the clock. The
 *   only way in is a `LocalSubstrateProbes` record, so a test can describe a
 *   whole machine as data. A timestamp, if wanted, is an injected `now`.
 * - **Nothing is silently omitted.** Every substrate in the closed vocabulary
 *   appears in the report, absent ones with a remediation naming what to change.
 *   A dropped substrate reads as "HoBo has no opinion here" when the truth is
 *   "this box cannot host that way".
 * - **Evidence or it did not happen.** `present: true` requires at least one
 *   concrete evidence row (a binary path, a socket path, a file inspected). The
 *   invariant is asserted, not merely intended, and a violation is a typed
 *   refusal rather than an optimistic claim.
 *
 * Fidelity (ADR-0042) is assigned honestly and deliberately conservatively: see
 * `SUBSTRATE_BINDINGS` below for why only the process-shaped substrates earn
 * `real`, WASM is `simulated`, and the container/microVM substrates are
 * `camp-only`.
 */

import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
	LOCALHOST_PROVIDER_ID,
	LOCALHOST_YARD_NAME,
	type LocalhostCapabilityObservation,
	type SeedFidelity,
	type SeedProvenance,
	seedLocalhostYard,
	type Yard,
	yard,
} from "@hobo/yards";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: wire schema of a persisted local-substrate discovery report.
export const LOCAL_SUBSTRATE_REPORT_CONTRACT =
	"hobo.local-substrates/v1" as const;

// public-contract: wire schema of the Yard set derived from a substrate report.
export const LOCAL_SUBSTRATE_YARDS_CONTRACT =
	"hobo.local-substrate-yards/v1" as const;

/**
 * Closed vocabulary of local hosting substrates — each entry is a distinct way
 * this machine can run a workload, not a capability of a workload. Declared in
 * sorted order because that order *is* the report order.
 */
export const LOCAL_SUBSTRATE_KINDS = Object.freeze([
	"firecracker",
	"lxc",
	"nspawn",
	"oci",
	"process",
	"wasm",
	"wsl2",
] as const);

export type LocalSubstrateKind = (typeof LOCAL_SUBSTRATE_KINDS)[number];

export type LocalSubstrateErrorCode =
	| "LOCAL_SUBSTRATE_EVIDENCE_MISSING"
	| "LOCAL_SUBSTRATE_KIND_UNKNOWN"
	| "LOCAL_SUBSTRATE_PROBES_INVALID"
	| "LOCAL_SUBSTRATE_REPORT_INVALID";

/**
 * Refusal from substrate discovery or one of its parse boundaries. Always
 * carries a code and a remediation naming what to change; `kind` is set when
 * the refusal is attributable to one substrate.
 */
export class LocalSubstrateError extends Error {
	readonly code: LocalSubstrateErrorCode;
	readonly remediation: string;
	readonly kind?: LocalSubstrateKind;

	constructor(
		code: LocalSubstrateErrorCode,
		message: string,
		options?: {
			readonly remediation: string;
			readonly kind?: LocalSubstrateKind;
		},
	) {
		const remediation = options?.remediation ?? "";
		super(remediation.length > 0 ? `${message} — ${remediation}` : message);
		this.name = "LocalSubstrateError";
		this.code = code;
		this.remediation = remediation;
		if (options?.kind !== undefined) {
			this.kind = options.kind;
		}
	}
}

/** Injectable host probes — discovery reads the machine only through these. */
export interface LocalSubstrateProbes {
	/** Resolve a binary on PATH; absolute path when found, else `null`. */
	readonly which: (binary: string) => string | null;
	/** Does this path exist (file, directory, device node, or socket)? */
	readonly exists: (path: string) => boolean;
	/** Read a text file; `null` when unreadable (never throws). */
	readonly readText: (path: string) => string | null;
	/** Snapshot of the environment; discovery never reads `process.env`. */
	readonly env: Readonly<Record<string, string>>;
	readonly platform: NodeJS.Platform;
	readonly nodeVersion: string;
}

export interface LocalSubstrateFinding {
	readonly kind: LocalSubstrateKind;
	readonly present: boolean;
	/** Concrete things inspected. Non-empty whenever `present` is true. */
	readonly evidence: readonly string[];
	/** What the evidence actually proves — deliberately narrower than `present`. */
	readonly detail: string;
	/** Set only when absent: what to change to make this substrate available. */
	readonly remediation?: string;
}

export interface LocalSubstrateReport {
	readonly contract: typeof LOCAL_SUBSTRATE_REPORT_CONTRACT;
	readonly platform: NodeJS.Platform;
	/** One finding per `LOCAL_SUBSTRATE_KINDS` entry, sorted by kind. */
	readonly substrates: readonly LocalSubstrateFinding[];
	/** Present only when an explicit `now` was injected. */
	readonly discoveredAt?: string;
}

export interface LocalSubstrateYardRow {
	readonly profile: string;
	readonly productId: string;
	readonly provenance: SeedProvenance;
	readonly fidelity: SeedFidelity;
}

export interface LocalSubstrateYardEntry {
	readonly kind: LocalSubstrateKind;
	readonly yardName: string;
	readonly yard: Yard;
	readonly rows: readonly LocalSubstrateYardRow[];
	readonly evidence: readonly string[];
	readonly detail: string;
}

export interface LocalSubstrateYardSet {
	readonly contract: typeof LOCAL_SUBSTRATE_YARDS_CONTRACT;
	readonly yards: readonly LocalSubstrateYardEntry[];
	/** Absent substrates, never dropped — each with the reason it is absent. */
	readonly unavailable: readonly {
		readonly kind: LocalSubstrateKind;
		readonly reason: string;
	}[];
	/** Capability-profile gaps inherited from `seedLocalhostYard()`. */
	readonly profileGaps: readonly {
		readonly profile: string;
		readonly reason: string;
	}[];
}

export interface LocalSubstrateRegistration {
	readonly report: LocalSubstrateReport;
	readonly yards: LocalSubstrateYardSet;
}

/* -------------------------------------------------------------------------- */
/* probes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Real probes over PATH, `node:fs`, and `node:os`. This is the only function in
 * the module allowed to touch the ambient host; everything downstream is pure
 * over what it returns.
 */
export function defaultLocalSubstrateProbes(
	env: NodeJS.ProcessEnv = process.env,
): LocalSubstrateProbes {
	const paths = (env.PATH ?? "").split(delimiter).filter((p) => p.length > 0);
	const envSnap: { [key: string]: string } = {};
	for (const key of Object.keys(env).sort()) {
		const value = env[key];
		if (isJsonString(value)) envSnap[key] = value;
	}
	return Object.freeze({
		which: (binary: string) => {
			for (const dir of paths) {
				const candidate = join(dir, binary);
				if (existsSync(candidate)) return candidate;
			}
			return null;
		},
		exists: (path: string) => existsSync(path),
		readText: (path: string) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		env: Object.freeze(envSnap),
		platform: process.platform,
		nodeVersion: process.versions.node,
	});
}

/**
 * Parse boundary. Untrusted probe input crosses here once and becomes a frozen
 * derived record with an environment *snapshot*, so a later mutation of the
 * caller's env cannot change what discovery sees.
 */
function asNodePlatform(value: string): NodeJS.Platform {
	// SAFETY: host probe platform is a NodeJS.Platform token.
	return value as NodeJS.Platform;
}

function requireProbeFn(value: JsonValue | undefined, name: string): object {
	if (!(value instanceof Function)) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_PROBES_INVALID",
			`local substrate probes ${name} must be a function`,
			{
				remediation:
					"pass the record returned by defaultLocalSubstrateProbes()",
			},
		);
	}
	return value;
}

function asWhich(
	value: JsonValue | undefined,
): (binary: string) => string | null {
	const fn = requireProbeFn(value, "which");
	// SAFETY: probe functions are host callbacks captured at the parse boundary.
	return fn as (binary: string) => string | null;
}

function asExists(value: JsonValue | undefined): (path: string) => boolean {
	const fn = requireProbeFn(value, "exists");
	// SAFETY: probe functions are host callbacks captured at the parse boundary.
	return fn as (path: string) => boolean;
}

function asReadText(
	value: JsonValue | undefined,
): (path: string) => string | null {
	const fn = requireProbeFn(value, "readText");
	// SAFETY: probe functions are host callbacks captured at the parse boundary.
	return fn as (path: string) => string | null;
}

export function parseLocalSubstrateProbes(
	input: JsonValue | LocalSubstrateProbes,
): LocalSubstrateProbes {
	if (!isJsonObject(input) || input === null || Array.isArray(input)) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_PROBES_INVALID",
			"local substrate probes must be an object",
			{
				remediation:
					"pass the record returned by defaultLocalSubstrateProbes(), or a fake with which/exists/readText/env/platform/nodeVersion",
			},
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const source = input as JsonObject;
	for (const fn of ["which", "exists", "readText"] as const) {
		if (!(source[fn] instanceof Function)) {
			throw new LocalSubstrateError(
				"LOCAL_SUBSTRATE_PROBES_INVALID",
				`local substrate probe "${fn}" must be a function`,
				{
					remediation: `supply ${fn}() on the probes record — discovery has no fallback host access`,
				},
			);
		}
	}
	if (!isJsonString(source.platform) || source.platform.length === 0) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_PROBES_INVALID",
			'local substrate probe "platform" must be a non-empty string',
			{
				remediation:
					'set platform to a NodeJS.Platform value such as "linux" or "darwin"',
			},
		);
	}
	if (!isJsonString(source.nodeVersion) || source.nodeVersion.length === 0) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_PROBES_INVALID",
			'local substrate probe "nodeVersion" must be a non-empty string',
			{
				remediation:
					"set nodeVersion to the running Node version, e.g. process.versions.node",
			},
		);
	}
	const rawEnv = source.env;
	if (!isJsonObject(rawEnv) || rawEnv === null || Array.isArray(rawEnv)) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_PROBES_INVALID",
			'local substrate probe "env" must be an object',
			{
				remediation:
					"pass an environment record (process.env is accepted); use {} for a machine with no relevant env",
			},
		);
	}
	const env: Record<string, string> = {};
	// Snapshot in sorted key order: the env is data the report depends on, so it
	// must not be able to change under us or hash differently per insertion order.
	// SAFETY: assertion required at this I/O or test boundary.
	for (const key of Object.keys(rawEnv as JsonObject).sort()) {
		// SAFETY: assertion required at this I/O or test boundary.
		const value = (rawEnv as JsonObject)[key];
		if (isJsonString(value)) env[key] = value;
	}
	return Object.freeze({
		which: asWhich(source.which),
		exists: asExists(source.exists),
		readText: asReadText(source.readText),
		env: Object.freeze(env),
		// SAFETY: assertion required at this I/O or test boundary.
		platform: asNodePlatform(
			isJsonString(source.platform) ? `${source.platform}` : process.platform,
		),
		nodeVersion: isJsonString(source.nodeVersion)
			? `${source.nodeVersion}`
			: process.versions.node,
	});
}

/* -------------------------------------------------------------------------- */
/* detection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Node's `WebAssembly` embedder is always present, but the repo only supports
 * Node >= 20, so an older Node is not counted as a WASM substrate.
 */
const MIN_NODE_MAJOR = 20;

/** WASM toolchains that can execute a module/component outside the harness. */
const WASM_BINARIES: readonly string[] = Object.freeze([
	"jco",
	"wasmedge",
	"wasmer",
	"wasmtime",
]);

/** OCI-compatible *clients*. A client is not an engine — see `detectOci`. */
const OCI_BINARIES: readonly string[] = Object.freeze([
	"docker",
	"nerdctl",
	"podman",
]);

/** Engine endpoints. Only these prove something can actually run a container. */
const OCI_ROOT_SOCKETS: readonly string[] = Object.freeze([
	"/run/docker.sock",
	"/run/podman/podman.sock",
	"/var/run/docker.sock",
]);

const LXC_BINARIES: readonly string[] = Object.freeze(["incus", "lxc", "lxd"]);

const LXC_SOCKETS: readonly string[] = Object.freeze([
	"/var/lib/incus/unix.socket",
	"/var/lib/lxd/unix.socket",
	"/var/snap/lxd/common/lxd/unix.socket",
]);

/**
 * Inspect the machine. Pure over the injected probes: no clock, no randomness,
 * no ambient env, no network. Two calls with the same probes are deep-equal.
 */
export function discoverLocalSubstrates(
	probes: LocalSubstrateProbes,
	options?: { readonly now?: () => string },
): LocalSubstrateReport {
	const p = parseLocalSubstrateProbes(probes);
	const findings: LocalSubstrateFinding[] = [
		detectFirecracker(p),
		detectLxc(p),
		detectNspawn(p),
		detectOci(p),
		detectProcess(p),
		detectWasm(p),
		detectWsl2(p),
	];
	// Sorted by kind so the report is a function of the machine, never of the
	// order the detectors happened to run in.
	findings.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

	for (const finding of findings) {
		// Fail closed: a "present" claim with nothing behind it is exactly the
		// overclaim this module exists to prevent, so it is a refusal, not a warn.
		if (finding.present && finding.evidence.length === 0) {
			throw new LocalSubstrateError(
				"LOCAL_SUBSTRATE_EVIDENCE_MISSING",
				`substrate ${finding.kind} was reported present with no evidence`,
				{
					kind: finding.kind,
					remediation:
						"a detector must attach at least one concrete evidence row (bin:/sock:/file:/dev:) before claiming presence",
				},
			);
		}
		if (!finding.present && finding.remediation === undefined) {
			throw new LocalSubstrateError(
				"LOCAL_SUBSTRATE_EVIDENCE_MISSING",
				`substrate ${finding.kind} was reported absent with no remediation`,
				{
					kind: finding.kind,
					remediation:
						"an absent substrate must name what to change; silence reads as 'no opinion'",
				},
			);
		}
	}

	const discoveredAt = options?.now?.();
	return deepFreeze({
		contract: LOCAL_SUBSTRATE_REPORT_CONTRACT,
		platform: p.platform,
		substrates: findings,
		...(discoveredAt !== undefined ? { discoveredAt } : undefined),
	});
}

/** Look up a finding by kind. Throws on a kind outside the vocabulary. */
export function findSubstrate(
	report: LocalSubstrateReport,
	kind: LocalSubstrateKind,
): LocalSubstrateFinding {
	const finding = report.substrates.find((s) => s.kind === kind);
	if (finding === undefined) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_KIND_UNKNOWN",
			`no finding for substrate kind ${JSON.stringify(kind)}`,
			{
				remediation: `pass one of ${LOCAL_SUBSTRATE_KINDS.join(", ")}, and build the report with discoverLocalSubstrates()`,
			},
		);
	}
	return finding;
}

/**
 * `process` — a bare Node process on this host. Always present: this code is
 * itself running in one, so the claim is self-evidencing. The evidence names
 * the platform and Node version rather than a path, because the "binary" here
 * is the interpreter we are inside.
 */
function detectProcess(p: LocalSubstrateProbes): LocalSubstrateFinding {
	return {
		kind: "process",
		present: true,
		evidence: [`platform:${p.platform}`, `node:${p.nodeVersion}`],
		detail:
			"a Node process on this host; the substrate the built-in yard:local already uses",
	};
}

/**
 * `wasm` — anything on this box that can execute WebAssembly. Two independent
 * signals: an installed toolchain binary (wasmtime/wasmer/wasmedge/jco), or the
 * `WebAssembly` embedder inside the running Node, which genuinely instantiates
 * core modules. Node's embedder is core-module only — component-model work
 * needs jco or wasmtime — so the detail says which of the two we actually have.
 */
function detectWasm(p: LocalSubstrateProbes): LocalSubstrateFinding {
	const evidence: string[] = [];
	for (const binary of WASM_BINARIES) {
		const path = p.which(binary);
		if (path !== null) evidence.push(`bin:${path}`);
	}
	const major = Number.parseInt(p.nodeVersion, 10);
	const nodeEmbedder = Number.isInteger(major) && major >= MIN_NODE_MAJOR;
	if (nodeEmbedder) evidence.push(`node-webassembly:${p.nodeVersion}`);

	if (evidence.length === 0) {
		return {
			kind: "wasm",
			present: false,
			evidence: [],
			detail: `no WASM toolchain on PATH and Node ${p.nodeVersion} is below the supported major ${MIN_NODE_MAJOR}`,
			remediation: `install wasmtime, wasmer, wasmedge, or jco on PATH, or upgrade to Node >= ${MIN_NODE_MAJOR}`,
		};
	}
	const toolchain = evidence.some((e) => e.startsWith("bin:"));
	return {
		kind: "wasm",
		present: true,
		evidence,
		detail: toolchain
			? "a standalone WASM toolchain is installed; component-model execution is possible outside the harness"
			: "only the in-process Node WebAssembly embedder was found: core modules yes, component model no",
	};
}

/**
 * `oci` — containers. A `docker`/`podman`/`nerdctl` binary on PATH proves the
 * **client tool** exists, nothing more: the daemon may be stopped, remote, or
 * never installed. So we also probe the engine endpoints, and the detail always
 * says which of the two we actually saw. Presence here therefore means "there
 * is an OCI story on this box", and the strength of that story is in `detail`
 * and in the `sock:` evidence rows — never inferred from the binary alone.
 */
function detectOci(p: LocalSubstrateProbes): LocalSubstrateFinding {
	const evidence: string[] = [];
	for (const binary of OCI_BINARIES) {
		const path = p.which(binary);
		if (path !== null) evidence.push(`bin:${path}`);
	}
	const sockets = [...OCI_ROOT_SOCKETS];
	// Rootless podman puts its socket under the user runtime dir; that path is
	// only knowable from the injected env, never from an ambient read.
	const runtimeDir = p.env.XDG_RUNTIME_DIR;
	if (isJsonString(runtimeDir) && runtimeDir.length > 0) {
		sockets.push(`${runtimeDir}/podman/podman.sock`);
	}
	sockets.sort();
	const engineSockets: string[] = [];
	for (const socket of sockets) {
		if (p.exists(socket)) engineSockets.push(socket);
	}
	for (const socket of engineSockets) evidence.push(`sock:${socket}`);

	if (evidence.length === 0) {
		return {
			kind: "oci",
			present: false,
			evidence: [],
			detail: "no OCI client on PATH and no engine socket at a known path",
			remediation:
				"install docker, podman, or nerdctl and start its engine, then re-run substrate discovery",
		};
	}
	return {
		kind: "oci",
		present: true,
		evidence,
		detail:
			engineSockets.length > 0
				? `engine endpoint evidenced at ${engineSockets.join(", ")}; a reachable, authorized daemon is still not proven (no request was made)`
				: "client binary only — no engine socket found, so nothing here proves a container can actually be started",
	};
}

/**
 * `wsl2` — are we running *inside* a WSL2 guest? Linux-only by construction.
 * Signals, in order of strength:
 *   1. `/proc/version` naming Microsoft/WSL — proves "some WSL", not which one.
 *   2. `/run/WSL` or `WSL_INTEROP`/`WSL_DISTRO_NAME` in env — proves interop is
 *      wired, which both WSL1 and WSL2 have.
 *   3. The literal `WSL2` marker in the kernel string (WSL2 ships a real Linux
 *      kernel, e.g. `5.15.0-microsoft-standard-WSL2`; WSL1 reports a syscall
 *      translation layer, e.g. `4.4.0-19041-Microsoft`).
 * Only (3) distinguishes v2 from v1, so it is required for `present: true`.
 * When we see WSL but cannot prove v2 we report the **weaker claim** — absent,
 * with a detail saying WSL interop was observed — rather than overclaiming.
 */
function detectWsl2(p: LocalSubstrateProbes): LocalSubstrateFinding {
	if (p.platform !== "linux") {
		return platformRefusal("wsl2", p.platform);
	}
	const evidence: string[] = [];
	const version = p.readText("/proc/version");
	const lowered = version === null ? "" : version.toLowerCase();
	const wslKernel = lowered.includes("microsoft") || lowered.includes("wsl");
	if (wslKernel) evidence.push("file:/proc/version");
	if (p.exists("/run/WSL")) evidence.push("file:/run/WSL");
	for (const key of ["WSL_DISTRO_NAME", "WSL_INTEROP"]) {
		const value = p.env[key];
		if (isJsonString(value) && value.length > 0) {
			evidence.push(`env:${key}`);
		}
	}
	if (p.exists("/proc/sys/fs/binfmt_misc/WSLInterop")) {
		evidence.push("file:/proc/sys/fs/binfmt_misc/WSLInterop");
	}

	const interop = evidence.length > 0;
	const versionTwo = lowered.includes("wsl2");
	if (!interop) {
		return {
			kind: "wsl2",
			present: false,
			evidence: [],
			detail:
				"no WSL marker in /proc/version, no /run/WSL, and no WSL interop env — this is a native Linux host",
			remediation:
				"run HoBo inside a WSL2 distribution (wsl --set-version <distro> 2) if you want a WSL2 substrate",
		};
	}
	if (!versionTwo) {
		return {
			kind: "wsl2",
			present: false,
			evidence,
			detail:
				"WSL interop observed, but /proc/version carries no WSL2 kernel marker — this is WSL1 or an indeterminate WSL version, and the weaker claim is reported rather than an unproven v2",
			remediation:
				"upgrade the distribution with `wsl --set-version <distro> 2`; a WSL2 guest reports a kernel such as 5.15.0-microsoft-standard-WSL2",
		};
	}
	return {
		kind: "wsl2",
		present: true,
		evidence,
		detail:
			"running inside a WSL2 guest with a real Linux kernel; workloads hosted here execute in this guest, not on the Windows host",
	};
}

/**
 * `lxc` — LXC/LXD/Incus system containers. Linux-only. A client binary alone is
 * the same weak signal as with OCI, so the daemon's unix socket is probed too
 * and the detail says which was seen.
 */
function detectLxc(p: LocalSubstrateProbes): LocalSubstrateFinding {
	if (p.platform !== "linux") {
		return platformRefusal("lxc", p.platform);
	}
	const evidence: string[] = [];
	for (const binary of LXC_BINARIES) {
		const path = p.which(binary);
		if (path !== null) evidence.push(`bin:${path}`);
	}
	const daemonSockets: string[] = [];
	for (const socket of LXC_SOCKETS) {
		if (p.exists(socket)) daemonSockets.push(socket);
	}
	for (const socket of daemonSockets) evidence.push(`sock:${socket}`);

	if (evidence.length === 0) {
		return {
			kind: "lxc",
			present: false,
			evidence: [],
			detail: "no lxc/lxd/incus binary on PATH and no daemon socket",
			remediation:
				"install lxd or incus (e.g. `snap install lxd` / `apt install incus`) and initialize it, then re-run substrate discovery",
		};
	}
	return {
		kind: "lxc",
		present: true,
		evidence,
		detail:
			daemonSockets.length > 0
				? `daemon socket evidenced at ${daemonSockets.join(", ")}; permission to use it is not proven (no request was made)`
				: "client binary only — no daemon socket found, so nothing here proves a container can be launched",
	};
}

/**
 * `nspawn` — systemd-nspawn containers. Linux-only. Needs both the tool and a
 * *running* systemd: `/run/systemd/system` exists only when systemd is PID 1,
 * which is the documented systemd check and rules out containers/WSL1 shells
 * where the binary is installed but nspawn cannot work.
 */
function detectNspawn(p: LocalSubstrateProbes): LocalSubstrateFinding {
	if (p.platform !== "linux") {
		return platformRefusal("nspawn", p.platform);
	}
	const binary = p.which("systemd-nspawn");
	const systemdRunning = p.exists("/run/systemd/system");
	const evidence: string[] = [];
	if (binary !== null) evidence.push(`bin:${binary}`);
	if (systemdRunning) evidence.push("file:/run/systemd/system");

	if (binary === null) {
		return {
			kind: "nspawn",
			present: false,
			evidence,
			detail: "systemd-nspawn is not on PATH",
			remediation:
				"install systemd-container (e.g. `apt install systemd-container`), then re-run substrate discovery",
		};
	}
	if (!systemdRunning) {
		return {
			kind: "nspawn",
			present: false,
			evidence,
			detail:
				"systemd-nspawn is installed but /run/systemd/system is absent, so systemd is not the init on this host and nspawn cannot manage machines",
			remediation:
				"boot this host with systemd as PID 1 (a plain container or WSL1 shell cannot host nspawn)",
		};
	}
	return {
		kind: "nspawn",
		present: true,
		evidence,
		detail:
			"systemd-nspawn is installed and systemd is running as init; root privileges are still required and are not proven here",
	};
}

/**
 * `firecracker` — KVM microVMs. Linux-only. Needs both the `firecracker` binary
 * and `/dev/kvm`: without the KVM device the binary cannot boot a microVM at
 * all, so the binary alone is explicitly not enough.
 */
function detectFirecracker(p: LocalSubstrateProbes): LocalSubstrateFinding {
	if (p.platform !== "linux") {
		return platformRefusal("firecracker", p.platform);
	}
	const binary = p.which("firecracker");
	const kvm = p.exists("/dev/kvm");
	const evidence: string[] = [];
	if (binary !== null) evidence.push(`bin:${binary}`);
	if (kvm) evidence.push("dev:/dev/kvm");

	if (binary === null) {
		return {
			kind: "firecracker",
			present: false,
			evidence,
			detail: "the firecracker binary is not on PATH",
			remediation:
				"install firecracker from the upstream release and put it on PATH, then re-run substrate discovery",
		};
	}
	if (!kvm) {
		return {
			kind: "firecracker",
			present: false,
			evidence,
			detail:
				"firecracker is installed but /dev/kvm is absent, so no microVM can be booted (nested virtualization is off, or this is a guest without KVM passthrough)",
			remediation:
				"enable KVM (load the kvm_intel/kvm_amd module, or enable nested virtualization on the hypervisor) so /dev/kvm exists",
		};
	}
	return {
		kind: "firecracker",
		present: true,
		evidence,
		detail:
			"firecracker is installed and /dev/kvm exists; read/write access to /dev/kvm for this user is not proven here",
	};
}

/**
 * Linux-only substrates on a non-Linux host: report absent with the platform as
 * the reason instead of probing paths that cannot mean anything there. Evidence
 * is empty because nothing was inspected — saying otherwise would be fiction.
 */
function platformRefusal(
	kind: LocalSubstrateKind,
	platform: NodeJS.Platform,
): LocalSubstrateFinding {
	return {
		kind,
		present: false,
		evidence: [],
		detail: `${kind} is a Linux-only substrate and this host reports platform ${platform}; no probe was attempted`,
		remediation: `run HoBo on a Linux host (or inside a Linux VM/WSL2 guest) to make ${kind} available`,
	};
}

/* -------------------------------------------------------------------------- */
/* yards                                                                       */
/* -------------------------------------------------------------------------- */

interface SubstrateBinding {
	readonly profile: string;
	readonly productId: string;
	readonly fidelity: SeedFidelity;
}

/**
 * What each non-process substrate is allowed to claim it hosts, and at what
 * ADR-0042 fidelity. The fidelity assignments are the load-bearing honesty in
 * this module, so each one states its reason:
 *
 * - **wasm → `simulated`.** `runtime-local` does not execute real `.wasm` bytes
 *   today (see `docs/design/yard-bindings.md`); the in-process lane boots the
 *   collected graph with simulated resources. A wasmtime binary on the box does
 *   not change what *HoBo* executes, so `real` would be an overclaim.
 * - **oci / lxc / nspawn / firecracker → `camp-only`.** HoBo has no local
 *   launcher that places a workload into a container or microVM on this
 *   machine: `@hobo/runtime-oci` schedules through kubectl against a cluster,
 *   and there is no LXC/nspawn/Firecracker placement path at all. The substrate
 *   is genuinely available on the box, but satisfying the profile needs a Camp,
 *   which is exactly what `camp-only` means.
 *
 * `process` and `wsl2` are absent from this table on purpose: both reuse
 * `seedLocalhostYard()`'s rows, which carry their own already-audited
 * fidelities (a Node HTTP server is `real`, an in-memory queue is `simulated`).
 */
const SUBSTRATE_BINDINGS = deepFreeze({
	firecracker: [
		{
			profile: "service.worker/v1",
			productId: "local:firecracker-microvm",
			fidelity: "camp-only",
		},
	],
	lxc: [
		{
			profile: "api.http/v1",
			productId: "local:lxc-container",
			fidelity: "camp-only",
		},
		{
			profile: "service.worker/v1",
			productId: "local:lxc-container",
			fidelity: "camp-only",
		},
	],
	nspawn: [
		{
			profile: "service.worker/v1",
			productId: "local:nspawn-container",
			fidelity: "camp-only",
		},
	],
	oci: [
		{
			profile: "api.http/v1",
			productId: "local:oci-container",
			fidelity: "camp-only",
		},
		{
			profile: "service.worker/v1",
			productId: "local:oci-container",
			fidelity: "camp-only",
		},
		{
			profile: "web.static/v1",
			productId: "local:oci-container",
			fidelity: "camp-only",
		},
	],
	wasm: [
		{
			profile: "api.http/v1",
			productId: "local:wasm-component-host",
			fidelity: "simulated",
		},
		{
			profile: "service.worker/v1",
			productId: "local:wasm-component-host",
			fidelity: "simulated",
		},
	],
} as const) satisfies Readonly<
	Record<
		Exclude<LocalSubstrateKind, "process" | "wsl2">,
		readonly SubstrateBinding[]
	>
>;

/** Yard name for a substrate. `process` keeps the existing seeded name. */
export function localSubstrateYardName(kind: LocalSubstrateKind): string {
	// SAFETY: assertion required at this I/O or test boundary.
	if (!(LOCAL_SUBSTRATE_KINDS as readonly string[]).includes(kind)) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_KIND_UNKNOWN",
			`unknown local substrate kind ${JSON.stringify(kind)}`,
			{
				remediation: `use one of ${LOCAL_SUBSTRATE_KINDS.join(", ")}`,
			},
		);
	}
	return kind === "process"
		? LOCALHOST_YARD_NAME
		: `${LOCALHOST_YARD_NAME}-${kind}`;
}

/**
 * Turn a substrate report into the Yard set a localhost Station should hold.
 * Pure and deterministic: same report + same observations ⇒ deep-equal result.
 *
 * `process` and `wsl2` delegate their rows to `seedLocalhostYard()` rather than
 * re-deriving them — both are "a Node process on a POSIX box", which is exactly
 * what the seed already models, and duplicating its row table would let the two
 * drift apart.
 */
export function localSubstrateYards(
	report: LocalSubstrateReport,
	options?: {
		readonly observations?: readonly LocalhostCapabilityObservation[];
	},
): LocalSubstrateYardSet {
	if (
		!isJsonObject(report) ||
		report === null ||
		// SAFETY: assertion required at this I/O or test boundary.
		(report as LocalSubstrateReport).contract !==
			LOCAL_SUBSTRATE_REPORT_CONTRACT
	) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_REPORT_INVALID",
			`expected a ${LOCAL_SUBSTRATE_REPORT_CONTRACT} report`,
			{
				remediation:
					"build the report with discoverLocalSubstrates(probes) and pass it unmodified",
			},
		);
	}
	// Checked through an `unknown` alias: `Array.isArray` narrows a `readonly T[]`
	// to `any[]`, which would silently erase the finding type downstream.
	const substrates: unknown = report.substrates;
	if (!Array.isArray(substrates)) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_REPORT_INVALID",
			"local substrate report substrates must be an array",
			{
				remediation:
					"build the report with discoverLocalSubstrates(probes) and pass it unmodified",
			},
		);
	}

	const seed = seedLocalhostYard(options?.observations ?? []);
	const seedRows: readonly LocalSubstrateYardRow[] = seed.rows;

	const yards: LocalSubstrateYardEntry[] = [];
	const unavailable: {
		readonly kind: LocalSubstrateKind;
		readonly reason: string;
	}[] = [];

	for (const finding of [...report.substrates].sort((a, b) =>
		a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
	)) {
		if (!finding.present) {
			unavailable.push({
				kind: finding.kind,
				reason: `${finding.detail} — ${finding.remediation ?? "no remediation recorded"}`,
			});
			continue;
		}
		const yardName = localSubstrateYardName(finding.kind);
		const rows: readonly LocalSubstrateYardRow[] =
			finding.kind === "process" || finding.kind === "wsl2"
				? seedRows
				: SUBSTRATE_BINDINGS[finding.kind].map((binding) => ({
						profile: binding.profile,
						productId: binding.productId,
						// A row that exists because a probe saw the substrate is
						// discovered, never a platform default.
						// SAFETY: assertion required at this I/O or test boundary.
						provenance: "discovered" as SeedProvenance,
						fidelity: binding.fidelity,
					}));

		// `yard:local` is the seed's own Yard: reuse the record it already built
		// instead of minting a second, subtly different one under the same name.
		const built =
			finding.kind === "process"
				? seed.yard
				: yard(yardName, {
						provider: LOCALHOST_PROVIDER_ID,
						properties: { "local.substrate": finding.kind },
						bindings: rows.map((row) => ({
							profile: row.profile,
							productId: row.productId,
							properties: {
								"local.fidelity": row.fidelity,
								"local.provenance": row.provenance,
								"local.substrate": finding.kind,
							},
						})),
						camps: [],
					});

		yards.push({
			kind: finding.kind,
			yardName,
			yard: built,
			rows,
			evidence: finding.evidence,
			detail: finding.detail,
		});
	}

	return deepFreeze({
		contract: LOCAL_SUBSTRATE_YARDS_CONTRACT,
		yards,
		unavailable,
		profileGaps: seed.unavailable,
	});
}

/**
 * Composition helper: discover the machine's substrates and produce the Yard
 * set a default localhost Station would register, in one deterministic call.
 */
export function registerLocalSubstrateYards(input: {
	readonly probes: LocalSubstrateProbes;
	readonly observations?: readonly LocalhostCapabilityObservation[];
	readonly now?: () => string;
}): LocalSubstrateRegistration {
	if (!isJsonObject(input) || input === null) {
		throw new LocalSubstrateError(
			"LOCAL_SUBSTRATE_PROBES_INVALID",
			"registerLocalSubstrateYards input must be an object",
			{
				remediation:
					"call registerLocalSubstrateYards({ probes: defaultLocalSubstrateProbes() })",
			},
		);
	}
	const report = discoverLocalSubstrates(
		input.probes,
		input.now !== undefined ? { now: input.now } : undefined,
	);
	const yards = localSubstrateYards(
		report,
		input.observations !== undefined
			? { observations: input.observations }
			: undefined,
	);
	return Object.freeze({ report, yards });
}

/* -------------------------------------------------------------------------- */
/* internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Local `deepFreeze`: `@hobo/core` keeps its copy module-private (not exported
 * from the package entrypoint), and `@hobo/yards` likewise, so this module owns
 * one rather than reaching past a package boundary.
 */
function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined) return value;
	if (Object.isFrozen(value)) return value;
	if (Array.isArray(value)) {
		Object.freeze(value);
		for (const item of value) {
			deepFreeze(item);
		}
		return value;
	}
	if (!isJsonObject(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) {
		deepFreeze(value[key]);
	}
	return value;
}
