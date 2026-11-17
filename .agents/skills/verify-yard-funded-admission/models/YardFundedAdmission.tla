------------------------ MODULE YardFundedAdmission --------------------------
EXTENDS Naturals
CONSTANTS CheckSelection, CheckGateQuote, CheckGateContext, CheckHoldQuote,
          CheckHoldContext, CheckFreshness, CheckFinal, KeepHold
VARIABLES selection, gateQuote, gateContext, holdQuote, holdContext, fresh, finalContext,
          phase, committed, held
facts == <<selection, gateQuote, gateContext, holdQuote, holdContext, fresh, finalContext>>
vars == <<selection, gateQuote, gateContext, holdQuote, holdContext, fresh, finalContext, phase, committed, held>>
Init == /\ selection \in BOOLEAN /\ gateQuote \in BOOLEAN /\ gateContext \in BOOLEAN
        /\ holdQuote \in BOOLEAN /\ holdContext \in BOOLEAN /\ fresh \in BOOLEAN /\ finalContext \in BOOLEAN
        /\ phase = "policy" /\ committed = FALSE /\ held = FALSE
PreOK == /\ (IF CheckSelection THEN selection ELSE TRUE)
         /\ (IF CheckGateQuote THEN gateQuote ELSE TRUE)
         /\ (IF CheckGateContext THEN gateContext ELSE TRUE)
PostOK == /\ (IF CheckHoldQuote THEN holdQuote ELSE TRUE)
          /\ (IF CheckHoldContext THEN holdContext ELSE TRUE)
          /\ (IF CheckFreshness THEN fresh ELSE TRUE)
Policy == /\ phase = "policy" /\ phase' = IF PreOK THEN "reserving" ELSE "rejected"
          /\ UNCHANGED <<facts, committed, held>>
Reserve == /\ phase = "reserving" /\ committed' = TRUE
           /\ phase' = IF PostOK THEN "admitted" ELSE "rejected"
           /\ held' = (PostOK \/ KeepHold)
           /\ UNCHANGED facts
Finalize == /\ phase = "admitted"
            /\ phase' = IF finalContext \/ ~CheckFinal THEN "resolved" ELSE "rejected"
            /\ UNCHANGED <<facts, committed, held>>
Done == /\ phase \in {"resolved", "rejected"} /\ UNCHANGED vars
Next == Policy \/ Reserve \/ Finalize \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ selection \in BOOLEAN /\ gateQuote \in BOOLEAN /\ gateContext \in BOOLEAN
          /\ holdQuote \in BOOLEAN /\ holdContext \in BOOLEAN /\ fresh \in BOOLEAN /\ finalContext \in BOOLEAN
          /\ committed \in BOOLEAN /\ held \in BOOLEAN
          /\ phase \in {"policy", "reserving", "admitted", "resolved", "rejected"}
SelectedWork == phase = "resolved" => selection
QuoteBeforeHold == phase = "resolved" => gateQuote
ContextBeforeHold == phase = "resolved" => gateContext
QuoteAfterHold == phase = "resolved" => holdQuote
ContextAfterHold == phase = "resolved" => holdContext
FreshAtReceipt == phase = "resolved" => fresh
FinalContext == phase = "resolved" => finalContext
HoldRetained == committed => held
=============================================================================
