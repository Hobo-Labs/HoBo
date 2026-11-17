--------------------------- MODULE QuoteProvenance --------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES mode, valid, attested, mutated, trustedEstimate, phase
vars == <<mode, valid, attested, mutated, trustedEstimate, phase>>
Init == /\ mode \in {"quote", "legacy"} /\ valid \in BOOLEAN /\ attested \in BOOLEAN
        /\ mutated \in BOOLEAN /\ trustedEstimate \in BOOLEAN /\ phase = "pending"
Allowed == valid /\ IF mode = "quote"
                     THEN (IF Current THEN attested /\ ~mutated ELSE TRUE)
                     ELSE (IF Current THEN trustedEstimate ELSE TRUE)
Approve == /\ phase = "pending" /\ Allowed /\ phase' = "approved"
           /\ UNCHANGED <<mode, valid, attested, mutated, trustedEstimate>>
Refuse == /\ phase = "pending" /\ ~Allowed /\ phase' = "refused"
          /\ UNCHANGED <<mode, valid, attested, mutated, trustedEstimate>>
Done == /\ phase \in {"approved", "refused"} /\ UNCHANGED vars
Next == Approve \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"quote", "legacy"} /\ valid \in BOOLEAN /\ attested \in BOOLEAN
          /\ mutated \in BOOLEAN /\ trustedEstimate \in BOOLEAN /\ phase \in {"pending", "approved", "refused"}
OnlyAttestedQuote == phase = "approved" /\ mode = "quote" => attested
QuoteUnchanged == phase = "approved" /\ mode = "quote" => ~mutated
LegacyExplicitTrust == phase = "approved" /\ mode = "legacy" => trustedEstimate
ValidOnly == phase = "approved" => valid
=============================================================================
