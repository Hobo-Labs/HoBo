/**
 * A simulated sandbox driver for the isolation probe's own tests: it answers
 * each probe (named by `HOBO_PROBE`) with the facts a well-isolated sandbox
 * would print, routes `controlUrl` requests only within one sandbox, and runs
 * the destroy check's `sleep` as a real host process that `destroy` kills.
 *
 * It exists to prove that the probe judges facts correctly: the simulated
 * driver passes, and a driver broken in exactly one way fails exactly the
 * assertion for that way. Real drivers are probed in `@hobo/fleet-agent`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { SandboxTier, WorkOrigin } from "../../../src/_generated/fleet_pb.js";
import type {
	EgressProxyFactory,
	ObservedAssignment,
	Sandbox,
	SandboxDriver,
} from "../../../src/ports.js";
import type { IsolationProbe } from "../../../src/testing/conformance/isolation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a well-isolated sandbox prints for each probe. */
const ISOLATED = {
	capabilities: "@@capeff 0000000000000000\n@@done\n",
	"docker-socket": "@@socket /run/hobo/agent.sock\n@@docker-host \n@@done\n",
	mounts: [
		"overlay / overlay ro,relatime 0 0",
		"proc /proc proc rw,nosuid,nodev,noexec 0 0",
		"tmpfs /dev tmpfs rw,nosuid 0 0",
		"devpts /dev/pts devpts rw 0 0",
		"/dev/sda1 /hobo-probe-ro ext4 ro,relatime 0 0",
		"/dev/sda1 /etc/hosts ext4 ro,relatime 0 0",
		"tmpfs /proc/kcore tmpfs ro 0 0",
		"@@marker hobo-probe",
		"@@done",
		"",
	].join("\n"),
	"read-only": "@@root 1\n@@mount 1\n@@done\n",
	metadata: "@@proxy 1 403\n@@direct 1 \n@@done\n",
	"link-local": "@@proxy 1 403\n@@direct 1 \n@@done\n",
	"outside-allow": "@@proxy 1 403\n@@direct 4 \n@@done\n",
	allowed: "@@proxy 0 \n@@direct 4 \n@@done\n",
	fork: "sh: can't fork: Resource temporarily unavailable\n",
} as const;
const ISOLATED_FACTS: ReadonlyMap<string, string> = new Map(
	Object.entries(ISOLATED),
);

/** Host processes the broken "leaves processes" driver left behind; the test kills them. */
export const LEFT_BEHIND = new Set<ChildProcess>();

type Faults = Readonly<{
	/** Replaces the facts printed for one probe. */
	facts?: Readonly<Record<string, string>>;
	/** Routes a controlUrl request to whichever sandbox owns that URL. */
	sharedControl?: boolean;
	/** `destroy` leaves the sandbox's processes running. */
	leaveProcesses?: boolean;
}>;

const observedFrom = (body: string): ObservedAssignment | undefined => {
	try {
		const parsed: Readonly<Record<string, string>> = JSON.parse(body);
		return {
			workKey: parsed.workKey ?? "",
			repository: parsed.repository ?? "",
			ref: parsed.ref ?? "",
			author: parsed.author ?? "",
			origin: WorkOrigin.INTERNAL,
		};
	} catch {
		return undefined;
	}
};

