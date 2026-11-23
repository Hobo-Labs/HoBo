-------------------------- MODULE YardRequestWire --------------------------
EXTENDS Naturals

\* Finite request classes supplied to decodeBindleDeploymentRequest.
\* Rebound has a changed request and a recomputed matching digest: the codec
\* accepts it because its embedded digest is not an authentication mechanism.
CONSTANTS CheckUnknown, CheckAmount, CheckParsedAmount, CheckParsedResidency, CheckIdentity,
          CheckLabels, CheckPropertyText, CheckCanonical, CheckDigest
Cases == {"valid", "rebound", "bad-binary", "unknown",
          "incomplete", "negative", "bad-mode", "empty-identity", "bad-digest",
          "missing-properties", "duplicate-label",
          "noncanonical-property-text", "invalid-residency", "noncanonical", "mismatch"}
VARIABLES requestCase, phase
vars == <<requestCase, phase>>

Init == /\ requestCase \in Cases /\ phase = "binary"
Decode == /\ phase = "binary"
          /\ phase' = IF requestCase = "bad-binary" THEN "refused" ELSE "unknown"
          /\ UNCHANGED requestCase
InspectUnknown == /\ phase = "unknown"
                  /\ phase' = IF requestCase = "unknown" /\ CheckUnknown THEN "refused" ELSE "envelope"
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
                       /\ phase' = IF requestCase = "bad-digest" THEN "refused" ELSE "parse-domain"
                       /\ UNCHANGED requestCase
ParseDomain == /\ phase = "parse-domain"
               /\ phase' = IF (requestCase = "negative" /\ CheckParsedAmount) \/
                              requestCase = "missing-properties" \/
                              (requestCase = "duplicate-label" /\ CheckLabels) \/
                              (requestCase = "noncanonical-property-text" /\ CheckPropertyText) \/
                              (requestCase = "invalid-residency" /\ CheckParsedResidency)
                           THEN "refused" ELSE "compare"
               /\ UNCHANGED requestCase
Compare == /\ phase = "compare"
           /\ phase' = IF (requestCase = "noncanonical" /\ CheckCanonical) \/
                          (requestCase = "mismatch" /\ CheckDigest)
                       THEN "refused" ELSE "accepted"
           /\ UNCHANGED requestCase
Done == /\ phase \in {"refused", "accepted"} /\ UNCHANGED vars
Next == Decode \/ InspectUnknown \/ InspectEnvelope \/ InspectAmount \/
        InspectSelection \/ InspectIdentity \/ InspectDigestFormat \/ ParseDomain \/ Compare \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ requestCase \in Cases
          /\ phase \in {"binary", "unknown", "envelope", "amount", "selection",
                       "identity", "digest-format", "parse-domain", "compare", "refused", "accepted"}
NoUnknown == phase = "accepted" => requestCase # "unknown"
NoInvalidEnvelope == phase = "accepted" => requestCase \notin {"bad-binary", "incomplete", "bad-mode", "bad-digest", "missing-properties"}
NoNegative == phase = "accepted" => requestCase # "negative"
NoEmptyIdentity == phase = "accepted" => requestCase # "empty-identity"
NoDuplicateLabels == phase = "accepted" => requestCase # "duplicate-label"
CanonicalPropertyText == phase = "accepted" => requestCase # "noncanonical-property-text"
ValidResidency == phase = "accepted" => requestCase # "invalid-residency"
Canonical == phase = "accepted" => requestCase # "noncanonical"
MatchingDigest == phase = "accepted" => requestCase # "mismatch"
CompleteAccepted == phase = "refused" => requestCase \notin {"valid", "rebound"}
=============================================================================
