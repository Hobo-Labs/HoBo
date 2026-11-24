--------------------------- MODULE StartFenceRace ---------------------------
VARIABLES phase, assigned, live, receipt, assignmentAtIssue, liveAtIssue
vars == <<phase, assigned, live, receipt, assignmentAtIssue, liveAtIssue>>
Init == /\ phase = "assignment-read" /\ assigned = TRUE /\ live = TRUE /\ receipt = FALSE
        /\ assignmentAtIssue = FALSE /\ liveAtIssue = FALSE
ReadAssignment == /\ phase = "assignment-read"
                  /\ phase' = IF assigned THEN "claim-read" ELSE "uncertain"
                  /\ UNCHANGED <<assigned, live, receipt, assignmentAtIssue, liveAtIssue>>
ReadClaim == /\ phase = "claim-read"
             /\ phase' = IF live THEN "response" ELSE "uncertain"
             /\ UNCHANGED <<assigned, live, receipt, assignmentAtIssue, liveAtIssue>>
Issue == /\ phase = "response" /\ phase' = "issued" /\ receipt' = TRUE
         /\ assignmentAtIssue' = assigned /\ liveAtIssue' = live
         /\ UNCHANGED <<assigned, live>>
AssignmentChanges == /\ assigned /\ assigned' = FALSE
                     /\ UNCHANGED <<phase, live, receipt, assignmentAtIssue, liveAtIssue>>
ClaimSettles == /\ live /\ live' = FALSE
                /\ UNCHANGED <<phase, assigned, receipt, assignmentAtIssue, liveAtIssue>>
Done == /\ phase \in {"issued", "uncertain"} /\ UNCHANGED vars
Next == ReadAssignment \/ ReadClaim \/ Issue \/ AssignmentChanges \/ ClaimSettles \/ Done
Spec == Init /\ [][Next]_vars
StillAssignedAtReceipt == receipt => assignmentAtIssue
StillLiveAtReceipt == receipt => liveAtIssue
=============================================================================
