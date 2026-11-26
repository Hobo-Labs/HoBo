import { describe, expect, it } from "vitest";

interface EnvBag {
	[key: string]: string;
}

import {
	defaultLocalSubstrateProbes,
	discoverLocalSubstrates,
	findSubstrate,
	LOCAL_SUBSTRATE_KINDS,
	LOCAL_SUBSTRATE_REPORT_CONTRACT,
	LOCAL_SUBSTRATE_YARDS_CONTRACT,
	LocalSubstrateError,
	type LocalSubstrateKind,
	type LocalSubstrateProbes,
	localSubstrateYardName,
	localSubstrateYards,
	parseLocalSubstrateProbes,
	registerLocalSubstrateYards,
} from "../src/local-substrates.js";

/** A machine described entirely as data: binaries on PATH, paths that exist. */
interface FakeMachine {
	readonly platform?: NodeJS.Platform;
	readonly nodeVersion?: string;
	readonly binaries?: Readonly<Record<string, string>>;
	readonly paths?: readonly string[];
	readonly files?: Readonly<Record<string, string>>;
	readonly env?: Readonly<Record<string, string>>;
}

function fakeProbes(machine: FakeMachine): LocalSubstrateProbes {
	const binaries = machine.binaries ?? {};
	const files = machine.files ?? {};
	const paths = new Set([...(machine.paths ?? []), ...Object.keys(files)]);
	return {
		which: (binary) => binaries[binary] ?? null,
		exists: (path) => paths.has(path),
		readText: (path) => files[path] ?? null,
		env: machine.env ?? {},
		platform: machine.platform ?? "linux",
		nodeVersion: machine.nodeVersion ?? "22.11.0",
	};
}

/** Bare Linux: Node only, no container engine, no virtualization. */
const BARE_LINUX: FakeMachine = {
	platform: "linux",
	nodeVersion: "22.11.0",
	files: { "/proc/version": "Linux version 6.8.0-generic (gcc 13)" },
};

/** Linux with docker (engine socket up) and an initialized LXD. */
const LINUX_DOCKER_LXC: FakeMachine = {
	platform: "linux",
	nodeVersion: "22.11.0",
	binaries: {
		docker: "/usr/bin/docker",
		lxc: "/usr/bin/lxc",
		wasmtime: "/usr/local/bin/wasmtime",
	},
	paths: ["/var/run/docker.sock", "/var/lib/lxd/unix.socket"],
	files: { "/proc/version": "Linux version 6.8.0-generic (gcc 13)" },
};

/** A WSL2 guest: real Linux kernel with the WSL2 marker plus interop. */
const WSL2_BOX: FakeMachine = {
	platform: "linux",
	nodeVersion: "22.11.0",
	env: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/8_interop" },
	paths: ["/run/WSL", "/proc/sys/fs/binfmt_misc/WSLInterop"],
	files: {
		"/proc/version":
			"Linux version 5.15.153.1-microsoft-standard-WSL2 (root@build)",
	},
};

/** A WSL1 guest: Microsoft marker, interop wired, but no WSL2 kernel. */
const WSL1_BOX: FakeMachine = {
	platform: "linux",
	nodeVersion: "22.11.0",
	env: { WSL_DISTRO_NAME: "Ubuntu" },
	paths: ["/proc/sys/fs/binfmt_misc/WSLInterop"],
	files: { "/proc/version": "Linux version 4.4.0-19041-Microsoft (Microsoft)" },
};

/** macOS with Docker Desktop's client and podman, but only the docker socket. */
const MACOS_BOX: FakeMachine = {
	platform: "darwin",
	nodeVersion: "22.11.0",
	binaries: { docker: "/usr/local/bin/docker" },
	paths: ["/var/run/docker.sock"],
};

/** Binary present, socket absent: the "client only" trap. */
const CLIENT_ONLY_BOX: FakeMachine = {
	platform: "linux",
	nodeVersion: "22.11.0",
	binaries: {
		docker: "/usr/bin/docker",
		firecracker: "/usr/local/bin/firecracker",
		lxc: "/usr/bin/lxc",
		"systemd-nspawn": "/usr/bin/systemd-nspawn",
	},
	files: { "/proc/version": "Linux version 6.8.0-generic (gcc 13)" },
};

function findingFor(machine: FakeMachine, kind: LocalSubstrateKind) {
	return findSubstrate(discoverLocalSubstrates(fakeProbes(machine)), kind);
}

