----------------------- MODULE YardSagaAuthorization ------------------------
EXTENDS Naturals
CONSTANTS CheckInitial, CheckBoundary, CheckCached, CheckIsolation
VARIABLES phase, decision, callbackSame, initialApproved, called,
          approvedAtCall, cachedServed, approvedAtCache, retainedEdited, providerWork
vars == <<phase, decision, callbackSame, initialApproved, called,
          approvedAtCall, cachedServed, approvedAtCache, retainedEdited, providerWork>>
Current == decision = "allow" /\ callbackSame
Init == /\ phase = "new" /\ decision \in {"missing", "deny", "allow", "mutate"}
        /\ callbackSame = TRUE /\ initialApproved = FALSE /\ called = FALSE
        /\ approvedAtCall = FALSE /\ cachedServed = FALSE /\ approvedAtCache = FALSE
        /\ retainedEdited = FALSE /\ providerWork = "original"
Review == /\ phase = "new"
          /\ initialApproved' = Current
          /\ phase' = IF Current \/ ~CheckInitial THEN "scheduled" ELSE "denied"
          /\ UNCHANGED <<decision, callbackSame, called, approvedAtCall, cachedServed,
                         approvedAtCache, retainedEdited, providerWork>>
Revoke == /\ phase \in {"scheduled", "ready"} /\ decision = "allow"
          /\ decision' = "deny"
          /\ UNCHANGED <<phase, callbackSame, initialApproved, called, approvedAtCall,
                         cachedServed, approvedAtCache, retainedEdited, providerWork>>
AlterDecision == /\ phase \in {"scheduled", "ready"} /\ decision = "allow"
                 /\ decision' = "mutate"
                 /\ UNCHANGED <<phase, callbackSame, initialApproved, called, approvedAtCall,
                                cachedServed, approvedAtCache, retainedEdited, providerWork>>
ReplaceCallback == /\ phase = "scheduled" /\ callbackSame
                   /\ callbackSame' = FALSE
                   /\ UNCHANGED <<phase, decision, initialApproved, called, approvedAtCall,
                                  cachedServed, approvedAtCache, retainedEdited, providerWork>>
Dispatch == /\ phase = "scheduled"
            /\ phase' = IF Current \/ ~CheckBoundary THEN "ready" ELSE "denied"
            /\ called' = (Current \/ ~CheckBoundary)
            /\ approvedAtCall' = Current
            /\ UNCHANGED <<decision, callbackSame, initialApproved, cachedServed,
                           approvedAtCache, retainedEdited, providerWork>>
RetryCached == /\ phase = "ready" /\ ~cachedServed
               /\ cachedServed' = (Current \/ ~CheckCached)
               /\ approvedAtCache' = Current
               /\ UNCHANGED <<phase, decision, callbackSame, initialApproved, called,
                              approvedAtCall, retainedEdited, providerWork>>
EditRetained == /\ phase = "ready" /\ ~retainedEdited
                /\ retainedEdited' = TRUE
                /\ providerWork' = IF CheckIsolation THEN providerWork ELSE "changed"
                /\ UNCHANGED <<phase, decision, callbackSame, initialApproved, called,
                               approvedAtCall, cachedServed, approvedAtCache>>
Done == /\ phase \in {"ready", "denied"} /\ UNCHANGED vars
Next == Review \/ Revoke \/ AlterDecision \/ ReplaceCallback \/ Dispatch \/ RetryCached \/ EditRetained \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"new", "scheduled", "ready", "denied"}
          /\ decision \in {"missing", "deny", "allow", "mutate"}
          /\ callbackSame \in BOOLEAN /\ initialApproved \in BOOLEAN /\ called \in BOOLEAN
          /\ approvedAtCall \in BOOLEAN /\ cachedServed \in BOOLEAN /\ approvedAtCache \in BOOLEAN
          /\ retainedEdited \in BOOLEAN /\ providerWork \in {"original", "changed"}
InitialAdmissionAuthorized == phase = "scheduled" => initialApproved
ProviderCallAuthorized == called => approvedAtCall
CachedResultAuthorized == cachedServed => approvedAtCache
ProviderPlanIsolated == providerWork = "original"
=============================================================================
