----------------------- MODULE BrokerCommitResult -----------------------
CONSTANTS RejectAmbiguous, FenceUncertain, FenceThrown, SeparateCommitFailure
VARIABLES kind, phase, durable, acknowledged, used, reportedDenial
vars == <<kind, phase, durable, acknowledged, used, reportedDenial>>

Init == /\ kind \in {"primitive-durable", "object-durable", "object-pending",
                     "throw-durable", "throw-pending", "denial-durable", "denial-pending"}
        /\ phase = "ready" /\ durable = FALSE
        /\ acknowledged = FALSE /\ used = FALSE /\ reportedDenial = FALSE

Commit == /\ phase = "ready"
          /\ IF kind = "primitive-durable"
                THEN /\ phase' = "accepted" /\ durable' = TRUE
                     /\ acknowledged' = TRUE
                ELSE IF kind \in {"throw-durable", "throw-pending", "denial-durable", "denial-pending"}
                        THEN /\ phase' = IF FenceThrown THEN "uncertain" ELSE "failed"
                             /\ durable' = (kind \in {"throw-durable", "denial-durable"})
                             /\ acknowledged' = FALSE
                        ELSE IF RejectAmbiguous
                                THEN /\ phase' = "uncertain"
                                     /\ durable' = (kind = "object-durable")
                                     /\ acknowledged' = FALSE
                                ELSE /\ phase' = "accepted"
                                     /\ durable' = (kind = "object-durable")
                                     /\ acknowledged' = TRUE
          /\ reportedDenial' = (kind \in {"denial-durable", "denial-pending"}
                                /\ ~SeparateCommitFailure)
          /\ UNCHANGED <<kind, used>>

Reuse == /\ phase \in {"uncertain", "failed"}
         /\ IF phase = "uncertain" /\ FenceUncertain
               THEN UNCHANGED used ELSE used' = TRUE
         /\ UNCHANGED <<kind, phase, durable, acknowledged, reportedDenial>>

CompletePending == /\ phase # "ready" /\ ~durable
                   /\ kind \in {"object-pending", "throw-pending", "denial-pending"}
                   /\ durable' = TRUE
                   /\ UNCHANGED <<kind, phase, acknowledged, used, reportedDenial>>

Done == UNCHANGED vars
Next == Commit \/ Reuse \/ CompletePending \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in {"primitive-durable", "object-durable", "object-pending",
                       "throw-durable", "throw-pending", "denial-durable", "denial-pending"}
          /\ phase \in {"ready", "accepted", "uncertain", "failed"}
          /\ durable \in BOOLEAN /\ acknowledged \in BOOLEAN /\ used \in BOOLEAN
          /\ reportedDenial \in BOOLEAN
NoPrematureAcknowledgement == acknowledged => durable
NoUseAfterAmbiguousCommit == phase = "uncertain" => ~used
NoUseAfterThrownCommit == kind \in {"throw-durable", "throw-pending", "denial-durable", "denial-pending"}
                          /\ phase # "ready" => ~used
NoCommitFailureAsDenial == kind \in {"denial-durable", "denial-pending"}
                           /\ phase # "ready" => ~reportedDenial
=============================================================================
