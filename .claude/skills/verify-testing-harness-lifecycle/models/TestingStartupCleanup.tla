------------------------- MODULE TestingStartupCleanup -------------------------
EXTENDS Naturals
CONSTANTS CleanupOpened, FenceFailedCleanup
VARIABLES phase, oldOpen, failedOnce, replacementStarted
vars == <<phase, oldOpen, failedOnce, replacementStarted>>
Init == /\ phase = "starting" /\ oldOpen = FALSE
        /\ failedOnce = FALSE /\ replacementStarted = FALSE
OpenListener == /\ phase = "starting" /\ phase' = "opened" /\ oldOpen' = TRUE
                /\ UNCHANGED <<failedOnce, replacementStarted>>
StartupFails == /\ phase = "opened"
                /\ phase' = IF CleanupOpened THEN "cleaning" ELSE "clean"
                /\ UNCHANGED <<oldOpen, failedOnce, replacementStarted>>
CleanupFails == /\ phase = "cleaning" /\ ~failedOnce
                /\ phase' = "blocked" /\ failedOnce' = TRUE
                /\ UNCHANGED <<oldOpen, replacementStarted>>
RetryCleanup == /\ phase = "blocked" /\ phase' = "cleaning"
                /\ UNCHANGED <<oldOpen, failedOnce, replacementStarted>>
CleanupSucceeds == /\ phase = "cleaning" /\ phase' = "clean" /\ oldOpen' = FALSE
                   /\ UNCHANGED <<failedOnce, replacementStarted>>
Redeploy == /\ (phase = "clean" \/ (phase = "blocked" /\ ~FenceFailedCleanup))
            /\ phase' = "redeployed" /\ replacementStarted' = TRUE
            /\ UNCHANGED <<oldOpen, failedOnce>>
Wait == UNCHANGED vars
Next == OpenListener \/ StartupFails \/ CleanupFails \/ RetryCleanup \/ CleanupSucceeds \/ Redeploy \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"starting", "opened", "cleaning", "blocked", "clean", "redeployed"}
          /\ oldOpen \in BOOLEAN /\ failedOnce \in BOOLEAN /\ replacementStarted \in BOOLEAN
NoLeakedCleanFailure == phase # "clean" \/ ~oldOpen
NoOverlappingListener == ~replacementStarted \/ ~oldOpen
=============================================================================
