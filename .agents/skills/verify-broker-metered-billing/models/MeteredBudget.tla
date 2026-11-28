-------------------------- MODULE MeteredBudget --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Requests, Budget, MaxSpent, InitialSpends, Amounts
VARIABLES phase, amount, issued, spent, evidenceGood, overrun, outside, badAdmission
vars == <<phase, amount, issued, spent, evidenceGood, overrun, outside, badAdmission>>
RECURSIVE SumHeld(_)
SumHeld(rs) == IF rs = {} THEN 0
               ELSE LET r == CHOOSE x \in rs : TRUE IN amount[r] + SumHeld(rs \ {r})
Held == SumHeld({r \in Requests : phase[r] \in {"pending", "held"}})
Init == /\ phase = [r \in Requests |-> "new"]
        /\ amount = [r \in Requests |-> 0]
        /\ issued = [r \in Requests |-> 0]
        /\ spent \in InitialSpends
        /\ evidenceGood = TRUE /\ overrun = FALSE /\ outside = FALSE
        /\ badAdmission = FALSE
Reserve == \E r \in Requests, n \in Amounts:
           /\ phase[r] = "new" /\ evidenceGood /\ spent + Held + n <= Budget
           /\ phase' = [phase EXCEPT ![r] = "pending"]
           /\ amount' = [amount EXCEPT ![r] = n]
           /\ badAdmission' = (badAdmission \/ ~evidenceGood \/ spent + Held + n > Budget)
           /\ UNCHANGED <<issued, spent, evidenceGood, overrun, outside>>
PlacementSuccess == \E r \in Requests:
                    /\ phase[r] = "pending"
                    /\ phase' = [phase EXCEPT ![r] = "held"]
                    /\ issued' = [issued EXCEPT ![r] = @ + 1]
                    /\ UNCHANGED <<amount, spent, evidenceGood, overrun, outside, badAdmission>>
PlacementFailure == \E r \in Requests:
                    /\ phase[r] = "pending"
                    /\ phase' = [phase EXCEPT ![r] = "new"]
                    /\ amount' = [amount EXCEPT ![r] = 0]
                    /\ UNCHANGED <<issued, spent, evidenceGood, overrun, outside, badAdmission>>
Replay == /\ \E r \in Requests : phase[r] = "held"
          /\ UNCHANGED vars
Finalize == \E r \in Requests, actual \in Amounts:
            /\ phase[r] = "held" /\ evidenceGood /\ spent + actual <= MaxSpent
            /\ phase' = [phase EXCEPT ![r] = "finalized"]
            /\ spent' = spent + actual
            /\ overrun' = (overrun \/ actual > amount[r])
            /\ UNCHANGED <<amount, issued, evidenceGood, outside, badAdmission>>
OutsideCharge == /\ spent < MaxSpent
                 /\ spent' = spent + 1 /\ outside' = TRUE
                 /\ UNCHANGED <<phase, amount, issued, evidenceGood, overrun, badAdmission>>
BadEvidence == /\ evidenceGood /\ evidenceGood' = FALSE
               /\ UNCHANGED <<phase, amount, issued, spent, overrun, outside, badAdmission>>
RestoreEvidence == /\ ~evidenceGood /\ evidenceGood' = TRUE
                   /\ UNCHANGED <<phase, amount, issued, spent, overrun, outside, badAdmission>>
Wait == UNCHANGED vars
Next == Reserve \/ PlacementSuccess \/ PlacementFailure \/ Replay \/ Finalize \/ OutsideCharge \/ BadEvidence \/ RestoreEvidence \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in [Requests -> {"new", "pending", "held", "finalized"}]
          /\ amount \in [Requests -> (Amounts \cup {0})]
          /\ issued \in [Requests -> {0, 1, 2}]
          /\ spent \in 0..MaxSpent
          /\ evidenceGood \in BOOLEAN /\ overrun \in BOOLEAN /\ outside \in BOOLEAN
          /\ badAdmission \in BOOLEAN
SafeAdmission == ~badAdmission
BudgetSafeUntilOutsideOrOverrun == (~outside /\ ~overrun) => spent + Held <= Budget
OneReceipt == \A r \in Requests : issued[r] <= 1
IssuedRetainsHold == \A r \in Requests : issued[r] = 1 => phase[r] \in {"held", "finalized"}
FinalizedWasIssued == \A r \in Requests : phase[r] = "finalized" => issued[r] = 1
=============================================================================
