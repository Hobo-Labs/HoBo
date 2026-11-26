# Native acceptance

Executed 2026-10-29T22:00:55.376Z on Linux with local Docker. SDK @cloudflare/ci 0.2.0, Sandbox 0.12.1, Wrangler 4.114.0. No Cloudflare account or paid resources.

Complete safety graph: 278 states / 3224 transitions.

Source: 955a9030c933a441c5b31b4e4e25eebf72ba9835. Binary artifact SHA-256: e3f2a792a3e74937997170ea5e50290c3cfb9a0f5dedbbaf6354569c7d6531d2.

| Case | Native Workflow | Outcome | CLI exit | Shutdown |
| --- | --- | --- | --- | --- |
| native-success | a22137e6-5056-4170-80e8-ef751689103a | succeeded | 0 | confirmed |
| native-success | a22137e6-5056-4170-80e8-ef751689103a | succeeded | 0 | confirmed |
| native-failure | 9cf7fbb4-1123-4c9d-96be-c1b589e2d74d | failed | 1 | confirmed |
| native-timeout | 363e3adf-f86c-41ca-b9d7-3c6d39d5e3d5 | timed_out | 124 | confirmed |
| native-cancel | 742c6bee-b707-449e-9b79-b8fc954676f6 | cancelled | 130 | confirmed |
| native-crash | d824fcb7-a45d-43cd-81a3-79bb8669bcb9 | uncertain | 2 | confirmed |
| native-output-bound | 78aa9363-4db7-4a41-9a50-0ce803c8d643 | failed | 1 | confirmed |

Each row has a protobuf run receipt and retained native runtime/journal/R2 evidence in its preparation directory. External bridge HTTP counters proved failure stopped later commands and crash cleanup did not repeat side effects. Mandatory TPROXY interception was inspected in the real native proxy.

Additional stress assertions in the executed suite: shared-package rebuild did
not hot-reload the frozen Worker; concurrent controller admission was refused;
fresh admission after a crash required explicit recovery; private API calls without
a token or with an Origin were rejected; mandatory TPROXY rules remained active
and an invalid rule propagated its error. Finished-receipt replay used the recorded
Docker daemon despite a deliberately invalid current context.

All six preparations produced the same source-archive digest and reused one
Docker image. The host's `vfs` driver previously amplified timestamped archives
into retained copies; deterministic archives remove that repeated-source growth.
Normal image/state retention still follows the documented Docker cleanup policy.

This is local native evidence. The finite-state proof establishes the controller
safety contract under typed event assumptions; it does not prove the internals of
Docker, Cloudflare or external command effects. See [proof scope](README.md).
