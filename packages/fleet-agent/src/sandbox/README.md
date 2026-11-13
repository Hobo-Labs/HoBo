# Sandbox drivers (L38, L40)

`sandboxDrivers({ cap, log })` builds this platform's candidates, runs each
one's self-test, and answers one driver per tier: the first candidate of that
tier whose self-test passed, none above `cap` (an `UNSPECIFIED` cap answers
none). Design: ADR-0182, §6.11 and decision D58 of the fleet design.

| Tier | Platform | Runtime | Status |
|---|---|---|---|
| `S1_CONTAINER`, `S2_USER_KERNEL` | Linux | gVisor `runsc` 20261026.0, provisioned by the agent (one runtime, one self-test, both tiers) | Built; O10 run rootful and rootless against it |
| `S1_CONTAINER` | Linux | an operator's host `crun` or `runc` (`HOBO_FLEET_SANDBOX_RUNTIME`), only with delegated cgroups | Built; opt-in, never taken from `PATH` |
| `S3_MICROVM` | Linux | Kata (`containerd-shim-kata-v2`) | Self-test fails closed (A11 fallback) |
| `S3_MICROVM` | macOS | Apple `container` | Self-test fails closed (A12 fallback) |

## The runtime is not a host prerequisite (D58)

- **Provisioning** (`runtime-provision.ts`). In order: an operator-configured
  host runtime path; the verified cache `<cache>/runsc/20261026.0/<arch>/`
  (its stamp records the pinned tarball SHA-512 and every unpacked file's
  SHA-512, re-checked each time; a stale or corrupt copy is removed); a
  download of
  `https://storage.googleapis.com/gvisor/releases/release/20261026.0/<arch>/gvisor.tar.bz2`
  (`x86_64` or `aarch64`), checked against the pinned SHA-512 before anything
  is unpacked, unpacked (`runsc` and `gvisor-bin/`, mode 0755) into a
  temporary sibling and renamed into place; else unavailable with a reason
  (`unsupported-arch`, `not-provisioned`, `download-failed`,
  `checksum-mismatch`, `unpack-failed`, `host-runtime-unusable`). Unpacking
  is in-process (`bunzip2.ts`, `tar.ts`): `tar -xjf` would also need a host
  `bzip2`, which minimal images lack.
