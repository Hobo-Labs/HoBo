# First-party CI bootstrap

This operator bootstrap brings up disposable GitHub-hosted worker VMs while the
ordinary `hobo` pool is unavailable. Original jobs still run through HoBo's
admission, durable local lease journal, JIT registration, attribution, cleanup and
settlement. Their checks and logs remain their original GitHub Actions jobs.

The manual acceptance workflow retains its normal acceptance mode. Its explicit
`controller` and `worker` modes use `ubuntu-24.04`, require the public repository,
and run only through `workflow_dispatch` on the reviewed bootstrap source branch.
The control branch is a separate, uniquely named ciphertext mailbox.

The local authority retains the financial journal and its administrative signing
key. A separate GitHub controller VM receives the App key only after its native
run, attempt, source SHA, job role and immutable public-key artifact are verified.
The App key is encrypted to that VM and never appears in repository plaintext,
workflow inputs, logs or worker VMs. App installation tokens are repository-scoped.

Each disposable worker VM receives one signed, encrypted JIT credential and a
bounded container specification. It has no App key, administrative signer, OIDC
permission or financial journal. The original job may use that VM's Docker
daemon; it cannot access the authority machine or controller VM. A fresh host
work directory preserves nested-Docker mounts. The pinned image must pass the
real runner contract on both the authority machine and worker VM before JIT use.

Admission evidence must expire before the controller's three-hour deadline,
leaving sufficient time for the longest job and cleanup. Native worker job
timeouts bound VM execution. Cleanup waits for confirmed native completion;
uncertain registration or dispatch results retain their local holds. Do not
rerun an existing controller attempt: dispatch a new run and a fresh mailbox.

Public repository visibility is checked before hosted dispatch and new JIT
admission; a visibility change does not prevent cancellation or runner deletion.
This bounded operational bootstrap does not establish provider-enforced spend
ceilings or replace production shared-budget evidence.

The fixture suites execute directly with Node 24's type stripping. They cover
forgery, expiry, replay, lost acknowledgements, private-visibility cleanup,
immutable artifact identity, native VM cancellation and historical attempts.
