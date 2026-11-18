------------------------- MODULE TestingStartupCleanup -------------------------
EXTENDS Naturals
CONSTANTS CleanupOpened, FenceFailedCleanup, ProtectRetry
VARIABLES phase, oldOpen, failedOnce, replacementStarted, tampered
vars == <<phase, oldOpen, failedOnce, replacementStarted, tampered>>
Init == /\ phase = "starting" /\ oldOpen = FALSE /\ tampered = FALSE
        /\ failedOnce = FALSE /\ replacementStarted = FALSE
OpenListener == /\ phase = "starting" /\ phase' = "opened" /\ oldOpen' = TRUE
                /\ UNCHANGED <<failedOnce, replacementStarted, tampered>>
StartupFails == /\ phase = "opened"
                /\ phase' = IF CleanupOpened THEN "cleaning" ELSE "clean"
                /\ UNCHANGED <<oldOpen, failedOnce, replacementStarted, tampered>>
CleanupFails == /\ phase = "cleaning" /\ ~failedOnce
                /\ phase' = "blocked" /\ failedOnce' = TRUE
                /\ UNCHANGED <<oldOpen, replacementStarted, tampered>>
Tamper == /\ phase = "blocked" /\ ~tampered /\ tampered' = ~ProtectRetry
          /\ UNCHANGED <<phase, oldOpen, failedOnce, replacementStarted>>
RetryCleanup == /\ phase = "blocked"
                /\ phase' = IF tampered THEN "clean" ELSE "cleaning"
                /\ UNCHANGED <<oldOpen, failedOnce, replacementStarted, tampered>>
CleanupSucceeds == /\ phase = "cleaning" /\ phase' = "clean" /\ oldOpen' = FALSE
                   /\ UNCHANGED <<failedOnce, replacementStarted, tampered>>
Redeploy == /\ (phase = "clean" \/ (phase = "blocked" /\ ~FenceFailedCleanup))
            /\ phase' = "redeployed" /\ replacementStarted' = TRUE
            /\ UNCHANGED <<oldOpen, failedOnce, tampered>>
Wait == UNCHANGED vars
Next == OpenListener \/ StartupFails \/ CleanupFails \/ Tamper \/ RetryCleanup \/ CleanupSucceeds \/ Redeploy \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"starting", "opened", "cleaning", "blocked", "clean", "redeployed"}
          /\ oldOpen \in BOOLEAN /\ failedOnce \in BOOLEAN /\ replacementStarted \in BOOLEAN /\ tampered \in BOOLEAN
NoLeakedCleanFailure == phase # "clean" \/ ~oldOpen
NoOverlappingListener == ~replacementStarted \/ ~oldOpen
RetryProtected == ~tampered
=============================================================================