- **Settings** (environment): `HOBO_FLEET_SANDBOX_CACHE` (default
  `~/.cache/hobo-fleet`, or `/var/lib/hobo-fleet` as root),
  `HOBO_FLEET_SANDBOX_DOWNLOAD=0` (cache only), `HOBO_FLEET_SANDBOX_RUNTIME`
  (an operator's host runtime).
- **Privilege** (`privilege.ts`). Rootful when the effective uid is 0;
  rootless when an unprivileged user namespace can be created (the kernel
  switches `user.max_user_namespaces`, `kernel.unprivileged_userns_clone`,
  `kernel.apparmor_restrict_unprivileged_userns` are read, then the
  provisioned `runsc do true` runs with a one-id mapping); otherwise nothing
  is advertised and `hobo_fleet_sandbox_unavailable` names
  `no-root-or-userns` and the kernel setting.
- **Limits** (`privilege.ts`, `oci-config.ts`). Delegated cgroups when the
  agent may create them (root on a writable hierarchy, or a user whose
  cgroup's parent is writable with `memory` and `pids` enabled); runsc is
  then tried with cgroups first and in sentry mode second. Sentry mode:
  `runsc --ignore-cgroups`; the pids limit is `RLIMIT_NPROC` (counted by the
  sentry, per sandbox) and the memory limit each process's `RLIMIT_AS`; disk
  stays bounded by the sized tmpfs work directories. runsc 20261026.0 has no
  user-settable sentry memory or CPU count: `--total-memory` and `--cpu-num`
  are `runsc boot` flags runsc derives from the sandbox cgroup only (and
  `--total-memory` only sizes what `/proc/meminfo` reports), so **the CPU
  limit is not enforced in sentry mode**. `RLIMIT_NPROC` applies in both
  modes; the host cgroup's pids limit is a backstop above it, since gVisor
  backs each sandbox process with a host stub process.
- **CLI**: `node --import tsx packages/fleet-agent/src/cli/sandbox-provision.ts
  [--cache <dir>] [--probe]` provisions and probes with this same code and
  prints `{runtime, version, arch, digest, mode, cgroups, reason?}`; exit 0
  when a mode is available, 3 when not. CI runs exactly this
  (`.github/workflows/fleet-integration.yml`, "Provision the sandbox
  runtime"): it caches into `$RUNNER_TEMP/hobo-sandbox`, exports
  `HOBO_FLEET_SANDBOX_CACHE` and `HOBO_FLEET_SANDBOX_DOWNLOAD=0` for O10, lifts
  the user-namespace sysctls once with passwordless sudo when the probe is
  refused, and otherwise fails naming the kernel capability.

## How a sandbox is built

- **Image.** `image.ts` pulls the order's image over the registry API
  (anonymous bearer token when asked), checks every manifest and layer digest
  (and a pinned `@sha256:` reference), unpacks layers in order with OCI
  whiteouts, and caches the root file system by manifest digest. It is
  mounted read-only into every sandbox made from it.
- **Configuration** (`oci-config.ts`, `seccomp.ts`): no capabilities in any
  set, `noNewPrivileges`, a seccomp profile refusing mount, namespace,
  module, keyring, tracing, BPF/perf, clock, reboot and swap calls (and
  namespace flags on `clone`; `clone3` answers `ENOSYS`; runsc loads it in
  the sentry with `--oci-seccomp`), pids, memory and CPU limits, a read-only
  root, tmpfs `/tmp`, `/run` and `/work`, no host mount except the declared
  read-only ones (and the Docker socket only when `hostDocker`), and new pid,
  ipc, uts, mount, network and cgroup namespaces.
- **Ids.** Rootless: a user namespace mapping the sandbox's root to the
  agent's user. Rootful under a host runtime (A10's fallback): the sandbox's
  ids map to `2147418112 + [0, 65536)`; the image cache is owned by that
  range, and declared mounts are idmapped. Rootful under runsc: no user
  namespace; the sentry, which runsc starts with no host capabilities to
  speak of in a minimal chroot, is the boundary, and the gofer serves host
  files as their real owners.
- **Pod and forwarder** (D58; no host namespace tool). Under runsc each sandbox is a
  pod: the forwarder (`forwarder.ts`) is its sandbox container and the
  workload a second container in it (CRI annotations
  `io.kubernetes.cri.container-type` / `io.kubernetes.cri.sandbox-id`), on the
  sentry's loopback-only network stack (`--network=none`). The workload's pid
  namespace is a child of the forwarder's, so it cannot see the forwarder.
  The forwarder's root file system is the host's `/`, read-only, so the
  host's node runs unchanged, plus the per-sandbox socket directory; it holds
  no capability, runs as `FORWARDER_HOST_UID` when the agent is root (0,
  the agent's own id, rootless), and connects to the agent's Unix sockets
  through runsc `--host-uds=open` (runsc's gofer connects as the caller's
  uid, so the socket directory belongs to that uid). Under a host runtime the
  forwarder joins the workload's network namespace (and, rootless, its user
  namespace) by `/proc/<pid>/ns/...` path. The forwarder runs attached, its
  runtime relaying standard input, and exits when that closes.
- **Network.** The forwarder listens on two loopback ports and pipes them to
  two Unix sockets in the sandbox's private host directory: the relay to the
  order's egress proxy and the control endpoint. `http_proxy`/`https_proxy`
  (both cases) always name the first port; `controlUrl` is
  `http://127.0.0.1:<second port>`. Ports are distinct across the agent's
  live sandboxes, so a second sandbox has no listener on another's control
  port and its proxy refuses loopback.
- **Control endpoint.** `POST <controlUrl>/fence` with an `ObservedAssignment`
  answers `{"allow":true|false}` (always 200) from the `fence` callback;
  unreadable facts and a throwing callback answer `false`. Proxy-aware clients
  send this request through the proxy port (busybox wget ignores `no_proxy`),
  so the relay hands an absolute-form request for the sandbox's own
  `controlUrl` to the control endpoint; through a proxy busybox sends its
  `--post-file` body with `GET`, which the endpoint accepts as the POST it is.
- **Secrets and standard input.** `writeSecret(path, bytes)` runs `sh -c
  'umask 077 && mkdir -p … && cat > "$1"'` with the bytes on standard input;
  `path` must be a plain absolute path under a writable directory (`/run`,
  `/tmp`, `/work`). Exec argv and environment go to the runtime in a 0600
  process file, never on a command line. Under runsc an exec given standard
  input runs as `sh -c 'cat | "$@"' hobo-stdin <argv…>`, since runsc hands it
  a host pipe that a program inside cannot reopen as `/dev/stdin`.
- **Lifecycle.** One `create` per order id (across the tiers of one
  runtime), nothing runs after `destroy`, `destroy` is idempotent and removes
  the workload, the forwarder, the sockets and the bundle. An exec whose
  signal is already aborted answers 130.
- **Self-test.** The runtime's `--version`, then a trial sandbox over the
  host's own read-only `/usr` (no image pull) with the full configuration and
  the forwarder, running `true`. A failure logs
  `hobo_fleet_sandbox_unavailable` with the tiers, runtime and reason.

Images must carry `sh`, `cat` (for `writeSecret` and the runsc stdin relay)
and `sleep` (the init process).

## Assumptions

- **A10** — tested here on both modes against the provisioned runsc: rootful
  (agent as root, delegated cgroup v1, then sentry mode) and rootless (an
  unprivileged user, no cgroup delegation, sentry mode). The rootful
  fallback stays possible and is kept in `fleet-fallbacks.json`. One O10
  check still fails on runsc for a reason outside this package: gVisor
  always mounts its own `/dev` file system, of type `dev`, which the
  isolation probe's list of pseudo file systems (`@hobo/fleet` testing) does
  not name yet.
- **A11** — Kata is not provisioned; its driver fails closed, because the
  forwarder reaches a container through its network's loopback, which a
  virtual machine does not share.
- **A12** — not tested, fallback taken: macOS devices provide no sandbox tier
  from this agent build.

## Tests

- `test/sandbox/drivers.test.ts`: `runSandboxConformance` for the runsc `S1`
  and `S2` drivers over a recording double of the runtime calls
  (`test/sandbox/recording-oci.ts`), the pod and forwarder wiring under runsc
  and a host runtime, the stdin relay, relay and fence routing, secrets,
  cleanup, self-test, the microVM drivers and tier selection.
- `test/sandbox/runtime-provision.test.ts` (every provisioning branch, a real
  SHA-512 check of an embedded fixture tarball), `bunzip2.test.ts`,
  `privilege.test.ts`, `platform.test.ts` (candidates and settings),
  `oci-config.test.ts`, `image.test.ts`, `cli.test.ts`.
- `test/sandbox/isolation.integration.test.ts` (O10): the logic suite and
  `runSandboxIsolationProbe` against every driver `sandboxDrivers()` returns,
  with the runtime cache `HOBO_FLEET_SANDBOX_CACHE` names; fails when there is
  no `S1` driver.
