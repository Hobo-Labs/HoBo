-------------------------- MODULE LocalBudgetFallback -------------------------
EXTENDS Naturals
CONSTANTS CheckEarly, CheckFallback, CheckStart, CheckPreview
VARIABLES budgetRequired, remote, yardWired, preview, beganBudgeted, phase
facts == <<remote, yardWired, preview>>
vars == <<budgetRequired, facts, beganBudgeted, phase>>
Init == /\ budgetRequired \in BOOLEAN /\ remote \in BOOLEAN /\ yardWired \in BOOLEAN
        /\ preview \in BOOLEAN /\ beganBudgeted = FALSE /\ phase = "start"
Choose == /\ phase = "start"
          /\ phase' = IF budgetRequired /\ (remote \/ ~yardWired) /\ CheckEarly
                       THEN "rejected" ELSE IF remote THEN "remote" ELSE IF yardWired THEN "yard" ELSE "fallback"
          /\ UNCHANGED <<budgetRequired, facts, beganBudgeted>>
YardStub == /\ phase = "yard" /\ phase' = "fallback" /\ UNCHANGED <<budgetRequired, facts, beganBudgeted>>
YardReturns == /\ phase = "yard" /\ phase' = "yard-result" /\ UNCHANGED <<budgetRequired, facts, beganBudgeted>>
BeginFallback == /\ phase = "fallback"
                 /\ phase' = IF budgetRequired /\ CheckFallback THEN "rejected"
                              ELSE IF preview THEN "preview-pending" ELSE "preparing"
                 /\ beganBudgeted' = (budgetRequired /\ ~(budgetRequired /\ CheckFallback))
                 /\ UNCHANGED <<budgetRequired, facts>>
Start == /\ phase = "preparing"
         /\ phase' = IF budgetRequired /\ CheckStart THEN "rejected" ELSE "local-start"
         /\ UNCHANGED <<budgetRequired, facts, beganBudgeted>>
ReturnPreview == /\ phase = "preview-pending"
                 /\ phase' = IF budgetRequired /\ CheckPreview THEN "rejected" ELSE "preview"
                 /\ UNCHANGED <<budgetRequired, facts, beganBudgeted>>
BudgetArrives == /\ phase \in {"yard", "fallback", "preparing", "preview-pending"}
                 /\ ~budgetRequired /\ budgetRequired' = TRUE /\ UNCHANGED <<facts, beganBudgeted, phase>>
Done == /\ phase \in {"rejected", "remote", "yard-result", "preview", "local-start"} /\ UNCHANGED vars
Next == Choose \/ YardStub \/ YardReturns \/ BeginFallback \/ Start \/ ReturnPreview \/ BudgetArrives \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ budgetRequired \in BOOLEAN /\ remote \in BOOLEAN /\ yardWired \in BOOLEAN
          /\ preview \in BOOLEAN /\ beganBudgeted \in BOOLEAN
          /\ phase \in {"start", "yard", "fallback", "preparing", "preview-pending", "rejected", "remote", "yard-result", "preview", "local-start"}
NoBudgetedFallback == ~beganBudgeted
NoUnfundedLocalStart == phase = "local-start" => ~budgetRequired
NoUnfundedPreview == phase = "preview" => ~budgetRequired
NoUnfundedRemote == phase = "remote" => ~budgetRequired
=============================================================================
