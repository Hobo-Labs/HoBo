--------------------------- MODULE TrainingSelection ---------------------------
EXTENDS Integers
CONSTANTS ValidateRewards, ValidateBeforeTrace, KeepBest, StrictTies, ReportBest
Scores == {0, 1, 2}
VARIABLES valid, phase, iteration, best, selected, expectedBest, expectedSelected, traces, winner, winnerIndex
vars == <<valid, phase, iteration, best, selected, expectedBest, expectedSelected, traces, winner, winnerIndex>>
Init == /\ valid \in BOOLEAN /\ phase = "new" /\ iteration = 0
        /\ best = -1 /\ selected = -1 /\ expectedBest = -1 /\ expectedSelected = -1
        /\ traces = 0 /\ winner = -1 /\ winnerIndex = -1
Start == /\ phase = "new"
         /\ phase' = IF valid \/ ~ValidateRewards THEN "running" ELSE "refused"
         /\ traces' = IF ~valid /\ ~ValidateBeforeTrace THEN 1 ELSE traces
         /\ UNCHANGED <<valid, iteration, best, selected, expectedBest, expectedSelected, winner, winnerIndex>>
Step(score) == /\ phase = "running" /\ iteration < 3 /\ score \in Scores
               /\ best' = IF best = -1 \/ score > best \/ ~KeepBest THEN score ELSE best
               /\ selected' = IF best = -1 \/ score > best \/ (~StrictTies /\ score = best) \/ ~KeepBest THEN iteration ELSE selected
               /\ expectedBest' = IF score > expectedBest THEN score ELSE expectedBest
               /\ expectedSelected' = IF score > expectedBest THEN iteration ELSE expectedSelected
               /\ iteration' = iteration + 1 /\ traces' = traces + 1
               /\ UNCHANGED <<valid, phase, winner, winnerIndex>>
AnyStep == \E score \in Scores : Step(score)
Finish == /\ phase = "running" /\ iteration = 3 /\ phase' = "done"
          /\ winner' = IF ReportBest THEN best ELSE 0
          /\ winnerIndex' = IF ReportBest THEN selected ELSE 0
          /\ UNCHANGED <<valid, iteration, best, selected, expectedBest, expectedSelected, traces>>
Wait == UNCHANGED vars
Next == Start \/ AnyStep \/ Finish \/ Wait
Spec == Init /\ [][Next]_vars /\ WF_vars(AnyStep) /\ WF_vars(Finish)
TypeOK == /\ valid \in BOOLEAN /\ phase \in {"new", "running", "refused", "done"}
          /\ iteration \in 0..3 /\ traces \in 0..3
          /\ best \in {-1, 0, 1, 2} /\ expectedBest \in {-1, 0, 1, 2}
          /\ selected \in {-1, 0, 1, 2} /\ expectedSelected \in {-1, 0, 1, 2}
          /\ winner \in {-1, 0, 1, 2} /\ winnerIndex \in {-1, 0, 1, 2}
InvalidRewardRefused == valid \/ phase \notin {"running", "done"}
NoTraceForInvalid == valid \/ traces = 0
BestCorrect == best = expectedBest /\ selected = expectedSelected
WinnerCorrect == phase # "done" \/ (winner = expectedBest /\ winnerIndex = expectedSelected)
Terminates == (phase = "running") ~> (phase = "done")
=============================================================================
