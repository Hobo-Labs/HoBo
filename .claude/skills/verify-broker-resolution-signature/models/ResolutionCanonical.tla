-------------------------- MODULE ResolutionCanonical ----------------------
EXTENDS Naturals
CONSTANT StableOrdering
VARIABLES signingLocale, verifyingLocale, phase, accepted
vars == <<signingLocale, verifyingLocale, phase, accepted>>
Locales == {"first", "second"}
Init == /\ signingLocale \in Locales /\ verifyingLocale \in Locales /\ phase = "pending" /\ accepted = FALSE
Encoding(locale) == IF StableOrdering THEN "stable" ELSE locale
Verify == /\ phase = "pending" /\ phase' = "checked"
          /\ accepted' = (Encoding(signingLocale) = Encoding(verifyingLocale))
          /\ UNCHANGED <<signingLocale, verifyingLocale>>
Done == /\ phase = "checked" /\ UNCHANGED vars
Next == Verify \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ signingLocale \in Locales /\ verifyingLocale \in Locales
          /\ phase \in {"pending", "checked"} /\ accepted \in BOOLEAN
SameDocumentVerifies == phase = "checked" => accepted
=============================================================================
