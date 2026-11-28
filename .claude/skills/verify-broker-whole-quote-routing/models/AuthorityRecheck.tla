--------------------------- MODULE AuthorityRecheck ---------------------------
EXTENDS Naturals
CONSTANTS CheckReceipt, CheckDelivery
VARIABLES current, phase, receiptCurrent, dispatchCurrent
vars == <<current, phase, receiptCurrent, dispatchCurrent>>
Init == /\ current = TRUE /\ phase = "resolving"
        /\ receiptCurrent = TRUE /\ dispatchCurrent = TRUE
Revoke == /\ current /\ phase \in {"resolving", "ready"}
          /\ current' = FALSE /\ UNCHANGED <<phase, receiptCurrent, dispatchCurrent>>
Issue == /\ phase = "resolving" /\ (current \/ ~CheckReceipt)
         /\ receiptCurrent' = current /\ phase' = "ready"
         /\ UNCHANGED <<current, dispatchCurrent>>
RefuseReceipt == /\ phase = "resolving" /\ ~current /\ CheckReceipt
                 /\ phase' = "rejected" /\ UNCHANGED <<current, receiptCurrent, dispatchCurrent>>
Dispatch == /\ phase = "ready" /\ (current \/ ~CheckDelivery)
            /\ dispatchCurrent' = current /\ phase' = "dispatched"
            /\ UNCHANGED <<current, receiptCurrent>>
RefuseDelivery == /\ phase = "ready" /\ ~current /\ CheckDelivery
                  /\ phase' = "rejected" /\ UNCHANGED <<current, receiptCurrent, dispatchCurrent>>
Done == /\ phase \in {"rejected", "dispatched"} /\ UNCHANGED vars
Next == Revoke \/ Issue \/ RefuseReceipt \/ Dispatch \/ RefuseDelivery \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ current \in BOOLEAN /\ receiptCurrent \in BOOLEAN /\ dispatchCurrent \in BOOLEAN
          /\ phase \in {"resolving", "ready", "rejected", "dispatched"}
ReceiptCurrent == receiptCurrent
DispatchCurrent == dispatchCurrent
=============================================================================
