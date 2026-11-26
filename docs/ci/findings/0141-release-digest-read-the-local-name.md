---
type: CI Performance Finding
title: "Finding 141: release digest read the local name"
description: "Publish legs recorded RepoDigests[0], which on ARC pods is the local image name, so every attest leg found no digest and no release could tag."
tags: [hobo, ci, release, ghcr, attest, containerd]
---

# Finding 141: release digest read the local name

## Evidence

The first releases to publish every image ([finding 121](0121-release-publish-stalled-push-hit-job-limit.md)) then failed in attest:

- Run [43176733275](https://github.com/Hobo-Labs/HoBo/actions/runs/43176733275): 5 of 6 attest legs failed.
- Runs [43187234243](https://github.com/Hobo-Labs/HoBo/actions/runs/43187234243), [43200878944](https://github.com/Hobo-Labs/HoBo/actions/runs/43200878944) and [43220381971](https://github.com/Hobo-Labs/HoBo/actions/runs/43220381971): all 6 attest legs failed.

Each failure had the same error:

```text
##[error]no digest for hobo-sdk in /opt/actions-runner/_temp/hobo-release-digest/hobo-release-digest.txt
```

The `hobo-sdk` publish leg (ARC pod `hobo-trunk-runner-4chhm`) pushed `ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.159` and `docker push` printed `digest: sha256:e9e01db3…`. The leg then recorded `hobo-sdk@sha256:e9e01db3…`. The attest step selects the line containing `/hobo-sdk@`, so it found nothing. No signed tag and no GitHub Release came out of any of those runs.

## Cause

`push-release-ghcr-images.mts` read the pushed digest with `docker inspect --format={{index .RepoDigests 0}}`, which only works if the first entry is the registry reference.

- On fleet boxes, with Docker's classic image store, the first entry is the registry reference. The old single publish job ran there.
- On ARC pods, with the containerd image store, `RepoDigests` also holds the local name, `hobo-sdk@sha256:…`, and that comes first.

Once publish legs ran on ARC pods (one image per job, and trunk admission for release legs), every recorded reference was the local name. The one leg that passed in run 43176733275 (`hobo-ci-serve`) had run on a fleet box.

## Fix

`pushedDigestRef` builds the reference from the repository just pushed and the digest `docker push` printed. If the push printed none, it uses the `RepoDigests` entry for that repository, never the first entry. If neither is there, the leg fails with the entries it saw, so a reference attest cannot use is never written.

## Verified

`scripts/test/push-release-ghcr-images.test.ts` covers:

- run 43176733275's case: the push output plus a `RepoDigests` that holds only the local name;
- the fallback, which skips the local name;
- the refusal when neither source has the reference;
- that the line it writes is the one the attest action selects (`/<id>@`).
