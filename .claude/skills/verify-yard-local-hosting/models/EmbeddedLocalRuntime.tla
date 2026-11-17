------------------------ MODULE EmbeddedLocalRuntime --------------------------
EXTENDS Naturals
CONSTANTS CheckDerived, CheckDeclared, CheckDerivedDuring, CheckDeclaredDuring,
          CheckDerivedHandoff, CheckDeclaredHandoff
VARIABLES derivedLocal, declaredLocal, derivedDuring, declaredDuring,
          derivedHandoff, declaredHandoff, phase, host
facts == <<derivedLocal, declaredLocal, derivedDuring, declaredDuring, derivedHandoff, declaredHandoff>>
vars == <<facts, phase, host>>
Init == /\ derivedLocal \in BOOLEAN /\ declaredLocal \in BOOLEAN
        /\ derivedDuring \in BOOLEAN /\ declaredDuring \in BOOLEAN
        /\ derivedHandoff \in BOOLEAN /\ declaredHandoff \in BOOLEAN
        /\ phase = "policy" /\ host = "none"
Authorize == /\ phase = "policy"
             /\ phase' = IF (derivedLocal \/ ~CheckDerived) /\ (declaredLocal \/ ~CheckDeclared)
                           /\ (derivedDuring \/ ~CheckDerivedDuring) /\ (declaredDuring \/ ~CheckDeclaredDuring)
                          THEN "approved" ELSE "rejected"
             /\ UNCHANGED <<facts, host>>
Handoff == /\ phase = "approved"
           /\ phase' = IF (derivedHandoff \/ ~CheckDerivedHandoff) /\ (declaredHandoff \/ ~CheckDeclaredHandoff)
                        THEN "resolved" ELSE "rejected"
           /\ host' = IF phase' = "resolved" THEN IF derivedLocal THEN "local" ELSE "other" ELSE "none"
           /\ UNCHANGED facts
Done == /\ phase \in {"resolved", "rejected"} /\ UNCHANGED vars
Next == Authorize \/ Handoff \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ derivedLocal \in BOOLEAN /\ declaredLocal \in BOOLEAN
          /\ derivedDuring \in BOOLEAN /\ declaredDuring \in BOOLEAN
          /\ derivedHandoff \in BOOLEAN /\ declaredHandoff \in BOOLEAN
          /\ phase \in {"policy", "approved", "resolved", "rejected"} /\ host \in {"none", "local", "other"}
LocalHostOnly == phase = "resolved" => host = "local"
LocalRequirementsOnly == phase = "resolved" => derivedLocal /\ declaredLocal
StableDerivedDuring == phase = "resolved" => derivedDuring
StableDeclaredDuring == phase = "resolved" => declaredDuring
StableDerivedAtHandoff == phase = "resolved" => derivedHandoff
StableDeclaredAtHandoff == phase = "resolved" => declaredHandoff
=============================================================================
