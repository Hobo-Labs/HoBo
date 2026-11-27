-------------------------- MODULE QueueSnapshotTime --------------------------
EXTENDS Naturals, FiniteSets
Ids == 1..3
Expires == [m \in Ids |-> IF m = 2 THEN 2 ELSE 1]
VARIABLES clock, snapshot, cursor, seen
vars == <<clock, snapshot, cursor, seen>>
Init == /\ clock = 1 /\ snapshot = 1 /\ cursor = 0 /\ seen = {}
Eligible == {m \in Ids : Expires[m] <= snapshot /\ m > cursor}
Read ==
  /\ Eligible # {}
  /\ LET next == CHOOSE m \in Eligible : \A n \in Eligible: m <= n
     IN /\ cursor' = next /\ seen' = seen \cup {next}
  /\ UNCHANGED <<clock, snapshot>>
Advance == /\ clock = 1 /\ clock' = 2 /\ UNCHANGED <<snapshot, cursor, seen>>
Next == Read \/ Advance
Spec == Init /\ [][Next]_vars
TypeOK == /\ clock \in 1..2 /\ snapshot = 1 /\ cursor \in 0..3 /\ seen \subseteq Ids
SnapshotOnly == \A m \in seen : Expires[m] <= snapshot
NoSkipped == seen = {m \in Ids : Expires[m] <= snapshot /\ m <= cursor}
NeverAdvance == clock = 1
NeverRead == cursor = 0
=============================================================================
