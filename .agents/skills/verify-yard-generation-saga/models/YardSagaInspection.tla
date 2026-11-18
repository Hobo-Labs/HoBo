------------------------- MODULE YardSagaInspection --------------------------
EXTENDS Naturals
CONSTANTS CheckInspect, CheckSnapshot
VARIABLES phase, decision, providerPlan, recordedPlan, read, approvedAtRead
vars == <<phase, decision, providerPlan, recordedPlan, read, approvedAtRead>>
Current == /\ decision = "allow" /\ recordedPlan = "original"
Init == /\ phase = "started" /\ decision = "allow"
        /\ providerPlan = "original" /\ recordedPlan = "original"
        /\ read = FALSE /\ approvedAtRead = FALSE
Revoke == /\ decision = "allow" /\ decision' = "deny"
          /\ UNCHANGED <<phase, providerPlan, recordedPlan, read, approvedAtRead>>
Restore == /\ decision = "deny" /\ decision' = "allow"
           /\ UNCHANGED <<phase, providerPlan, recordedPlan, read, approvedAtRead>>
ProviderEdit == /\ providerPlan = "original"
                /\ providerPlan' = "changed"
                /\ recordedPlan' = IF CheckSnapshot THEN recordedPlan ELSE "changed"
                /\ UNCHANGED <<phase, decision, read, approvedAtRead>>
Finish == /\ phase = "started" /\ phase' = "ready"
          /\ UNCHANGED <<decision, providerPlan, recordedPlan, read, approvedAtRead>>
Inspect == /\ ~read
           /\ read' = (Current \/ ~CheckInspect)
           /\ approvedAtRead' = Current
           /\ UNCHANGED <<phase, decision, providerPlan, recordedPlan>>
Done == /\ UNCHANGED vars
Next == Revoke \/ Restore \/ ProviderEdit \/ Finish \/ Inspect \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"started", "ready"} /\ decision \in {"allow", "deny"}
          /\ providerPlan \in {"original", "changed"} /\ recordedPlan \in {"original", "changed"}
          /\ read \in BOOLEAN /\ approvedAtRead \in BOOLEAN
ReadAuthorized == read => approvedAtRead
RecordedPlanPreserved == recordedPlan = "original"
=============================================================================
