---
type: CI Verification Contract
title: "Pull request head publication proof"
description: "How the local signoff coordinator can verify a pull request's current head."
tags: [hobo, ci, github, attestation]
---

# Pull request head publication proof

`verifyPrHead` in `scripts/ci/github-pr-target.mts` is a read-only helper for
the local signoff coordinator. It does not run checks, create a Git witness, or
post a status. The caller first verifies and pins `GH_HOST` and `GH_REPO` to the
target repository and supplies the tested base branch, base SHA and head SHA.

An explicit positive PR number works with detached checkouts. Without one, the
helper asks `gh pr view` for a candidate number; failure or an ambiguous answer
requires the operator to supply a number. Discovery alone is not proof. The
target repository's PR response must be open and match the tested base branch
and exact head SHA. Its base and head repository identities must match separately
read repository IDs and names, for both same-repository and fork PRs. GitHub's
PR `base.sha` can lag the branch, so the helper reads the live base branch and
requires its name and SHA to match the tested base, then rechecks the target
repository identity.
The live head branch must have the same name and point at the tested head;
branch names are encoded in the API path, including `/`.

The returned proof contains the host, PR number, both repository names and IDs,
both branch names, and both commit SHAs. The caller must verify again immediately
before publication, using the first proof's PR number, and compare the entire
second proof with the first. Each verification also rechecks the head repository
identity and PR after reading the head branch. Missing or malformed data, a
closed or retargeted PR, a moved branch, a changed repository identity, an
inaccessible head repository, a rate limit or an API failure refuses the proof.
Error messages do not include subprocess output or credentials.

The target PR and repository and the head repository and branch must be
readable by the `gh` credential. A private or deleted fork may appear as 404;
that response does not establish its state. Posting a status separately needs
the appropriate target-repository permission.

These reads are point-in-time evidence. They cannot be atomic with a later
status write: a PR can move or close after the recheck, and a status remains
attached to a repository and commit SHA rather than to a PR or base. Consumers
must not treat this helper as proof that a status is still current or that an
existing branch-protection or merge-queue requirement is satisfied.
