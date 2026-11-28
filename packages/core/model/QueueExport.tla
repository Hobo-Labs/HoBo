------------------------------ MODULE QueueExport -----------------------------
EXTENDS Naturals
VARIABLES phase, sink, revision, snapshot, completed, premature, stale
vars == <<phase, sink, revision, snapshot, completed, premature, stale>>
Init == /\ phase = "idle" /\ sink = "none" /\ revision = 0 /\ snapshot = 0
        /\ completed = FALSE /\ premature = FALSE /\ stale = FALSE
Inspect == /\ phase = "idle" /\ phase' = "observed" /\ snapshot' = revision
           /\ UNCHANGED <<sink, revision, completed, premature, stale>>
SendCommitted == /\ sink \in {"none", "unknown"} /\ sink' = "committed"
                 /\ UNCHANGED <<phase, revision, snapshot, completed, premature, stale>>
SendUnknown == /\ sink = "none" /\ sink' = "unknown"
               /\ UNCHANGED <<phase, revision, snapshot, completed, premature, stale>>
Write == /\ revision < 2 /\ revision' = revision + 1
         /\ UNCHANGED <<phase, sink, snapshot, completed, premature, stale>>
Confirm ==
  /\ phase = "observed" /\ sink = "committed" /\ revision = snapshot
  /\ phase' = "done" /\ completed' = TRUE
  /\ premature' = (premature \/ sink # "committed")
  /\ stale' = (stale \/ revision # snapshot)
  /\ UNCHANGED <<sink, revision, snapshot>>
Next == Inspect \/ SendCommitted \/ SendUnknown \/ Write \/ Confirm
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "observed", "done"} /\ sink \in {"none", "committed", "unknown"}
          /\ revision \in 0..2 /\ snapshot \in 0..2
          /\ completed \in BOOLEAN /\ premature \in BOOLEAN /\ stale \in BOOLEAN
NoPrematureCompletion == ~premature
NoStaleCompletion == ~stale
NeverCompleted == ~completed
NeverUnknown == sink # "unknown"
=============================================================================
