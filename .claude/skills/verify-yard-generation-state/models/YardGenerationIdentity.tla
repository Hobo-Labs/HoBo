----------------------- MODULE YardGenerationIdentity ----------------------
EXTENDS Naturals
CONSTANTS CheckPlan, CheckYard, CheckAttempt, RecordUncertain, ReportFailure
VARIABLES exact, planMatches, yardMatches, attemptMatches, writeSucceeds,
          phase, hold, called, receipt, warning
vars == <<exact, planMatches, yardMatches, attemptMatches, writeSucceeds,
          phase, hold, called, receipt, warning>>
Init == /\ exact \in BOOLEAN /\ planMatches \in BOOLEAN
        /\ yardMatches \in BOOLEAN /\ attemptMatches \in BOOLEAN
        /\ writeSucceeds \in BOOLEAN /\ phase = "plan" /\ hold = "none"
        /\ called = FALSE /\ receipt = FALSE /\ warning = FALSE
Plan == /\ phase = "plan"
        /\ phase' = IF exact /\ ~planMatches /\ CheckPlan THEN "refused" ELSE "fund"
        /\ UNCHANGED <<exact, planMatches, yardMatches, attemptMatches, writeSucceeds, hold, called, receipt, warning>>
Fund == /\ phase = "fund" /\ phase' = "provider" /\ hold' = "held"
        /\ UNCHANGED <<exact, planMatches, yardMatches, attemptMatches, writeSucceeds, called, receipt, warning>>
Call == /\ phase = "provider" /\ phase' = "result" /\ called' = TRUE
        /\ UNCHANGED <<exact, planMatches, yardMatches, attemptMatches, writeSucceeds, hold, receipt, warning>>
Result == /\ phase = "result"
          /\ IF (~yardMatches /\ CheckYard) \/ (~attemptMatches /\ CheckAttempt)
             THEN /\ phase' = "reconcile"
                  /\ hold' = IF writeSucceeds /\ RecordUncertain THEN "uncertain" ELSE "held"
                  /\ warning' = (~writeSucceeds /\ ReportFailure)
                  /\ UNCHANGED receipt
             ELSE /\ phase' = "placed" /\ receipt' = TRUE
                  /\ UNCHANGED <<hold, warning>>
          /\ UNCHANGED <<exact, planMatches, yardMatches, attemptMatches, writeSucceeds, called>>
Done == /\ phase \in {"refused", "reconcile", "placed"} /\ UNCHANGED vars
Next == Plan \/ Fund \/ Call \/ Result \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ exact \in BOOLEAN /\ planMatches \in BOOLEAN
          /\ yardMatches \in BOOLEAN /\ attemptMatches \in BOOLEAN /\ writeSucceeds \in BOOLEAN
          /\ phase \in {"plan", "fund", "provider", "result", "refused", "reconcile", "placed"}
          /\ hold \in {"none", "held", "uncertain"} /\ called \in BOOLEAN /\ receipt \in BOOLEAN /\ warning \in BOOLEAN
NoWrongPlanEffect == called /\ exact => planMatches
NoWrongYardReceipt == receipt => yardMatches
NoWrongAttemptReceipt == receipt => attemptMatches
ExposureRetained == phase = "reconcile" => hold \in {"held", "uncertain"}
UncertaintyRecorded == phase = "reconcile" /\ writeSucceeds => hold = "uncertain"
WriteFailureReported == phase = "reconcile" /\ ~writeSucceeds => warning
=============================================================================
