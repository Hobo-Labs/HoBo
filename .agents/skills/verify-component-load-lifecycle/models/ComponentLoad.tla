----------------------------- MODULE ComponentLoad -----------------------------
CONSTANTS GuardLoaded, GuardLoading, CheckIdentity, CaptureLeases, ReleaseClaim
VARIABLES phase, claim, mismatch, changed, captured, installedId, installedLease,
          reentered, duplicateTried, overlap, retrying
vars == <<phase, claim, mismatch, changed, captured, installedId, installedLease,
          reentered, duplicateTried, overlap, retrying>>

Init == /\ phase = "missing" /\ claim = FALSE /\ mismatch \in BOOLEAN
        /\ changed = FALSE /\ captured = "none" /\ installedId = "none"
        /\ installedLease = "none" /\ reentered = FALSE
        /\ duplicateTried = FALSE /\ overlap = FALSE /\ retrying = FALSE
Begin == /\ phase = "missing" /\ phase' = "loading" /\ claim' = TRUE
         /\ captured' = "original"
         /\ UNCHANGED <<mismatch, changed, installedId, installedLease,
                         reentered, duplicateTried, overlap, retrying>>
Edit == /\ phase = "loading" /\ ~changed /\ changed' = TRUE
        /\ UNCHANGED <<phase, claim, mismatch, captured, installedId,
                        installedLease, reentered, duplicateTried, overlap, retrying>>
Reenter == /\ phase = "loading" /\ ~reentered /\ reentered' = TRUE
           /\ overlap' = (overlap \/ ~GuardLoading)
           /\ UNCHANGED <<phase, claim, mismatch, changed, captured, installedId,
                           installedLease, duplicateTried, retrying>>
Finish == /\ phase = "loading"
          /\ phase' = IF mismatch /\ CheckIdentity THEN "failed" ELSE "loaded"
          /\ claim' = FALSE
          /\ installedId' = IF mismatch /\ ~CheckIdentity THEN "other" ELSE "requested"
          /\ installedLease' = IF CaptureLeases \/ ~changed THEN captured ELSE "changed"
          /\ UNCHANGED <<mismatch, changed, captured, reentered, duplicateTried, overlap, retrying>>
Fail == /\ phase = "loading" /\ phase' = "failed" /\ claim' = ~ReleaseClaim
        /\ UNCHANGED <<mismatch, changed, captured, installedId, installedLease,
                        reentered, duplicateTried, overlap, retrying>>
Retry == /\ phase = "failed" /\ ~claim /\ ~retrying
         /\ phase' = "loading" /\ claim' = TRUE /\ retrying' = TRUE
         /\ UNCHANGED <<mismatch, changed, captured, installedId, installedLease,
                         reentered, duplicateTried, overlap>>
Duplicate == /\ phase = "loaded" /\ ~duplicateTried /\ duplicateTried' = TRUE
             /\ overlap' = (overlap \/ ~GuardLoaded)
             /\ UNCHANGED <<phase, claim, mismatch, changed, captured, installedId,
                             installedLease, reentered, retrying>>
Teardown == /\ phase = "loaded" /\ phase' = "torn-down"
            /\ UNCHANGED <<claim, mismatch, changed, captured, installedId,
                            installedLease, reentered, duplicateTried, overlap, retrying>>
Done == /\ phase \in {"failed", "torn-down"} /\ UNCHANGED vars
Next == Begin \/ Edit \/ Reenter \/ Finish \/ Fail \/ Retry \/ Duplicate \/ Teardown \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"missing", "loading", "loaded", "failed", "torn-down"}
          /\ claim \in BOOLEAN /\ mismatch \in BOOLEAN /\ changed \in BOOLEAN
          /\ captured \in {"none", "original"}
          /\ installedId \in {"none", "requested", "other"}
          /\ installedLease \in {"none", "original", "changed"}
          /\ reentered \in BOOLEAN /\ duplicateTried \in BOOLEAN
          /\ overlap \in BOOLEAN /\ retrying \in BOOLEAN
Exclusive == ~overlap
CorrectIdentity == phase = "loaded" => installedId = "requested"
CapturedLeases == phase = "loaded" => installedLease = "original"
FailureReleased == phase = "failed" => ~claim
=============================================================================
