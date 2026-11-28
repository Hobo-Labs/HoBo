----------------------------- MODULE BrokerDelivery -------------------------
EXTENDS Naturals
CONSTANTS CheckOrigin, CheckFreshness, CheckContext, ClaimOnce
VARIABLES phase, fresh, context, authentic, observedFresh, observedContext, dispatches
vars == <<phase, fresh, context, authentic, observedFresh, observedContext, dispatches>>
Init == /\ phase = "ready" /\ fresh = TRUE /\ context = TRUE
        /\ authentic = FALSE /\ observedFresh = FALSE /\ observedContext = FALSE
        /\ dispatches = 0
Start == /\ phase = "ready" /\ dispatches < 2
         /\ \E candidate \in BOOLEAN:
              /\ candidate \/ ~CheckOrigin
              /\ phase' = "validating" /\ authentic' = candidate
         /\ UNCHANGED <<fresh, context, observedFresh, observedContext, dispatches>>
CanDispatch == /\ (IF CheckFreshness THEN fresh ELSE TRUE)
               /\ (IF CheckContext THEN context ELSE TRUE)
Dispatch == /\ phase = "validating" /\ CanDispatch /\ dispatches < 2
            /\ phase' = "submitting" /\ dispatches' = dispatches + 1
            /\ observedFresh' = fresh /\ observedContext' = context
            /\ UNCHANGED <<fresh, context, authentic>>
Decline == /\ phase = "validating" /\ ~CanDispatch /\ phase' = "ready"
           /\ UNCHANGED <<fresh, context, authentic, observedFresh, observedContext, dispatches>>
Succeed == /\ phase = "submitting" /\ phase' = "done"
           /\ UNCHANGED <<fresh, context, authentic, observedFresh, observedContext, dispatches>>
Uncertain == /\ phase = "submitting" /\ phase' = "uncertain"
             /\ UNCHANGED <<fresh, context, authentic, observedFresh, observedContext, dispatches>>
RetryUnsafe == /\ ~ClaimOnce /\ phase \in {"done", "uncertain"} /\ dispatches < 2
               /\ phase' = "ready"
               /\ UNCHANGED <<fresh, context, authentic, observedFresh, observedContext, dispatches>>
Expire == /\ fresh /\ fresh' = FALSE
          /\ UNCHANGED <<phase, context, authentic, observedFresh, observedContext, dispatches>>
Revoke == /\ context /\ context' = FALSE
          /\ UNCHANGED <<phase, fresh, authentic, observedFresh, observedContext, dispatches>>
Done == /\ phase \in {"done", "uncertain"} /\ UNCHANGED vars
Next == Start \/ Dispatch \/ Decline \/ Succeed \/ Uncertain \/ RetryUnsafe \/ Expire \/ Revoke \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "validating", "submitting", "done", "uncertain"}
          /\ fresh \in BOOLEAN /\ context \in BOOLEAN /\ authentic \in BOOLEAN
          /\ observedFresh \in BOOLEAN /\ observedContext \in BOOLEAN /\ dispatches \in 0..2
AtMostOnce == dispatches <= 1
AuthenticDispatch == dispatches > 0 => authentic
FreshAtDispatch == dispatches > 0 => observedFresh
ContextAtDispatch == dispatches > 0 => observedContext
NoReopenAfterDispatch == dispatches > 0 => phase # "ready"
=============================================================================
