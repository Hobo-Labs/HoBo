--------------------------- MODULE YardSignalBatch -------------------------
EXTENDS Naturals
CONSTANTS CheckRaw, CheckNormalized, CheckAllowed, Snapshot, BrokerSequence, AtomicBatch
VARIABLES rawValid, normalizedValid, allowedType, mutated, suppliedSeq,
          phase, rawMismatch, invalidNormalized, brokerDecision, foreignSeq, partial
vars == <<rawValid, normalizedValid, allowedType, mutated, suppliedSeq,
          phase, rawMismatch, invalidNormalized, brokerDecision, foreignSeq, partial>>
Init == /\ rawValid \in BOOLEAN /\ normalizedValid \in BOOLEAN /\ allowedType \in BOOLEAN
        /\ mutated \in BOOLEAN /\ suppliedSeq \in BOOLEAN /\ phase = "received"
        /\ rawMismatch = FALSE /\ invalidNormalized = FALSE /\ brokerDecision = FALSE
        /\ foreignSeq = FALSE /\ partial = FALSE
Validate == /\ phase = "received"
            /\ IF (~rawValid /\ CheckRaw) \/ (~normalizedValid /\ CheckNormalized) \/ (~allowedType /\ CheckAllowed)
               THEN /\ phase' = "refused" /\ partial' = ~AtomicBatch
               ELSE /\ phase' = "pending" /\ UNCHANGED partial
            /\ UNCHANGED <<rawValid, normalizedValid, allowedType, mutated, suppliedSeq,
                           rawMismatch, invalidNormalized, brokerDecision, foreignSeq>>
Append == /\ phase = "pending" /\ phase' = "folded"
          /\ rawMismatch' = ~rawValid
          /\ invalidNormalized' = (~normalizedValid \/ (mutated /\ ~Snapshot))
          /\ brokerDecision' = ~allowedType
          /\ foreignSeq' = (suppliedSeq /\ ~BrokerSequence)
          /\ UNCHANGED <<rawValid, normalizedValid, allowedType, mutated, suppliedSeq, partial>>
Done == /\ phase \in {"refused", "folded"} /\ UNCHANGED vars
Next == Validate \/ Append \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ rawValid \in BOOLEAN /\ normalizedValid \in BOOLEAN /\ allowedType \in BOOLEAN
          /\ mutated \in BOOLEAN /\ suppliedSeq \in BOOLEAN
          /\ phase \in {"received", "pending", "refused", "folded"}
          /\ rawMismatch \in BOOLEAN /\ invalidNormalized \in BOOLEAN /\ brokerDecision \in BOOLEAN
          /\ foreignSeq \in BOOLEAN /\ partial \in BOOLEAN
NoForeignRaw == ~rawMismatch
NoInvalidNormalized == ~invalidNormalized
NoBrokerDecision == ~brokerDecision
BrokerOwnsSequence == ~foreignSeq
NoPartialRefusal == phase = "refused" => ~partial
=============================================================================
