/**
 * The seccomp profile of every OCI sandbox (design §6.11 `S1`, "default
 * seccomp profile"). It allows by default and refuses, with `EPERM`, the
 * system calls Docker's and Podman's default profiles leave out for an
 * unprivileged container: mounting and namespace changes, kernel modules and
 * keyrings, tracing other processes, BPF and perf, clock and reboot control,
 * swap, and `open_by_handle_at`. `clone3` answers `ENOSYS`, as in those
 * profiles, so that C libraries fall back to `clone`, whose namespace flags
 * the profile refuses. Without capabilities most of these fail anyway; the
 * profile closes the kernel attack surface a capability check comes too late
 * for.
 */

// domain-view: the subset of the OCI runtime spec's `linux.seccomp` this driver writes.
export type SeccompProfile = Readonly<{
	defaultAction: "SCMP_ACT_ALLOW";
	architectures: readonly string[];
	syscalls: readonly Readonly<{
		names: readonly string[];
		action: "SCMP_ACT_ERRNO";
		errnoRet: number;
		args?: readonly Readonly<{
			index: number;
			value: number;
			valueTwo: number;
			op: "SCMP_CMP_MASKED_EQ";
		}>[];
	}>[];
}>;

const EPERM = 1;
const ENOSYS = 38;

/** System calls refused outright. */
export const REFUSED_SYSCALLS: readonly string[] = [
	"acct",
	"add_key",
	"bpf",
	"clock_adjtime",
	"clock_settime",
	"create_module",
	"delete_module",
	"finit_module",
	"fsconfig",
	"fsmount",
	"fsopen",
	"fspick",
	"get_kernel_syms",
	"init_module",
	"ioperm",
	"iopl",
	"kcmp",
	"kexec_file_load",
	"kexec_load",
	"keyctl",
	"lookup_dcookie",
	"mount",
	"mount_setattr",
	"move_mount",
	"move_pages",
	"name_to_handle_at",
	"nfsservctl",
	"open_by_handle_at",
	"open_tree",
	"perf_event_open",
	"pivot_root",
	"process_vm_readv",
	"process_vm_writev",
	"ptrace",
	"query_module",
	"quotactl",
	"quotactl_fd",
	"reboot",
	"request_key",
	"setns",
	"settimeofday",
	"stime",
	"swapoff",
	"swapon",
	"_sysctl",
	"umount",
	"umount2",
	"unshare",
	"uselib",
	"userfaultfd",
	"vm86",
	"vm86old",
];

/** The namespace flags of clone(2): NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET, NEWTIME. */
const CLONE_NAMESPACE_FLAGS: readonly number[] = [
	0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000,
	0x40000000, 0x00000080,
];

export function seccompProfile(): SeccompProfile {
	return {
		defaultAction: "SCMP_ACT_ALLOW",
		architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_AARCH64"],
		syscalls: [
			{ names: REFUSED_SYSCALLS, action: "SCMP_ACT_ERRNO", errnoRet: EPERM },
			{ names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: ENOSYS },
			...CLONE_NAMESPACE_FLAGS.map((flag) => ({
				names: ["clone"],
				action: "SCMP_ACT_ERRNO" as const,
				errnoRet: EPERM,
				args: [
					{
						index: 0,
						value: flag,
						valueTwo: flag,
						op: "SCMP_CMP_MASKED_EQ" as const,
					},
				],
			})),
		],
	};
}
