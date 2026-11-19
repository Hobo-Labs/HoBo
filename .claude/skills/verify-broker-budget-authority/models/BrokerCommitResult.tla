----------------------- MODULE BrokerCommitResult -----------------------
CONSTANTS RejectAmbiguous, FenceUncertain, FenceThrown
VARIABLES kind, phase, durable, acknowledged, used
vars == <<kind, phase, durable, acknowledged, used>>

Init == /\ kind \in {"primitive-durable", "object-durable", "object-pending",
                     "throw-durable", "throw-pending"}
        /\ phase = "ready" /\ durable = FALSE
        /\ acknowledged = FALSE /\ used = FALSE

Commit == /\ phase = "ready"
          /\ IF kind = "primitive-durable"
                THEN /\ phase' = "accepted" /\ durable' = TRUE
                     /\ acknowledged' = TRUE
                ELSE IF kind \in {"throw-durable", "throw-pending"}
                        THEN /\ phase' = IF FenceThrown THEN "uncertain" ELSE "failed"
                             /\ durable' = (kind = "throw-durable")
                             /\ acknowledged' = FALSE
                        ELSE IF RejectAmbiguous
                                THEN /\ phase' = "uncertain"
                                     /\ durable' = (kind = "object-durable")
                                     /\ acknowledged' = FALSE
                                ELSE /\ phase' = "accepted"
                                     /\ durable' = (kind = "object-durable")
                                     /\ acknowledged' = TRUE
          /\ UNCHANGED <<kind, used>>

Reuse == /\ phase \in {"uncertain", "failed"}
         /\ IF phase = "uncertain" /\ FenceUncertain
               THEN UNCHANGED used ELSE used' = TRUE
         /\ UNCHANGED <<kind, phase, durable, acknowledged>>

CompletePending == /\ phase # "ready" /\ ~durable
                   /\ kind \in {"object-pending", "throw-pending"}
                   /\ durable' = TRUE
                   /\ UNCHANGED <<kind, phase, acknowledged, used>>

Done == UNCHANGED vars
Next == Commit \/ Reuse \/ CompletePending \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in {"primitive-durable", "object-durable", "object-pending",
                       "throw-durable", "throw-pending"}
          /\ phase \in {"ready", "accepted", "uncertain", "failed"}
          /\ durable \in BOOLEAN /\ acknowledged \in BOOLEAN /\ used \in BOOLEAN
NoPrematureAcknowledgement == acknowledged => durable
NoUseAfterAmbiguousCommit == phase = "uncertain" => ~used
NoUseAfterThrownCommit == kind \in {"throw-durable", "throw-pending"}
                          /\ phase # "ready" => ~used
=============================================================================
