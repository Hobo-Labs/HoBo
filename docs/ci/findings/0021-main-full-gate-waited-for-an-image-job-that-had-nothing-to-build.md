---
type: CI Performance Finding
title: "Finding 21: Main full gate waited for an image job that had nothing to build"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 21: Main full gate waited for an image job that had nothing to build

Main push run 41762556455 took 107 s. The run was created at 02:43:10; CI runner image (mise oci) ran 02:43:28–02:43:40, spending 18 s waiting for a runner and then 12 s on a no-op because no image input changed. Main full gate ran 02:44:04–02:44:56.
Its `needs: ci-runner-image` kept it queued until the image job ended, and the box then needed about 24 s more for its next 15 s poll, container start and JIT runner start. About 36 s of the critical path was therefore the no-op image job plus the second launch.

The image job now skips a push when the payload's per-commit added, modified and removed file lists contain none of the image inputs; a skipped job satisfies `needs` immediately. Missing file lists and forced pushes fail open toward building, and a push that changes an input still builds and retags the image before Main full gate starts. The full-history secret scan moved from the image job to Main full gate so it still runs when the image job skips.

Expected saving: about 36 s of critical path on a push that leaves the image inputs alone. The remaining 18 s before the first job is the box's 15 s poll interval plus container start, a separate target.
