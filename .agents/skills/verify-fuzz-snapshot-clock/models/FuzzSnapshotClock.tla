-------------------------- MODULE FuzzSnapshotClock --------------------------
EXTENDS Integers, FiniteSets
CONSTANTS Limit, TickRetry, TickRollback, GuardLimit
VARIABLES clock, previous, value, saved, original, changed, lastTarget
vars == <<clock, previous, value, saved, original, changed, lastTarget>>
Clocks == 0..Limit
Init == /\ clock = 0 /\ previous = 0 /\ value = 0
        /\ saved = [i \in Clocks |-> -1] /\ original = saved
        /\ changed = FALSE /\ lastTarget = -1
CanMutate == clock < Limit \/ ~GuardLimit
NextClock(tick) == IF tick /\ clock < Limit THEN clock + 1 ELSE clock
Retry == /\ CanMutate /\ clock' = NextClock(TickRetry) /\ previous' = clock
         /\ value' = 1 - value /\ changed' = TRUE /\ lastTarget' = -1
         /\ UNCHANGED <<saved, original>>
Rollback == \E target \in Clocks:
            /\ CanMutate /\ saved[target] # -1
            /\ clock' = NextClock(TickRollback) /\ previous' = clock
            /\ value' = saved[target] /\ changed' = TRUE /\ lastTarget' = target
            /\ UNCHANGED <<saved, original>>
Snapshot == /\ saved' = [saved EXCEPT ![clock] = value]
            /\ original' = IF original[clock] = -1
                           THEN [original EXCEPT ![clock] = value]
                           ELSE original
            /\ previous' = clock /\ changed' = FALSE /\ lastTarget' = -1
            /\ UNCHANGED <<clock, value>>
Wait == UNCHANGED vars
Next == Retry \/ Rollback \/ Snapshot \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ clock \in Clocks /\ previous \in Clocks /\ value \in 0..1
          /\ saved \in [Clocks -> {-1, 0, 1}]
          /\ original \in [Clocks -> {-1, 0, 1}]
          /\ changed \in BOOLEAN /\ lastTarget \in {-1} \cup Clocks
SnapshotStable == saved = original
MutationAdvances == ~changed \/ clock > previous
RollbackRestored == lastTarget = -1 \/ value = saved[lastTarget]
=============================================================================
