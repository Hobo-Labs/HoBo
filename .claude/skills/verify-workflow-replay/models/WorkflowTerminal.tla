------------------------- MODULE WorkflowTerminal -------------------------
EXTENDS Naturals
VARIABLES phase, calls, terminalCalls, terminalFacts, savedOutcome, returnedOutcome, resumes
vars == <<phase, calls, terminalCalls, terminalFacts, savedOutcome, returnedOutcome, resumes>>

Init == /\ phase = "running" /\ calls = 0 /\ terminalCalls = 0
        /\ terminalFacts = 0 /\ savedOutcome = "none" /\ returnedOutcome = "none"
        /\ resumes = 0

Run == /\ phase = "running" /\ calls < 2 /\ calls' = calls + 1
       /\ UNCHANGED <<phase, terminalCalls, terminalFacts, savedOutcome, returnedOutcome, resumes>>

Finish == \E outcome \in {"completed", "failed"}:
          /\ phase = "running" /\ calls > 0 /\ phase' = outcome
          /\ savedOutcome' = outcome /\ terminalCalls' = calls /\ terminalFacts' = 1
          /\ UNCHANGED <<calls, returnedOutcome, resumes>>

Resume == /\ phase \in {"completed", "failed"} /\ resumes < 2
          /\ resumes' = resumes + 1 /\ returnedOutcome' = savedOutcome
          /\ UNCHANGED <<phase, calls, terminalCalls, terminalFacts, savedOutcome>>

Done == /\ phase \in {"completed", "failed"} /\ resumes = 2 /\ UNCHANGED vars
Next == Run \/ Finish \/ Resume \/ Done
Spec == Init /\ [][Next]_vars
NoTerminalRerun == phase \in {"completed", "failed"} => calls = terminalCalls
NoDuplicateTerminalFact == phase \in {"completed", "failed"} => terminalFacts = 1
ResumeReturnsRecorded == resumes > 0 => returnedOutcome = savedOutcome
TypeOK == /\ phase \in {"running", "completed", "failed"}
          /\ calls \in 0..2 /\ terminalCalls \in 0..2 /\ terminalFacts \in 0..2
          /\ savedOutcome \in {"none", "completed", "failed"}
          /\ returnedOutcome \in {"none", "completed", "failed"} /\ resumes \in 0..2
=============================================================================
