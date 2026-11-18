-------------------------- MODULE YardRequestWire --------------------------
EXTENDS Naturals

\* Finite request classes supplied to decodeBindleDeploymentRequest.
\* Rebound has a changed request and a recomputed matching digest: the codec
\* accepts it because its embedded digest is not an authentication mechanism.
CONSTANTS CheckUnknown, CheckVersion, CheckAmount, CheckIdentity,
          CheckCanonical, CheckDigest
Cases == {"valid", "rebound", "bad-binary", "unknown", "legacy", "incomplete",
          "negative", "bad-mode", "empty-identity", "bad-digest", "noncanonical", "mismatch"}
VARIABLES requestCase, phase
vars == <<requestCase, phase>>

Init == /\ requestCase \in Cases /\ phase = "binary"
Decode == /\ phase = "binary"
          /\ phase' = IF requestCase = "bad-binary" THEN "refused" ELSE "unknown"
          /\ UNCHANGED requestCase
InspectUnknown == /\ phase = "unknown"
                  /\ phase' = IF requestCase = "unknown" /\ CheckUnknown THEN "refused" ELSE "version"
                  /\ UNCHANGED requestCase
InspectVersion == /\ phase = "version"
                  /\ phase' = IF requestCase = "legacy" /\ CheckVersion THEN "refused" ELSE "envelope"
                  /\ UNCHANGED requestCase
InspectEnvelope == /\ phase = "envelope"
                   /\ phase' = IF requestCase = "incomplete" THEN "refused" ELSE "amount"
                   /\ UNCHANGED requestCase
InspectAmount == /\ phase = "amount"
                 /\ phase' = IF requestCase = "negative" /\ CheckAmount THEN "refused" ELSE "selection"
                 /\ UNCHANGED requestCase
InspectSelection == /\ phase = "selection"
                    /\ phase' = IF requestCase = "bad-mode" THEN "refused" ELSE "identity"
                    /\ UNCHANGED requestCase
InspectIdentity == /\ phase = "identity"
                   /\ phase' = IF requestCase = "empty-identity" /\ CheckIdentity THEN "refused" ELSE "digest-format"
                   /\ UNCHANGED requestCase
InspectDigestFormat == /\ phase = "digest-format"
                       /\ phase' = IF requestCase = "bad-digest" THEN "refused" ELSE "compare"
                       /\ UNCHANGED requestCase
Compare == /\ phase = "compare"
           /\ phase' = IF (requestCase = "noncanonical" /\ CheckCanonical) \/
                          (requestCase = "mismatch" /\ CheckDigest)
                       THEN "refused" ELSE "accepted"
           /\ UNCHANGED requestCase
Done == /\ phase \in {"refused", "accepted"} /\ UNCHANGED vars
Next == Decode \/ InspectUnknown \/ InspectVersion \/ InspectEnvelope \/ InspectAmount \/
        InspectSelection \/ InspectIdentity \/ InspectDigestFormat \/ Compare \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ requestCase \in Cases
          /\ phase \in {"binary", "unknown", "version", "envelope", "amount", "selection",
                       "identity", "digest-format", "compare", "refused", "accepted"}
NoUnknown == phase = "accepted" => requestCase # "unknown"
NoLegacy == phase = "accepted" => requestCase # "legacy"
NoInvalidEnvelope == phase = "accepted" => requestCase \notin {"bad-binary", "incomplete", "bad-mode", "bad-digest"}
NoNegative == phase = "accepted" => requestCase # "negative"
NoEmptyIdentity == phase = "accepted" => requestCase # "empty-identity"
Canonical == phase = "accepted" => requestCase # "noncanonical"
MatchingDigest == phase = "accepted" => requestCase # "mismatch"
CompleteAccepted == phase = "refused" => requestCase \notin {"valid", "rebound"}
=============================================================================
