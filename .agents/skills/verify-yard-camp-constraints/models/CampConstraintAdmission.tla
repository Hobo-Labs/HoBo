---------------------- MODULE CampConstraintAdmission ----------------------
EXTENDS Naturals
CONSTANTS CheckQuote, CheckDeploy
VARIABLES hard, nested, path, phase, quoted, authorized, held, providerCalled
vars == <<hard, nested, path, phase, quoted, authorized, held, providerCalled>>
Unsupported == hard \/ nested
Init == /\ hard \in BOOLEAN /\ nested \in BOOLEAN /\ path \in {"quote", "deploy"}
        /\ phase = "received" /\ quoted = FALSE /\ authorized = FALSE
        /\ held = FALSE /\ providerCalled = FALSE
Validate == /\ phase = "received"
            /\ phase' = IF Unsupported /\ (IF path = "quote" THEN CheckQuote ELSE CheckDeploy)
                        THEN "refused" ELSE "checked"
            /\ UNCHANGED <<hard, nested, path, quoted, authorized, held, providerCalled>>
Quote == /\ phase = "checked" /\ path = "quote" /\ phase' = "done" /\ quoted' = TRUE
         /\ UNCHANGED <<hard, nested, path, authorized, held, providerCalled>>
Authorize == /\ phase = "checked" /\ path = "deploy" /\ phase' = "authorized" /\ authorized' = TRUE
             /\ UNCHANGED <<hard, nested, path, quoted, held, providerCalled>>
Hold == /\ phase = "authorized" /\ phase' = "held" /\ held' = TRUE
        /\ UNCHANGED <<hard, nested, path, quoted, authorized, providerCalled>>
Call == /\ phase = "held" /\ phase' = "done" /\ providerCalled' = TRUE
        /\ UNCHANGED <<hard, nested, path, quoted, authorized, held>>
Done == /\ phase \in {"refused", "done"} /\ UNCHANGED vars
Next == Validate \/ Quote \/ Authorize \/ Hold \/ Call \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ hard \in BOOLEAN /\ nested \in BOOLEAN /\ path \in {"quote", "deploy"}
          /\ phase \in {"received", "refused", "checked", "authorized", "held", "done"}
          /\ quoted \in BOOLEAN /\ authorized \in BOOLEAN /\ held \in BOOLEAN /\ providerCalled \in BOOLEAN
NoUnsupportedQuote == quoted => ~Unsupported
NoUnsupportedAuthorization == authorized => ~Unsupported
NoUnsupportedFunding == held => ~Unsupported
NoUnsupportedProvider == providerCalled => ~Unsupported
ValidNotRefused == phase = "refused" => Unsupported
ProviderFunded == providerCalled => held
=============================================================================
