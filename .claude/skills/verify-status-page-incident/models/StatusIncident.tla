---------------------------- MODULE StatusIncident ----------------------------
EXTENDS Integers
CONSTANTS KeepMarker, RestoreImpact, KeepLifecycle, KeepFirstOpen, MergeFirstState
States == {"investigating", "identified", "monitoring", "resolved"}
Impacts == {"minor", "major", "critical"}
Rank == [s \in States |-> CASE s = "investigating" -> 0 [] s = "identified" -> 1 [] s = "monitoring" -> 2 [] OTHER -> 3]
Advance(current, incoming) == IF Rank[incoming] >= Rank[current] THEN incoming ELSE current
VARIABLES present, opened, pending, lifecycle, impact, firstImpact, expected
vars == <<present, opened, pending, lifecycle, impact, firstImpact, expected>>
Init == /\ present = FALSE /\ opened = FALSE /\ pending = FALSE
        /\ lifecycle = "missing" /\ impact = "none" /\ firstImpact = "none"
        /\ expected = "investigating"
Update(incoming) ==
  /\ incoming \in States
  /\ present' = TRUE /\ expected' = Advance(expected, incoming)
  /\ pending' = IF present THEN pending ELSE KeepMarker
  /\ lifecycle' = IF ~present THEN incoming ELSE IF KeepLifecycle THEN Advance(lifecycle, incoming) ELSE incoming
  /\ impact' = IF present THEN impact ELSE "minor"
  /\ UNCHANGED <<opened, firstImpact>>
Open(incoming, initialState) ==
  /\ incoming \in Impacts /\ initialState \in States
  /\ present' = TRUE /\ opened' = TRUE /\ pending' = FALSE
  /\ firstImpact' = IF opened THEN firstImpact ELSE incoming
  /\ lifecycle' = IF ~present THEN initialState
                   ELSE IF ~KeepLifecycle THEN initialState
                   ELSE IF ~opened /\ pending /\ MergeFirstState THEN Advance(lifecycle, initialState)
                   ELSE lifecycle
  /\ impact' = IF opened THEN IF KeepFirstOpen THEN impact ELSE incoming
                ELSE IF ~present THEN incoming
                ELSE IF pending /\ RestoreImpact THEN incoming ELSE impact
  /\ expected' = IF ~opened THEN Advance(expected, initialState) ELSE expected
Wait == UNCHANGED vars
Next == (\E incoming \in States : Update(incoming)) \/ (\E incoming \in Impacts : \E initialState \in States : Open(incoming, initialState)) \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ present \in BOOLEAN /\ opened \in BOOLEAN /\ pending \in BOOLEAN
          /\ lifecycle \in States \cup {"missing"} /\ impact \in Impacts \cup {"none"}
          /\ firstImpact \in Impacts \cup {"none"} /\ expected \in States
PendingRecorded == opened \/ ~present \/ pending
ImpactMatches == ~opened \/ impact = firstImpact
LifecycleMatches == IF present THEN lifecycle = expected ELSE lifecycle = "missing"
=============================================================================
