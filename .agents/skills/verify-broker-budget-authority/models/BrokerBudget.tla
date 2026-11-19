------------------------- MODULE BrokerBudget -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Requests
VARIABLES phase, claimed, evidence, unusedEvidence, usage, badAdmission
vars == <<phase, claimed, evidence, unusedEvidence, usage, badAdmission>>
Held == Cardinality({r \in Requests : phase[r] \in {"held", "uncertain"}})
RECURSIVE SumUsage(_)
SumUsage(rs) == IF rs = {} THEN 0
                ELSE LET r == CHOOSE x \in rs : TRUE IN usage[r] + SumUsage(rs \ {r})
Spent == SumUsage({r \in Requests : phase[r] = "settled"})
Overrun == \E r \in Requests : phase[r] = "settled" /\ usage[r] > 1
Init == /\ phase = [r \in Requests |-> "new"]
        /\ claimed = [r \in Requests |-> FALSE]
        /\ evidence = [r \in Requests |-> FALSE]
        /\ unusedEvidence = [r \in Requests |-> FALSE]
        /\ usage = [r \in Requests |-> 0] /\ badAdmission = FALSE
Reserve == \E r \in Requests:
           /\ phase[r] = "new"
           /\ Spent + Held + 1 <= 1
           /\ phase' = [phase EXCEPT ![r] = "held"]
           /\ UNCHANGED <<claimed, evidence, unusedEvidence, usage, badAdmission>>
Settle == \E r \in Requests, amount \in {0, 1, 2}:
          /\ phase[r] \in {"held", "uncertain"} /\ claimed[r] /\ evidence[r]
          /\ phase' = [phase EXCEPT ![r] = "settled"]
          /\ usage' = [usage EXCEPT ![r] = amount]
          /\ UNCHANGED <<claimed, evidence, unusedEvidence, badAdmission>>
Claim == \E r \in Requests:
         /\ phase[r] \in {"held", "uncertain"} /\ ~claimed[r] /\ ~unusedEvidence[r]
         /\ claimed' = [claimed EXCEPT ![r] = TRUE]
         /\ UNCHANGED <<phase, evidence, unusedEvidence, usage, badAdmission>>
Uncertain == \E r \in Requests:
             /\ phase[r] = "held"
             /\ phase' = [phase EXCEPT ![r] = "uncertain"]
             /\ UNCHANGED <<claimed, evidence, unusedEvidence, usage, badAdmission>>
ObserveFinal == \E r \in Requests:
                /\ phase[r] \in {"held", "uncertain"} /\ ~evidence[r] /\ ~unusedEvidence[r]
                /\ evidence' = [evidence EXCEPT ![r] = TRUE]
                /\ UNCHANGED <<phase, claimed, unusedEvidence, usage, badAdmission>>
ObserveUnused == \E r \in Requests:
                 /\ phase[r] \in {"held", "uncertain"} /\ ~unusedEvidence[r] /\ ~evidence[r] /\ ~claimed[r]
                 /\ unusedEvidence' = [unusedEvidence EXCEPT ![r] = TRUE]
                 /\ UNCHANGED <<phase, claimed, evidence, usage, badAdmission>>
Release == \E r \in Requests:
           /\ ((phase[r] = "held") \/ (phase[r] = "uncertain" /\ unusedEvidence[r]))
           /\ ~claimed[r] /\ unusedEvidence[r] /\ ~evidence[r]
           /\ phase' = [phase EXCEPT ![r] = "released"]
           /\ UNCHANGED <<claimed, evidence, unusedEvidence, usage, badAdmission>>
Done == /\ \A r \in Requests : phase[r] \notin {"held", "uncertain"}
        /\ (Spent >= 1 \/ \A r \in Requests : phase[r] # "new")
        /\ UNCHANGED vars
Next == Reserve \/ Claim \/ Uncertain \/ ObserveFinal \/ ObserveUnused \/ Release \/ Settle \/ Done
Spec == Init /\ [][Next]_vars
NoUnfundedAdmission == ~badAdmission
BudgetSafeUntilProviderOverrun == ~Overrun => Held + Spent <= 1
ClaimRetainsHold == \A r \in Requests : claimed[r] /\ phase[r] # "settled" => phase[r] \in {"held", "uncertain"}
SettlementNeedsEvidence == \A r \in Requests : phase[r] = "settled" => evidence[r]
ReleaseNeedsEvidence == \A r \in Requests : phase[r] = "released" => unusedEvidence[r] /\ ~claimed[r] /\ ~evidence[r]
TypeOK == /\ phase \in [Requests -> {"new", "held", "uncertain", "released", "settled"}]
          /\ claimed \in [Requests -> BOOLEAN] /\ evidence \in [Requests -> BOOLEAN]
          /\ unusedEvidence \in [Requests -> BOOLEAN]
          /\ usage \in [Requests -> {0, 1, 2}] /\ badAdmission \in BOOLEAN
=============================================================================
