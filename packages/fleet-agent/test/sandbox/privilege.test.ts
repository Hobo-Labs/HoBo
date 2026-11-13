/**
 * The privilege and cgroup probes (D58, A10): which mode a sandbox runs in
 * on this host, decided from facts the probes read, never assumed.
 */
import { describe, expect, it } from "vitest";
import {
	type HostFacts,
	probeCgroups,
	probePrivilege,
} from "../../src/sandbox/privilege.js";

function host(
	files: Readonly<Record<string, string>>,
	writable: readonly string[] = [],
): HostFacts {
	return {
		readFile: (path) => files[path],
		exists: (path) => files[path] !== undefined || writable.includes(path),
		writable: (path) => writable.includes(path),
	};
}

const PERMISSIVE = host({ "/proc/sys/user/max_user_namespaces": "63000\n" });

describe("probePrivilege", () => {
	it("is rootful when the effective uid is 0, without a trial", async () => {
		let trials = 0;
		const answer = await probePrivilege({
			euid: 0,
			host: PERMISSIVE,
			trial: async () => {
				trials += 1;
				return { ok: true, detail: "" };
			},
		});
		expect(answer.mode).toBe("rootful");
		expect(trials).toBe(0);
	});

	it("is rootless when an unprivileged user namespace can be created", async () => {
		const answer = await probePrivilege({
			euid: 1000,
			host: PERMISSIVE,
			trial: async () => ({ ok: true, detail: "runsc do true" }),
		});
		expect(answer).toEqual({ mode: "rootless", detail: "runsc do true" });
	});

	it("leaves rootless to the runsc self-test when no trial can run", async () => {
		const answer = await probePrivilege({
			euid: 1000,
			host: PERMISSIVE,
			trial: undefined,
		});
		expect(answer.mode).toBe("rootless");
		expect(answer.detail).toMatch(/self-test/u);
	});

	it("is unavailable, naming the kernel setting, when user namespaces are switched off", async () => {
		for (const [path, value, named] of [
			["/proc/sys/user/max_user_namespaces", "0", "user.max_user_namespaces=0"],
			[
				"/proc/sys/kernel/unprivileged_userns_clone",
				"0",
				"kernel.unprivileged_userns_clone=0",
			],
			[
				"/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
				"1",
				"kernel.apparmor_restrict_unprivileged_userns=1",
			],
		] as const) {
			let trials = 0;
			const answer = await probePrivilege({
				euid: 1000,
				host: host({ [path]: `${value}\n` }),
				trial: async () => {
					trials += 1;
					return { ok: true, detail: "" };
				},
			});
			expect(answer).toEqual({
				mode: "unavailable",
				reason: "no-root-or-userns",
				detail: expect.stringContaining(named),
			});
			expect(trials).toBe(0);
		}
	});

	it("is unavailable when the user-namespace trial fails", async () => {
		const answer = await probePrivilege({
			euid: 1000,
			host: PERMISSIVE,
			trial: async () => ({
				ok: false,
				detail: "unshare: operation not permitted",
			}),
		});
		expect(answer).toEqual({
			mode: "unavailable",
			reason: "no-root-or-userns",
			detail: expect.stringContaining("operation not permitted"),
		});
	});
});

describe("probeCgroups", () => {
	const v2 = (own: string, extra: Readonly<Record<string, string>> = {}) => ({
		"/proc/self/cgroup": `0::${own}\n`,
		"/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
		...extra,
	});

	it("is delegated for root on a writable cgroup v2 hierarchy, under /hobo-fleet", () => {
		expect(
			probeCgroups(0, host(v2("/init.scope"), ["/sys/fs/cgroup"])),
		).toEqual({
			mode: "delegated",
			parent: "/hobo-fleet",
			detail: expect.any(String),
		});
	});

	it("is delegated for root on writable cgroup v1 memory and pids hierarchies", () => {
		const facts = host({ "/proc/self/cgroup": "4:memory:/x\n8:pids:/x\n" }, [
			"/sys/fs/cgroup/memory",
			"/sys/fs/cgroup/pids",
		]);
		expect(probeCgroups(0, facts).mode).toBe("delegated");
		expect(
			probeCgroups(
				0,
				host({ "/proc/self/cgroup": "4:memory:/x\n" }, [
					"/sys/fs/cgroup/memory",
				]),
			).mode,
		).toBe("sentry");
	});

	it("is delegated for a user whose cgroup's parent is writable and enables memory and pids", () => {
		const own = "/user.slice/user-1000.slice/user@1000.service/app.slice/agent";
		const parent = "/user.slice/user-1000.slice/user@1000.service/app.slice";
		const facts = host(
			v2(own, {
				[`/sys/fs/cgroup${parent}/cgroup.subtree_control`]: "cpu memory pids\n",
			}),
			[`/sys/fs/cgroup${parent}`],
		);
		expect(probeCgroups(1000, facts)).toEqual({
			mode: "delegated",
			parent,
			detail: expect.any(String),
		});
	});

	it("falls back to the sentry when delegation is absent", () => {
		const own = "/user.slice/user-1000.slice/session-1.scope";
		for (const facts of [
			// No cgroup v2 at all, not root.
			host({ "/proc/self/cgroup": "4:memory:/x\n" }),
			// v2, parent not writable.
			host(
				v2(own, {
					"/sys/fs/cgroup/user.slice/user-1000.slice/cgroup.subtree_control":
						"memory pids\n",
				}),
			),
			// v2, parent writable but memory not enabled for children.
			host(
				v2(own, {
					"/sys/fs/cgroup/user.slice/user-1000.slice/cgroup.subtree_control":
						"pids\n",
				}),
				["/sys/fs/cgroup/user.slice/user-1000.slice"],
			),
		])
			expect(probeCgroups(1000, facts).mode).toBe("sentry");
		// Root, but a read-only cgroup file system.
		expect(probeCgroups(0, host(v2("/"))).mode).toBe("sentry");
	});
});
