# HOBO-407 Release Notes and Upgrade Guide Proof

HOBO-407 is proven by the focused M0 contract at
[`src/draft/technical-proofs/v1-release-notes-upgrade-guide-contract`](../../../../src/draft/technical-proofs/v1-release-notes-upgrade-guide-contract/README.md)
and the durable outline record at [release-notes-upgrade-guide.md](../../release-notes-upgrade-guide.md).

## Acceptance Evidence

- The outline covers release summary, supported install paths, upgrade paths, compatibility matrix,
  known limitations, rollback guidance, migration notes, and support contacts.
- Required inputs map to release engineering, docs, bootstrap, compatibility, and support owners.
- Missing evidence is classified as release-blocker candidate, explicit follow-up, or accepted
  substitute evidence.

## Negative Coverage

- Final release notes cannot be published before release-candidate evidence is accepted.
- Compatibility guarantees are rejected unless they carry test or smoke evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\v1-release-notes-upgrade-guide-contract test
```
