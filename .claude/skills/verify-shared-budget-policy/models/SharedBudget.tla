--------------------------- MODULE SharedBudget ---------------------------
VARIABLES phase, scopeOK, windowOK, costFits, metricsOK, strict, native, planning
vars == <<phase, scopeOK, windowOK, costFits, metricsOK, strict, native, planning>>
Init == /\ phase = "checking"
        /\ scopeOK \in BOOLEAN /\ windowOK \in BOOLEAN /\ costFits \in BOOLEAN
        /\ metricsOK \in BOOLEAN /\ strict \in BOOLEAN /\ native \in BOOLEAN /\ planning \in BOOLEAN
Evaluate ==
  /\ phase = "checking"
  /\ phase' = IF ~scopeOK \/ ~windowOK \/ ~costFits \/ ~metricsOK \/ (strict /\ ~native /\ ~planning)
              THEN "denied"
              ELSE IF strict /\ ~native THEN "plan-needs-proof" ELSE "feasible"
  /\ UNCHANGED <<scopeOK, windowOK, costFits, metricsOK, strict, native, planning>>
Done == /\ phase \in {"denied", "plan-needs-proof", "feasible"} /\ UNCHANGED vars
Next == Evaluate \/ Done
Spec == Init /\ [][Next]_vars
ScopeMatches == phase \in {"feasible", "plan-needs-proof"} => scopeOK
BudgetFits == phase \in {"feasible", "plan-needs-proof"} => costFits
WindowAndMetrics == phase \in {"feasible", "plan-needs-proof"} => windowOK /\ metricsOK
StrictAdmissionNeedsNative == (phase = "feasible" /\ strict /\ ~planning) => native
DeferredNativeEvidence == phase = "plan-needs-proof" => (strict /\ ~native /\ planning)
TypeOK == /\ phase \in {"checking", "denied", "plan-needs-proof", "feasible"}
          /\ scopeOK \in BOOLEAN /\ windowOK \in BOOLEAN /\ costFits \in BOOLEAN
          /\ metricsOK \in BOOLEAN /\ strict \in BOOLEAN /\ native \in BOOLEAN /\ planning \in BOOLEAN
=============================================================================
