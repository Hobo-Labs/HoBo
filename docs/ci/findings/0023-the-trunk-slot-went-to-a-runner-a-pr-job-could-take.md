---
type: CI Performance Finding
title: "Finding 23: the trunk slot went to a runner a PR job could take"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 23: the trunk slot went to a runner a PR job could take

Main push 14f6dc03 (#1686) created **HoBo CI Fabric** run **41764685484** and **HoBo Pricing CI** run **41764685602** at 03:03:34Z. The fabric run's **CI runner image (mise oci)** job did not start until 03:05:39, a **2 m 04 s** wait. The pricing run's **@hobo/pricing affected gate** started at 03:07:26, a **3 m 52 s** wait. Both waited behind PR jobs despite `HOBO_CI_WORKER_SLOTS=3`, one strictly reserved trunk slot, and the trunk-label expression added by #1691.

The relay classified trunk capacity by run event. A push job asking for shared `hobo` was therefore exempt from `generalLeaseLimit` and could take the reserved slot, but its JIT runner also registered as `hobo`. GitHub could give that runner to the oldest queued PR job, which then occupied the trunk slot for its whole run while `hobo-trunk` jobs waited. The incident workflows made this concrete: `pricing-ci.yml` used plain `hobo` on push, as did `release-pricing.yml`, `dev-env-smoke.yml`, `examples-e2e.yml`, and the manual acceptance workflow.

The fix separates **ordering** from **capacity**. Run event still sorts push, dispatch, and merge-group work first, but only a job requesting `hobo-trunk` is exempt from the shared-label cap or eligible to reclaim an unlaunched general reservation. A trunk-event job on `hobo` is capped like PR work and logs `hobo_ci_trunk_job_on_shared_label` once, naming its repository, workflow, run, and job. Every trunk-capable box workflow now uses the same label expression as `hobo-ci.yml`; the `trunk-label-routing` Actions lint rejects shared `hobo` on trunk-capable jobs and rejects the expression on PR-only jobs. Other repositories served by the box must make the same workflow change.

A trunk-label job that cannot reserve now reclaims the newest general lease that is still `reserved` with no container, runner, or host run, in strict mode as well as lending mode. This also lets excess trunk demand take general slots ahead of queued PR jobs. Running PR jobs are never stopped. Prewarm was not a second cause: an idle warm container has no lease, does not count against `slots`, and is renamed and reused for the trunk launch. Reservation and reserved-launch ordering were already trunk-first; swapped jobs re-enter that same ordering with their current labels, and deferred reservation reorders each poller batch independently of ingestion order.

To protect the GitHub App's 5,000-request/h installation budget, the relay now caches each immutable served runner label by repository and job ID, prunes entries when leases become inactive, and treats failed lookups as general while retrying them on the next tick.

The target is a **~100 s main critical path** with the reserved slot going directly to a `hobo-trunk` runner rather than paying a PR job's full runtime. Regression tests drive the real relay and fake controller through the incident shape, strict preemption, running-job safety, and pre-warmed trunk launch.

The stage-gate `scanGroup` regression test previously waited for Node's exec'd leader to keep the symlink name, but Node 24.22 names its main thread `MainThread` during startup, overwriting `/proc/<pid>/comm`; its 20-second lifetime could also expire before cleanup, making the group kill fail with ESRCH (runs 41796130401 and 41796132887). The test now sets `process.title` after startup, signals `ready` only after observing the spawned `sleep 0` in Z state, stays alive until killed, and treats an ESRCH group kill as already exited, making readiness event-driven and cleanup idempotent.
