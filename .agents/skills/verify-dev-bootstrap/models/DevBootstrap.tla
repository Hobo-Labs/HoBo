------------------------- MODULE DevBootstrap -------------------------
EXTENDS Naturals
CONSTANTS MaxAttempts, CheckPath, RespectOverride, HonorFailure, VerifyOutput
VARIABLES mode, initialTarget, initialSystem, present, attempts, phase, selected, status
vars == <<mode, initialTarget, initialSystem, present, attempts, phase, selected, status>>

Init == /\ mode \in {"default", "override", "invalid"}
        /\ initialTarget \in BOOLEAN /\ initialSystem \in BOOLEAN
        /\ present = initialTarget /\ attempts = 0 /\ phase = "choosing"
        /\ selected = "none" /\ status = "none"

Resolve == /\ phase = "choosing"
           /\ IF mode = "invalid" /\ CheckPath
                 THEN /\ phase' = "rejected" /\ selected' = "none"
                 ELSE IF initialTarget
                         THEN /\ phase' = "ready" /\ selected' = "target"
                         ELSE IF initialSystem /\ (mode = "default" \/ ~RespectOverride)
                                 THEN /\ phase' = "ready" /\ selected' = "system"
                                 ELSE /\ phase' = "installing" /\ selected' = "none"
           /\ UNCHANGED <<mode, initialTarget, initialSystem, present, attempts, status>>

InstallFailure == /\ phase = "installing" /\ attempts < MaxAttempts
                  /\ attempts' = attempts + 1 /\ present' \in BOOLEAN /\ status' = "failed"
                  /\ phase' = IF attempts + 1 = MaxAttempts
                                 THEN IF HonorFailure THEN "failed" ELSE "ready"
                                 ELSE "installing"
                  /\ selected' = IF attempts + 1 = MaxAttempts /\ ~HonorFailure THEN "target" ELSE "none"
                  /\ UNCHANGED <<mode, initialTarget, initialSystem>>

InstallSuccess == /\ phase = "installing" /\ attempts < MaxAttempts
                  /\ attempts' = attempts + 1 /\ present' \in BOOLEAN /\ status' = "success"
                  /\ phase' = "checking" /\ UNCHANGED <<mode, initialTarget, initialSystem, selected>>

CheckOutput == /\ phase = "checking"
               /\ IF present \/ ~VerifyOutput
                     THEN /\ phase' = "ready" /\ selected' = "target"
                     ELSE /\ phase' = "failed" /\ selected' = "none"
               /\ UNCHANGED <<mode, initialTarget, initialSystem, present, attempts, status>>

Done == UNCHANGED vars
Next == Resolve \/ InstallFailure \/ InstallSuccess \/ CheckOutput \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ mode \in {"default", "override", "invalid"}
          /\ initialTarget \in BOOLEAN /\ initialSystem \in BOOLEAN /\ present \in BOOLEAN
          /\ attempts \in 0..MaxAttempts /\ phase \in {"choosing", "rejected", "installing", "checking", "ready", "failed"}
          /\ selected \in {"none", "target", "system"} /\ status \in {"none", "failed", "success"}
NoInvalidUse == mode = "invalid" => (attempts = 0 /\ selected = "none")
NoOverrideFallback == mode = "override" => selected # "system"
NoReadyAfterFailure == phase = "ready" /\ attempts > 0 => status = "success"
NoReadyWithoutExecutable == phase = "ready" => ((selected = "target" /\ present) \/ (selected = "system" /\ initialSystem))
NoRedundantInstall == mode # "invalid" /\ (initialTarget \/ (mode = "default" /\ initialSystem)) => attempts = 0
=============================================================================
