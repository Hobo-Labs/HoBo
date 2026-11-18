--------------------- MODULE YardGenerationEvidence ----------------------
EXTENDS Naturals
CONSTANTS CheckAttestation, CheckLocks
VARIABLES attestation, locks, phase, authorized, held, providerCalled
vars == <<attestation, locks, phase, authorized, held, providerCalled>>
Init == /\ attestation \in {"required", "not-required", "invalid"}
        /\ locks \in {"present", "none", "invalid"}
        /\ phase = "received" /\ authorized = FALSE /\ held = FALSE /\ providerCalled = FALSE
Decide == /\ phase = "received"
          /\ phase' = IF attestation # "not-required" /\ CheckAttestation
                      THEN "attestation-refused"
                      ELSE IF locks # "none" /\ CheckLocks
                           THEN "locks-refused" ELSE "planned"
          /\ UNCHANGED <<attestation, locks, authorized, held, providerCalled>>
Authorize == /\ phase = "planned" /\ phase' = "authorized" /\ authorized' = TRUE
             /\ UNCHANGED <<attestation, locks, held, providerCalled>>
Hold == /\ phase = "authorized" /\ phase' = "held" /\ held' = TRUE
        /\ UNCHANGED <<attestation, locks, authorized, providerCalled>>
Call == /\ phase = "held" /\ phase' = "called" /\ providerCalled' = TRUE
        /\ UNCHANGED <<attestation, locks, authorized, held>>
Done == /\ phase \in {"attestation-refused", "locks-refused", "called"} /\ UNCHANGED vars
Next == Decide \/ Authorize \/ Hold \/ Call \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ attestation \in {"required", "not-required", "invalid"}
          /\ locks \in {"present", "none", "invalid"}
          /\ phase \in {"received", "attestation-refused", "locks-refused", "planned", "authorized", "held", "called"}
          /\ authorized \in BOOLEAN /\ held \in BOOLEAN /\ providerCalled \in BOOLEAN
NoUnsafePlan == phase \in {"planned", "authorized", "held", "called"} => attestation = "not-required" /\ locks = "none"
NoUnsafeEffect == (authorized \/ held \/ providerCalled) => attestation = "not-required" /\ locks = "none"
ValidNotRefused == phase \in {"attestation-refused", "locks-refused"} => attestation # "not-required" \/ locks # "none"
ProviderFunded == providerCalled => held
=============================================================================