describe("local substrate vocabulary", () => {
	it("is a frozen, sorted, closed set", () => {
		expect(Object.isFrozen(LOCAL_SUBSTRATE_KINDS)).toBe(true);
		expect([...LOCAL_SUBSTRATE_KINDS]).toEqual([
			"firecracker",
			"lxc",
			"nspawn",
			"oci",
			"process",
			"wasm",
			"wsl2",
		]);
	});

	it("names yard:local for process and yard:local-<kind> otherwise", () => {
		expect(localSubstrateYardName("process")).toBe("yard:local");
		expect(localSubstrateYardName("oci")).toBe("yard:local-oci");
		expect(localSubstrateYardName("wsl2")).toBe("yard:local-wsl2");
	});

	it("refuses an unknown substrate kind with a typed error", () => {
		expect(() =>
			// SAFETY: assertion required at this I/O or test boundary.
			localSubstrateYardName("kubernetes" as LocalSubstrateKind),
		).toThrowError(LocalSubstrateError);
		try {
			// SAFETY: assertion required at this I/O or test boundary.
			localSubstrateYardName("kubernetes" as LocalSubstrateKind);
			expect.unreachable("expected a refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			const typed = error as LocalSubstrateError;
			expect(typed.code).toBe("LOCAL_SUBSTRATE_KIND_UNKNOWN");
			expect(typed.remediation).toContain("firecracker");
		}
	});
});

describe("probe parse boundary", () => {
	it("refuses non-object probes", () => {
		try {
			discoverLocalSubstrates(null);
			expect.unreachable("expected a refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			const typed = error as LocalSubstrateError;
			expect(typed.code).toBe("LOCAL_SUBSTRATE_PROBES_INVALID");
			expect(typed.remediation).toContain("defaultLocalSubstrateProbes");
		}
	});

	it("refuses probes missing a function, naming which one", () => {
		const { which: _which, ...rest } = fakeProbes(BARE_LINUX);
		try {
			discoverLocalSubstrates(rest);
			expect.unreachable("expected a refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			const typed = error as LocalSubstrateError;
			expect(typed.code).toBe("LOCAL_SUBSTRATE_PROBES_INVALID");
			expect(typed.message).toContain("which");
		}
	});

	it("refuses a missing platform and a missing nodeVersion", () => {
		const base = fakeProbes(BARE_LINUX);
		for (const field of ["platform", "nodeVersion"] as const) {
			const broken = { ...base, [field]: "" };
			try {
				discoverLocalSubstrates(broken);
				expect.unreachable("expected a refusal");
			} catch (error) {
				// SAFETY: assertion required at this I/O or test boundary.
				const typed = error as LocalSubstrateError;
				expect(typed.code).toBe("LOCAL_SUBSTRATE_PROBES_INVALID");
				expect(typed.message).toContain(field);
			}
		}
	});

	it("refuses a non-object env", () => {
		try {
			discoverLocalSubstrates({ ...fakeProbes(BARE_LINUX), env: "PATH=/bin" });
			expect.unreachable("expected a refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as LocalSubstrateError).code).toBe(
				"LOCAL_SUBSTRATE_PROBES_INVALID",
			);
		}
	});

	it("snapshots env at the parse boundary so later mutation cannot change it", () => {
		const env: EnvBag = { XDG_RUNTIME_DIR: "/run/user/1000" };
		const parsed = parseLocalSubstrateProbes({
			...fakeProbes(BARE_LINUX),
			env,
		});
		const before = discoverLocalSubstrates(parsed);
		env.WSL_INTEROP = "/run/WSL/8_interop";
		expect(parsed.env.WSL_INTEROP).toBeUndefined();
		expect(discoverLocalSubstrates(parsed)).toEqual(before);
	});

	it("drops non-string env values instead of coercing them", () => {
		const parsed = parseLocalSubstrateProbes({
			...fakeProbes(BARE_LINUX),
			env: { XDG_RUNTIME_DIR: 7, WSL_DISTRO_NAME: "Ubuntu" },
		});
		expect(parsed.env).toEqual({ WSL_DISTRO_NAME: "Ubuntu" });
	});
});

describe("report shape and invariants", () => {
	it("reports every substrate kind exactly once, sorted, frozen", () => {
		const report = discoverLocalSubstrates(fakeProbes(LINUX_DOCKER_LXC));
		expect(report.contract).toBe(LOCAL_SUBSTRATE_REPORT_CONTRACT);
		expect(report.substrates.map((s) => s.kind)).toEqual([
			...LOCAL_SUBSTRATE_KINDS,
		]);
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.substrates)).toBe(true);
	});

	it("never claims presence with empty evidence, on any fake machine", () => {
		for (const machine of [
			BARE_LINUX,
			LINUX_DOCKER_LXC,
			WSL2_BOX,
			WSL1_BOX,
			MACOS_BOX,
			CLIENT_ONLY_BOX,
		]) {
			for (const finding of discoverLocalSubstrates(fakeProbes(machine))
				.substrates) {
				if (finding.present) expect(finding.evidence.length).toBeGreaterThan(0);
			}
		}
	});

	it("gives every absent substrate a remediation instead of dropping it", () => {
		const report = discoverLocalSubstrates(fakeProbes(MACOS_BOX));
		const absent = report.substrates.filter((s) => !s.present);
		expect(absent.length).toBeGreaterThan(0);
		for (const finding of absent) {
			expect(finding.remediation).toBeTruthy();
			expect(finding.detail.length).toBeGreaterThan(0);
		}
	});

	it("omits discoveredAt unless a clock is injected", () => {
		const probes = fakeProbes(BARE_LINUX);
		expect(discoverLocalSubstrates(probes).discoveredAt).toBeUndefined();
		expect(
			discoverLocalSubstrates(probes, { now: () => "2026-01-01T00:00:00.000Z" })
				.discoveredAt,
		).toBe("2026-01-01T00:00:00.000Z");
	});

	it("is deterministic: two calls are deep-equal", () => {
		const probes = fakeProbes(LINUX_DOCKER_LXC);
		expect(discoverLocalSubstrates(probes)).toEqual(
			discoverLocalSubstrates(probes),
		);
	});

	it("is independent of probe answer order", () => {
		const reversed: LocalSubstrateProbes = {
			...fakeProbes(LINUX_DOCKER_LXC),
			// Same machine, different iteration order behind the probes.
			exists: (path) =>
				["/var/lib/lxd/unix.socket", "/var/run/docker.sock"]
					.reverse()
					.includes(path),
		};
		expect(discoverLocalSubstrates(reversed)).toEqual(
			discoverLocalSubstrates(fakeProbes(LINUX_DOCKER_LXC)),
		);
	});

	it("refuses a report kind lookup outside the vocabulary", () => {
		const report = discoverLocalSubstrates(fakeProbes(BARE_LINUX));
		try {
			// SAFETY: assertion required at this I/O or test boundary.
			findSubstrate(report, "xen" as LocalSubstrateKind);
			expect.unreachable("expected a refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as LocalSubstrateError).code).toBe(
				"LOCAL_SUBSTRATE_KIND_UNKNOWN",
			);
		}
	});
});

describe("bare Linux box", () => {
	it("has process and wasm (node embedder) and nothing else", () => {
		const report = discoverLocalSubstrates(fakeProbes(BARE_LINUX));
		const present = report.substrates
			.filter((s) => s.present)
			.map((s) => s.kind);
		expect(present).toEqual(["process", "wasm"]);
	});

	it("evidences process with the platform and node version", () => {
		expect(findingFor(BARE_LINUX, "process").evidence).toEqual([
			"platform:linux",
			"node:22.11.0",
		]);
	});

	it("evidences wasm with the node embedder only, and says so", () => {
		const wasm = findingFor(BARE_LINUX, "wasm");
		expect(wasm.evidence).toEqual(["node-webassembly:22.11.0"]);
		expect(wasm.detail).toContain("component model no");
	});

	it("reports wasm absent on a Node older than the supported major", () => {
		const wasm = findingFor({ ...BARE_LINUX, nodeVersion: "18.20.4" }, "wasm");
		expect(wasm.present).toBe(false);
		expect(wasm.evidence).toEqual([]);
		expect(wasm.remediation).toContain("Node >= 20");
	});

	it("reports oci absent with an install remediation", () => {
		const oci = findingFor(BARE_LINUX, "oci");
		expect(oci.present).toBe(false);
		expect(oci.evidence).toEqual([]);
		expect(oci.remediation).toContain("docker");
	});

	it("reports wsl2 absent on a native Linux kernel", () => {
		const wsl2 = findingFor(BARE_LINUX, "wsl2");
		expect(wsl2.present).toBe(false);
		expect(wsl2.evidence).toEqual([]);
		expect(wsl2.detail).toContain("native Linux host");
	});
});

describe("Linux box with docker + lxc", () => {
	it("evidences the oci engine socket, not just the client", () => {
		const oci = findingFor(LINUX_DOCKER_LXC, "oci");
		expect(oci.present).toBe(true);
		expect(oci.evidence).toEqual([
			"bin:/usr/bin/docker",
			"sock:/var/run/docker.sock",
		]);
		expect(oci.detail).toContain("engine endpoint evidenced");
		// Even with a socket we refuse to claim the daemon answered.
		expect(oci.detail).toContain("not proven");
	});

	it("evidences the lxd daemon socket", () => {
		const lxc = findingFor(LINUX_DOCKER_LXC, "lxc");
		expect(lxc.present).toBe(true);
		expect(lxc.evidence).toEqual([
			"bin:/usr/bin/lxc",
			"sock:/var/lib/lxd/unix.socket",
		]);
	});

	it("evidences the wasm toolchain binary above the node embedder", () => {
		const wasm = findingFor(LINUX_DOCKER_LXC, "wasm");
		expect(wasm.evidence).toEqual([
			"bin:/usr/local/bin/wasmtime",
			"node-webassembly:22.11.0",
		]);
		expect(wasm.detail).toContain("standalone WASM toolchain");
	});

	it("still reports nspawn and firecracker absent with reasons", () => {
		expect(findingFor(LINUX_DOCKER_LXC, "nspawn").remediation).toContain(
			"systemd-container",
		);
		expect(findingFor(LINUX_DOCKER_LXC, "firecracker").remediation).toContain(
			"firecracker",
		);
	});

	it("finds a rootless podman socket only via the injected XDG_RUNTIME_DIR", () => {
		const machine: FakeMachine = {
			platform: "linux",
			binaries: { podman: "/usr/bin/podman" },
			paths: ["/run/user/1000/podman/podman.sock"],
			env: { XDG_RUNTIME_DIR: "/run/user/1000" },
		};
		expect(findingFor(machine, "oci").evidence).toEqual([
			"bin:/usr/bin/podman",
			"sock:/run/user/1000/podman/podman.sock",
		]);
		// Without the env var the same socket is invisible: no ambient reads.
		const blind = findingFor({ ...machine, env: {} }, "oci");
		expect(blind.evidence).toEqual(["bin:/usr/bin/podman"]);
		expect(blind.detail).toContain("client binary only");
	});
});

describe("WSL2 box", () => {
	it("is present with the kernel marker plus interop evidence", () => {
		const wsl2 = findingFor(WSL2_BOX, "wsl2");
		expect(wsl2.present).toBe(true);
		expect(wsl2.evidence).toEqual([
			"file:/proc/version",
			"file:/run/WSL",
			"env:WSL_DISTRO_NAME",
			"env:WSL_INTEROP",
			"file:/proc/sys/fs/binfmt_misc/WSLInterop",
		]);
		expect(wsl2.detail).toContain("real Linux kernel");
	});

	it("reports the weaker claim on WSL1 rather than overclaiming v2", () => {
		const wsl2 = findingFor(WSL1_BOX, "wsl2");
		expect(wsl2.present).toBe(false);
		// Evidence is kept: we did see WSL, we just could not prove v2.
		expect(wsl2.evidence).toEqual([
			"file:/proc/version",
			"env:WSL_DISTRO_NAME",
			"file:/proc/sys/fs/binfmt_misc/WSLInterop",
		]);
		expect(wsl2.detail).toContain("WSL1 or an indeterminate WSL version");
		expect(wsl2.remediation).toContain("--set-version");
	});
});

describe("macOS box", () => {
	it("reports every Linux-only substrate absent with a platform reason", () => {
		const report = discoverLocalSubstrates(fakeProbes(MACOS_BOX));
		for (const kind of ["firecracker", "lxc", "nspawn", "wsl2"] as const) {
			const finding = findSubstrate(report, kind);
			expect(finding.present).toBe(false);
			// Nothing was inspected, so nothing is claimed as evidence.
			expect(finding.evidence).toEqual([]);
			expect(finding.detail).toContain("Linux-only substrate");
			expect(finding.detail).toContain("darwin");
		}
	});

	it("still detects process, wasm, and oci", () => {
		const present = discoverLocalSubstrates(fakeProbes(MACOS_BOX))
			.substrates.filter((s) => s.present)
			.map((s) => s.kind);
		expect(present).toEqual(["oci", "process", "wasm"]);
	});
});

describe("binary present but socket/device missing", () => {
	it("says oci found a client only", () => {
		const oci = findingFor(CLIENT_ONLY_BOX, "oci");
		expect(oci.present).toBe(true);
		expect(oci.evidence).toEqual(["bin:/usr/bin/docker"]);
		expect(oci.detail).toContain("client binary only");
	});

	it("says lxc found a client only", () => {
		const lxc = findingFor(CLIENT_ONLY_BOX, "lxc");
		expect(lxc.evidence).toEqual(["bin:/usr/bin/lxc"]);
		expect(lxc.detail).toContain("client binary only");
	});

	it("refuses firecracker without /dev/kvm and keeps the binary evidence", () => {
		const fc = findingFor(CLIENT_ONLY_BOX, "firecracker");
		expect(fc.present).toBe(false);
		expect(fc.evidence).toEqual(["bin:/usr/local/bin/firecracker"]);
		expect(fc.detail).toContain("/dev/kvm is absent");
		expect(fc.remediation).toContain("KVM");
	});

	it("accepts firecracker once /dev/kvm exists", () => {
		const fc = findingFor(
			{ ...CLIENT_ONLY_BOX, paths: ["/dev/kvm"] },
			"firecracker",
		);
		expect(fc.present).toBe(true);
		expect(fc.evidence).toEqual([
			"bin:/usr/local/bin/firecracker",
			"dev:/dev/kvm",
		]);
	});

	it("refuses nspawn when systemd is not init, and accepts it when it is", () => {
		const without = findingFor(CLIENT_ONLY_BOX, "nspawn");
		expect(without.present).toBe(false);
		expect(without.evidence).toEqual(["bin:/usr/bin/systemd-nspawn"]);
		expect(without.detail).toContain("/run/systemd/system is absent");

		const withSystemd = findingFor(
			{ ...CLIENT_ONLY_BOX, paths: ["/run/systemd/system"] },
			"nspawn",
		);
		expect(withSystemd.present).toBe(true);
		expect(withSystemd.evidence).toEqual([
			"bin:/usr/bin/systemd-nspawn",
			"file:/run/systemd/system",
		]);
	});
});

const NODE_OBSERVATIONS = [
	{ capabilityId: "capability:runtime:node", present: true },
] as const;

describe("substrate yards", () => {
	it("keeps yard:local for the process substrate and reuses the seed rows", () => {
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(BARE_LINUX)),
			{ observations: NODE_OBSERVATIONS },
		);
		expect(set.contract).toBe(LOCAL_SUBSTRATE_YARDS_CONTRACT);
		const process = set.yards.find((y) => y.kind === "process");
		expect(process?.yardName).toBe("yard:local");
		expect(process?.yard.name).toBe("yard:local");
		expect(process?.yard.providerId).toBe("local");
		// The seed's own honest labels ride through unchanged.
		expect(
			process?.rows.find((r) => r.profile === "api.http/v1")?.fidelity,
		).toBe("real");
		expect(
			process?.rows.find((r) => r.profile === "kv.key-value/v1")?.fidelity,
		).toBe("simulated");
	});

	it("labels the wasm yard simulated, never real", () => {
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(LINUX_DOCKER_LXC)),
			{ observations: NODE_OBSERVATIONS },
		);
		const wasm = set.yards.find((y) => y.kind === "wasm");
		expect(wasm?.yardName).toBe("yard:local-wasm");
		expect(wasm?.rows.length).toBeGreaterThan(0);
		for (const row of wasm?.rows ?? []) expect(row.fidelity).toBe("simulated");
		expect(
			wasm?.yard.bindings.map((b) => b.properties["local.fidelity"]),
		).toEqual(["simulated", "simulated"]);
	});

	it("labels container and microVM yards camp-only", () => {
		const machine: FakeMachine = {
			...CLIENT_ONLY_BOX,
			paths: ["/dev/kvm", "/run/systemd/system"],
		};
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(machine)),
			{ observations: NODE_OBSERVATIONS },
		);
		for (const kind of ["firecracker", "lxc", "nspawn", "oci"] as const) {
			const entry = set.yards.find((y) => y.kind === kind);
			expect(entry, kind).toBeDefined();
			expect(entry?.rows.length).toBeGreaterThan(0);
			for (const row of entry?.rows ?? []) {
				expect(row.fidelity, `${kind}/${row.profile}`).toBe("camp-only");
				expect(row.provenance).toBe("discovered");
			}
		}
	});

	it("gives the wsl2 yard the seed rows under its own name", () => {
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(WSL2_BOX)),
			{ observations: NODE_OBSERVATIONS },
		);
		const wsl2 = set.yards.find((y) => y.kind === "wsl2");
		const process = set.yards.find((y) => y.kind === "process");
		expect(wsl2?.yardName).toBe("yard:local-wsl2");
		expect(wsl2?.rows).toEqual(process?.rows);
		expect(wsl2?.yard.properties["local.substrate"]).toBe("wsl2");
	});

	it("reports absent substrates with a reason instead of omitting them", () => {
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(MACOS_BOX)),
			{ observations: NODE_OBSERVATIONS },
		);
		const kinds = [
			...set.yards.map((y) => y.kind),
			...set.unavailable.map((u) => u.kind),
		].sort();
		expect(kinds).toEqual([...LOCAL_SUBSTRATE_KINDS]);
		for (const entry of set.unavailable) {
			expect(entry.reason.length).toBeGreaterThan(0);
			expect(entry.reason).toContain("—");
		}
	});

	it("carries the seed's capability-profile gaps through", () => {
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(BARE_LINUX)),
			{ observations: NODE_OBSERVATIONS },
		);
		expect(set.profileGaps.map((g) => g.profile)).toContain(
			"topic.durable-log/v1",
		);
	});

	it("carries no credentials on any yard or binding", () => {
		const set = localSubstrateYards(
			discoverLocalSubstrates(fakeProbes(LINUX_DOCKER_LXC)),
			{ observations: NODE_OBSERVATIONS },
		);
		// Profile names legitimately mention secrets ("secret-ref.locator/v1"),
		// so the check is on carried property bags, where a credential would hide.
		for (const entry of set.yards) {
			const bags = [
				entry.yard.properties,
				...entry.yard.bindings.map((b) => b.properties),
			];
			for (const bag of bags) {
				for (const [key, value] of Object.entries(bag)) {
					expect(key).not.toMatch(
						/secret|password|token|credential|api[-_]?key/i,
					);
					expect(String(value)).not.toMatch(
						/password|token|credential|api[-_]?key/i,
					);
				}
			}
		}
	});

	it("is deterministic and deeply frozen", () => {
		const report = discoverLocalSubstrates(fakeProbes(LINUX_DOCKER_LXC));
		const a = localSubstrateYards(report, { observations: NODE_OBSERVATIONS });
		const b = localSubstrateYards(report, { observations: NODE_OBSERVATIONS });
		expect(a).toEqual(b);
		expect(Object.isFrozen(a)).toBe(true);
		expect(Object.isFrozen(a.yards)).toBe(true);
	});

	it("refuses a report that is not a substrate report", () => {
		try {
			// SAFETY: assertion required at this I/O or test boundary.
			localSubstrateYards({ contract: "nope" } as never);
			expect.unreachable("expected a refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			const typed = error as LocalSubstrateError;
			expect(typed.code).toBe("LOCAL_SUBSTRATE_REPORT_INVALID");
			expect(typed.remediation).toContain("discoverLocalSubstrates");
		}
	});
});

