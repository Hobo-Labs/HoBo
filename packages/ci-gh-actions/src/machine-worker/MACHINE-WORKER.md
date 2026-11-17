# Machine worker

The machine worker is what `hobo ci machine connect` runs on a computer its owner connects to HoBo CI. It is part of the runner-order work recorded in [ADR-0183](../../../../docs/design/adr/runner-order.md): a connected machine is a step a runner order can route jobs to, and the worker is the part that runs them.

## What it does

| Step | What happens |
| --- | --- |
| Advertise | Every 30 seconds the worker signs an advert with the machine's own Ed25519 key and sends it to the machine registry. The advert says the machine's label (`hobo-machine-<id>`), its OS and architecture labels, its slots and how many are busy, whether it is paused, who may use it, and whether jobs run in a container or on the host. It is sent again at once when one of those changes. |
| Find jobs | A job is for the machine when its `runs-on` names the machine's label, which a routing decision put there. With no relay, the worker reads GitHub's queue for that label in the repositories named with `--repo`, with the owner's own GitHub token, at most every 15 seconds. A relay can instead assign jobs to it (`assignedJobSource`). |
| Refuse | A job from a public repository, or a pull request from a fork, never runs on a machine. The worker refuses it before it asks GitHub for anything. |
| One runner per job | For each job the worker asks GitHub for a one-job (just-in-time) runner on the job's repository, labelled with the machine's label. It checks the configuration with `parseJitConfig` before anything uses it: every URL must be https on a GitHub host, and the runner must be the one asked for. A configuration that fails is never handed to the runner program. |
| Run | By default the job runs in a container made for it and removed after it, through the same driver and start script the box uses. The container gets the pinned runner's download URL and SHA-256 and the proxy settings, and nothing from the CLI's environment. With `--host` the job runs on the machine as the user who connected it; the pinned runner archive is downloaded once, checked against its SHA-256 before every job, and unpacked fresh for each job, with only the bridge's environment allow-list. The configuration reaches the runner in `ACTIONS_RUNNER_INPUT_JITCONFIG`, never on a command line. |
| Clean up | GitHub removes a one-job runner after its job. A runner that never got its job, or whose job was stopped, is removed by the worker, so the machine keeps no permanent runner. |
| Stop | The first Ctrl-C drains: the worker takes no new jobs, lets the running ones finish and then takes the machine offline. A second Ctrl-C hands off: the running jobs are stopped as well. Either way the machine is offline in the registry at once, so the next decision passes it over without waiting for its advert to expire. |

The owner's pause wins: a pause set with `p` on the terminal or with `hobo ci machine pause` is kept by the registry, and the worker takes no job while the registry says the machine is paused. If the registry refuses the machine because its id is held by another key or owner, the worker stops taking jobs until the owner removes the old machine.

## Files

| File | Holds |
| --- | --- |
| `advert.ts` | The machine's advert, signing, and the registry sink (advertise, pause, offline) |
| `jobs.ts` | Job offers, the GitHub queue source, the relay-assigned source, and one-job runner creation and removal |
| `executor.ts` | The container and host executors, the job environments and the pinned runner program |
| `worker.ts` | The loop: advertise, take, refuse, run, drain and hand off |
| `session.ts` | One connect: the machine's stored id and key, the owner from `GET /user`, Linux only, and the loop that ticks the worker each second until the first stop drains it and a second hands off |
| `testing.ts` | A container driver and host process whose runner is a test function; nothing in it starts a process |

## What is proven and what is not

The worker is tested against the GitHub simulator with the fake container driver: adverts, one runner per job, container per job, refusals, the configuration check, pause, concurrency, drain and hand-off. Nothing has yet run it on a real machine against GitHub. Until a run is linked, the following are built, not proven:

- the default job image (`ghcr.io/actions/actions-runner` at the pinned runner version) starting the pinned runner through the box's start script;
- `--host` on a real Linux machine;
- the relay assigning jobs to a machine: the worker has the source a relay pushes into, but no relay endpoint sends to it yet.

macOS machines are not supported yet: the pinned runner archives are for Linux.
