---------------------------- MODULE QueueInspection --------------------------
EXTENDS Naturals
VARIABLES phase, authorized, revision, snapshot, result, unauthorized, stale
vars == <<phase, authorized, revision, snapshot, result, unauthorized, stale>>
Init ==
  /\ phase = "idle" /\ authorized = TRUE /\ revision = 0 /\ snapshot = 0
  /\ result = "none" /\ unauthorized = FALSE /\ stale = FALSE
Begin ==
  /\ phase = "idle" /\ authorized /\ phase' = "reading" /\ snapshot' = revision
  /\ UNCHANGED <<authorized, revision, result, unauthorized, stale>>
Revoke ==
  /\ authorized /\ authorized' = FALSE
  /\ UNCHANGED <<phase, revision, snapshot, result, unauthorized, stale>>
Write ==
  /\ revision < 2 /\ revision' = revision + 1
  /\ UNCHANGED <<phase, authorized, snapshot, result, unauthorized, stale>>
Disclose ==
  /\ phase = "reading" /\ authorized /\ revision = snapshot
  /\ phase' = "done" /\ result' = "available"
  /\ unauthorized' = (unauthorized \/ ~authorized)
  /\ stale' = (stale \/ revision # snapshot)
  /\ UNCHANGED <<authorized, revision, snapshot>>
Withhold ==
  /\ phase = "reading" /\ (~authorized \/ revision # snapshot)
  /\ phase' = "done" /\ result' = "unknown"
  /\ UNCHANGED <<authorized, revision, snapshot, unauthorized, stale>>
Next == Begin \/ Revoke \/ Write \/ Disclose \/ Withhold
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "reading", "done"} /\ authorized \in BOOLEAN
          /\ revision \in 0..2 /\ snapshot \in 0..2
          /\ result \in {"none", "available", "unknown"}
          /\ unauthorized \in BOOLEAN /\ stale \in BOOLEAN
NoUnauthorizedDisclosure == ~unauthorized
NoStaleDisclosure == ~stale
NeverAvailable == result # "available"
NeverUnknown == result # "unknown"
=============================================================================