describe("registerLocalSubstrateYards", () => {
	it("discovers and composes in one deterministic call", () => {
		const input = {
			probes: fakeProbes(WSL2_BOX),
			observations: NODE_OBSERVATIONS,
			now: () => "2026-01-01T00:00:00.000Z",
		};
		const first = registerLocalSubstrateYards(input);
		const second = registerLocalSubstrateYards(input);
		expect(first).toEqual(second);
		expect(first.report.discoveredAt).toBe("2026-01-01T00:00:00.000Z");
		expect(first.yards.yards.map((y) => y.yardName)).toEqual([
			"yard:local",
			"yard:local-wasm",
			"yard:local-wsl2",
		]);
	});

	it("propagates a typed probe refusal", () => {
		expect(() =>
			registerLocalSubstrateYards({ probes: "not-probes" }),
		).toThrowError(LocalSubstrateError);
	});
});

describe("default probes", () => {
	it("build over the real host without throwing and stay pure afterwards", () => {
		const probes = defaultLocalSubstrateProbes({ PATH: "/usr/bin:/bin" });
		expect(probes.which instanceof Function).toBe(true);
		expect(probes.platform).toBe(process.platform);
		expect(probes.nodeVersion).toBe(process.versions.node);
		// readText never throws on an unreadable path.
		expect(probes.readText("/definitely/not/here")).toBeNull();
		const report = discoverLocalSubstrates(probes);
		expect(report.substrates.map((s) => s.kind)).toEqual([
			...LOCAL_SUBSTRATE_KINDS,
		]);
	});
});
