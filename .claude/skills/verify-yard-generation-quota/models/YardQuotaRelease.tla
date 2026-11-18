-------------------------- MODULE YardQuotaRelease ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS CheckCancelFence, CheckTombstone, CheckOnce
VARIABLES phase, winners, called, cancelledEver, reused
vars == <<phase, winners, called, cancelledEver, reused>>
Workers == {"first", "retry"}
Init == /\ phase = "pending" /\ winners = {} /\ called = {}
        /\ cancelledEver = FALSE /\ reused = FALSE
Claim(w) == /\ phase = "pending" /\ w \in Workers
            /\ phase' = "claimed" /\ winners' = {w}
            /\ UNCHANGED <<called, cancelledEver, reused>>
DuplicateClaim(w) == /\ phase = "claimed" /\ ~CheckOnce /\ w \in Workers \ winners
                     /\ winners' = winners \cup {w}
                     /\ UNCHANGED <<phase, called, cancelledEver, reused>>
ClaimFirst == Claim("first") \/ DuplicateClaim("first")
ClaimRetry == Claim("retry") \/ DuplicateClaim("retry")
Cancel == /\ (phase = "pending" \/ (~CheckCancelFence /\ phase = "claimed"))
          /\ phase' = "cancelled" /\ cancelledEver' = TRUE
          /\ UNCHANGED <<winners, called, reused>>
Reuse == /\ phase = "cancelled" /\ ~CheckTombstone
         /\ phase' = "pending" /\ winners' = {} /\ reused' = TRUE
         /\ UNCHANGED <<called, cancelledEver>>
Call(w) == /\ phase = "claimed" /\ w \in winners \ called
           /\ called' = called \cup {w}
           /\ UNCHANGED <<phase, winners, cancelledEver, reused>>
CallFirst == Call("first")
CallRetry == Call("retry")
Ready == /\ phase = "claimed" /\ called # {} /\ phase' = "ready"
         /\ UNCHANGED <<winners, called, cancelledEver, reused>>
Done == /\ phase \in {"ready", "cancelled"} /\ UNCHANGED vars
Next == ClaimFirst \/ ClaimRetry \/ Cancel \/ Reuse \/ CallFirst \/ CallRetry \/ Ready \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"pending", "claimed", "cancelled", "ready"}
          /\ winners \subseteq Workers /\ called \subseteq Workers
          /\ cancelledEver \in BOOLEAN /\ reused \in BOOLEAN
NoClaimedCancellation == ~(phase = "cancelled" /\ winners # {})
NoCancelledKeyReuse == ~reused
AtMostOneProviderCall == Cardinality(called) <= 1
=============================================================================
