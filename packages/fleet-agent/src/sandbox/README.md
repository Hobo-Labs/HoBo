# Sandbox drivers (L38)

`sandboxDrivers({ cap, log })` builds this platform's candidates, runs each
one's self-test, and answers one driver per tier: the first candidate of that
tier whose self-test passed, none above `cap` (an `UNSPECIFIED` cap answers
none). Design: ADR-0182, §6.11 of the fleet design.

| Tier | Platform | Runtime | Status |
|---|---|---|---|
| `S1_CONTAINER` | Linux | `crun`, else `runc` (OCI runtime CLI, bundles written by the driver) | Built; O10 passes on a rootful host |
| `S2_USER_KERNEL` | Linux | gVisor `runsc` with `--network=host` (the sandbox's own namespace) | Built over the same driver; not provisioned, not probed (A11) |
| `S3_MICROVM` | Linux | Kata (`containerd-shim-kata-v2`) | Self-test fails closed (A11 fallback) |
| `S3_MICROVM` | macOS | Apple `container` | Self-test fails closed (A12 fallback) |

## How an OCI sandbox is built

- **Image.** `image.ts` pulls the order's image over the registry API
  (anonymous bearer token when asked), checks every manifest and layer digest
  (and a pinned `@sha256:` reference), unpacks layers in order with OCI
  whiteouts, and caches the root file system by manifest digest. It is
  mounted read-only into every sandbox made from it.
- **Configuration** (`oci-config.ts`, `seccomp.ts`): no capabilities in any
  set, `noNewPrivileges`, a seccomp profile refusing mount, namespace,
  module, keyring, tracing, BPF/perf, clock, reboot and swap calls (and
  namespace flags on `clone`; `clone3` answers `ENOSYS`), pids, memory and
  CPU limits, a read-only root, tmpfs `/tmp`, `/run` and `/work`, no host
  mount except the declared read-only ones (and the Docker socket only when
  `hostDocker`), and new pid, ipc, uts, mount, network, cgroup and user
  namespaces.
- **Ids.** Rootless: the sandbox's root is the agent's user. Rootful (A10's
  fallback): the sandbox's ids map to `2147418112 + [0, 65536)`; the image
  cache is owned by that range, and declared mounts are idmapped so a private
  source stays readable.
- **Network.** The network namespace holds only loopback. The forwarder
  (`forwarder.ts`, run with `nsenter --net`) listens on two loopback ports in
  it and pipes them to two Unix sockets in the sandbox's private host
  directory: the relay to the order's egress proxy and the control endpoint.
  `http_proxy`/`https_proxy` (both cases) always name the first port;
  `controlUrl` is `http://127.0.0.1:<second port>`. Ports are distinct across
  the agent's live sandboxes, so a second sandbox has no listener on another's
  control port and its proxy refuses loopback.
- **Control endpoint.** `POST <controlUrl>/fence` with an `ObservedAssignment`
  answers `{"allow":true|false}` (always 200) from the `fence` callback;
  unreadable facts and a throwing callback answer `false`. Proxy-aware clients
  send this request through the proxy port (busybox wget ignores `no_proxy`),
  so the relay hands an absolute-form request for the sandbox's own
  `controlUrl` to the control endpoint; through a proxy busybox sends its
  `--post-file` body with `GET`, which the endpoint accepts as the POST it is.
- **Secrets.** `writeSecret(path, bytes)` runs `sh -c 'umask 077 && mkdir -p
  … && cat > "$1"'` with the bytes on standard input; `path` must be a plain
  absolute path under a writable directory (`/run`, `/tmp`, `/work`). Exec
  argv and environment go to the runtime in a 0600 process file, never on a
  command line.
- **Lifecycle.** One `create` per order id, nothing runs after `destroy`,
  `destroy` is idempotent and removes the container, the forwarder, the
  sockets and the bundle. An exec whose signal is already aborted answers 130.
- **Self-test.** The runtime's `--version`, then a trial sandbox over the
  host's own read-only `/usr` (no image pull) with the full configuration and
  the forwarder, running `true`. A failure logs
  `hobo_fleet_sandbox_unavailable` with the tier, runtime and reason.

Images must carry `sh` (for `writeSecret`) and `sleep` (the init process).

## Assumptions

- **A10** — not tested rootless here: the verification host runs the agent as
  root, so O10 was proven on the fallback (rootful runtime, user-namespace
  remapping). The rootless path is built (single-id mapping, forwarder enters
  the user namespace) but needs cgroup delegation to apply limits; without it
  the self-test fails and no `S1` is advertised.
- **A11** — not tested, fallback taken: gVisor and Kata are not provisioned.
  `runsc` is a candidate and is advertised only if its self-test passes; the
  Kata driver fails closed, because the forwarder reaches a container through
  its namespace's loopback, which a virtual machine does not share.
- **A12** — not tested, fallback taken: macOS devices provide no sandbox tier
  from this agent build (no Linux container runtime there, and the Apple
  `container` driver fails closed for the same reason as Kata).

## Tests

- `test/sandbox/drivers.test.ts`: `runSandboxConformance` for the `S1` and
  `S2` drivers over a recording double of the runtime calls
  (`test/sandbox/recording-oci.ts`), the relay and fence routing, secrets,
  cleanup, self-test, the microVM drivers and tier selection.
- `test/sandbox/oci-config.test.ts`, `test/sandbox/image.test.ts`.
- `test/sandbox/isolation.integration.test.ts` (O10): the logic suite and
  `runSandboxIsolationProbe` against every driver `sandboxDrivers()` returns;
  fails when there is no `S1` driver.
