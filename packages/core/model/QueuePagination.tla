---------------------------- MODULE QueuePagination --------------------------
EXTENDS Naturals, FiniteSets
Ids == 1..3
VARIABLES exhausted, revision, base, cursor, seen, staleRead, completed
vars == <<exhausted, revision, base, cursor, seen, staleRead, completed>>
Init == /\ exhausted = Ids /\ revision = 0 /\ base = 0 /\ cursor = 0
        /\ seen = {} /\ staleRead = FALSE /\ completed = FALSE
Candidates == {m \in exhausted : m > cursor}
Read ==
  /\ revision = base /\ Candidates # {}
  /\ LET next == CHOOSE m \in Candidates : \A n \in Candidates: m <= n
     IN /\ cursor' = next /\ seen' = seen \cup {next}
  /\ staleRead' = (staleRead \/ revision # base)
  /\ UNCHANGED <<exhausted, revision, base, completed>>
Finish ==
  /\ revision = base /\ Candidates = {} /\ ~completed /\ completed' = TRUE
  /\ UNCHANGED <<exhausted, revision, base, cursor, seen, staleRead>>
Change(m) ==
  /\ m \in exhausted /\ revision = 0 /\ exhausted' = exhausted \ {m}
  /\ revision' = 1
  /\ UNCHANGED <<base, cursor, seen, staleRead, completed>>
Restart ==
  /\ revision # base /\ base' = revision /\ cursor' = 0 /\ seen' = {}
  /\ completed' = FALSE
  /\ UNCHANGED <<exhausted, revision, staleRead>>
Next == Read \/ Finish \/ Restart \/ (\E m \in Ids: Change(m))
Spec == Init /\ [][Next]_vars
TypeOK == /\ exhausted \subseteq Ids /\ revision \in 0..1 /\ base \in 0..1
          /\ cursor \in 0..3 /\ seen \subseteq Ids /\ staleRead \in BOOLEAN /\ completed \in BOOLEAN
NoSkipped == revision = base => seen = {m \in exhausted : m <= cursor}
NoStaleRead == ~staleRead
NeverRead == cursor = 0
NeverRestart == base = 0
NeverFinished == ~completed
=============================================================================