function simulatedDriver(faults: Faults): SandboxDriver {
	const live = new Map<
		string,
		Readonly<{ fence: (observed: ObservedAssignment) => Promise<boolean> }>
	>();
	let created = 0;
	return {
		tier: SandboxTier.S1_CONTAINER,
		async available() {
			return { ok: true, value: { providesDocker: false } };
		},
		async create(input): Promise<Sandbox> {
			created += 1;
			const controlUrl = `http://10.0.${created}.1:7070`;
			const processes = new Set<ChildProcess>();
			let destroyed = false;
			live.set(controlUrl, { fence: input.fence });
			return {
				id: `sim-${created}`,
				tier: SandboxTier.S1_CONTAINER,
				controlUrl,
				async exec(command) {
					if (destroyed) throw new Error("destroyed");
					const name = command.env.HOBO_PROBE ?? "";
					const say = (text: string) => command.onOutput(encoder.encode(text));
					if (name === "leftover") {
						const child = spawn("sleep", command.argv.slice(1), {
							stdio: "ignore",
						});
						processes.add(child);
						return new Promise((resolve) => {
							child.on("exit", (code) => resolve({ exitCode: code ?? 137 }));
						});
					}
					if (name === "fence-own" || name === "fence-other") {
						const script = command.argv[2] ?? "";
						const target = [...live.keys()].find((url) =>
							script.includes(`${url}/fence`),
						);
						const reachable =
							target !== undefined &&
							(target === controlUrl || faults.sharedControl === true);
						const route = reachable ? live.get(target) : undefined;
						const observed = observedFrom(
							decoder.decode(command.stdin ?? new Uint8Array()),
						);
						if (route === undefined || observed === undefined) {
							say("@@answer \n@@exit 4\n@@done\n");
							return { exitCode: 0 };
						}
						const allow = await route.fence(observed);
						say(`@@answer {"allow":${allow}}\n@@exit 0\n@@done\n`);
						return { exitCode: 0 };
					}
					const facts = faults.facts?.[name] ?? ISOLATED_FACTS.get(name);
					if (facts === undefined) return { exitCode: 127 };
					say(facts);
					return { exitCode: name === "fork" ? 2 : 0 };
				},
				async writeSecret() {},
				async destroy() {
					destroyed = true;
					live.delete(controlUrl);
					for (const child of processes) {
						if (faults.leaveProcesses === true) LEFT_BEHIND.add(child);
						else child.kill("SIGKILL");
					}
					processes.clear();
				},
			};
		},
	};
}

const egress: EgressProxyFactory = {
	async open() {
		return { url: "http://10.0.0.1:3128", async close() {} };
	},
};

const subjectWith = (faults: Faults): IsolationProbe => ({
	make: async () => simulatedDriver(faults),
	options: {
		probeImage: "busybox@sha256:probe",
		allowedHost: "registry.example",
		egress,
	},
});

/** The simulated, well-isolated driver: passes `runSandboxIsolationProbe`. */
export const isolatedSubject: IsolationProbe = subjectWith({});

export const BROKEN_ISOLATION: ReadonlyMap<string, IsolationProbe> = new Map([
	[
		"the sandbox runs with no effective capabilities",
		subjectWith({
			facts: { capabilities: "@@capeff 00000000a80425fb\n@@done\n" },
		}),
	],
	[
		"no Docker socket is reachable at any path",
		subjectWith({
			facts: {
				"docker-socket":
					"@@socket /var/run/docker.sock\n@@docker-host \n@@done\n",
			},
		}),
	],
	[
		"only declared mounts are present, besides pseudo file systems and the runtime's own files",
		subjectWith({
			facts: {
				mounts: `${ISOLATED.mounts}/dev/sda1 /home ext4 rw 0 0\n`,
			},
		}),
	],
	[
		"the root file system and the declared mount are read-only",
		subjectWith({ facts: { "read-only": "@@root 0\n@@mount 1\n@@done\n" } }),
	],
	[
		"the metadata address is refused",
		subjectWith({
			facts: { metadata: "@@proxy 1 403\n@@direct 0 \n@@done\n" },
		}),
	],
	[
		"a link-local address is refused",
		subjectWith({
			facts: { "link-local": "@@proxy 0 \n@@direct 1 \n@@done\n" },
		}),
	],
	[
		"a host outside the allow list is refused",
		subjectWith({
			facts: { "outside-allow": "@@proxy 1 200\n@@direct 4 \n@@done\n" },
		}),
	],
	[
		"the allowed host is reached through the egress proxy, and only through it",
		subjectWith({ facts: { allowed: "@@proxy 1 403\n@@direct 4 \n@@done\n" } }),
	],
	[
		"a fork loop is stopped at the pids limit",
		subjectWith({ facts: { fork: "@@spawned 512\n@@running 515\n@@done\n" } }),
	],
	[
		"a sandbox's controlUrl is unreachable from a second sandbox of the same driver",
		subjectWith({ sharedControl: true }),
	],
	[
		"no container or VM is left after destroy",
		subjectWith({ leaveProcesses: true }),
	],
]);
