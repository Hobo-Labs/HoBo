--------------------------- MODULE YardSagaReturn ----------------------------
EXTENDS Naturals
CONSTANTS CheckDelivery, CheckSnapshot, CheckRetain
VARIABLES phase, approval, providerPlan, deliveryPlan, cached, delivered, leaked, lastOutcome
vars == <<phase, approval, providerPlan, deliveryPlan, cached, delivered, leaked, lastOutcome>>
Waiters == {"first", "retry"}
Current == approval /\ deliveryPlan = "original"
Init == /\ phase = "pending" /\ approval = TRUE
        /\ providerPlan = "original" /\ deliveryPlan = "original"
        /\ cached = "started" /\ delivered = {} /\ leaked = FALSE /\ lastOutcome = "none"
Revoke == /\ approval /\ approval' = FALSE
          /\ UNCHANGED <<phase, providerPlan, deliveryPlan, cached, delivered, leaked, lastOutcome>>
Restore == /\ ~approval /\ approval' = TRUE
           /\ UNCHANGED <<phase, providerPlan, deliveryPlan, cached, delivered, leaked, lastOutcome>>
ProviderEdit == /\ phase = "pending" /\ providerPlan = "original"
                /\ providerPlan' = "changed"
                /\ deliveryPlan' = IF CheckSnapshot THEN deliveryPlan ELSE "changed"
                /\ UNCHANGED <<phase, approval, cached, delivered, leaked, lastOutcome>>
Complete == /\ phase = "pending" /\ phase' = "success"
            /\ cached' = IF CheckRetain THEN "ready" ELSE "started"
            /\ UNCHANGED <<approval, providerPlan, deliveryPlan, delivered, leaked, lastOutcome>>
ProviderError == /\ phase = "pending" /\ phase' = "error"
                 /\ cached' = "started"
                 /\ UNCHANGED <<approval, providerPlan, deliveryPlan, delivered, leaked, lastOutcome>>
Deliver(w) == /\ phase \in {"success", "error"} /\ w \in Waiters \ delivered
              /\ delivered' = delivered \cup {w}
              /\ leaked' = (leaked \/ (~Current /\ ~CheckDelivery))
              /\ lastOutcome' = IF Current \/ ~CheckDelivery THEN "returned" ELSE "refused"
              /\ UNCHANGED <<phase, approval, providerPlan, deliveryPlan, cached>>
DeliverFirst == Deliver("first")
DeliverRetry == Deliver("retry")
Done == /\ phase \in {"success", "error"} /\ UNCHANGED vars
Next == Revoke \/ Restore \/ ProviderEdit \/ Complete \/ ProviderError \/ DeliverFirst \/ DeliverRetry \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"pending", "success", "error"} /\ approval \in BOOLEAN
          /\ providerPlan \in {"original", "changed"} /\ deliveryPlan \in {"original", "changed"}
          /\ cached \in {"started", "ready"} /\ delivered \subseteq Waiters /\ leaked \in BOOLEAN
          /\ lastOutcome \in {"none", "returned", "refused"}
NoUnauthorizedDelivery == ~leaked
DeliveryPlanPreserved == deliveryPlan = "original"
SuccessfulResultRetained == phase = "success" => cached = "ready"
=============================================================================
