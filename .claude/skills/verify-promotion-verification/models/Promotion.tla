------------------------------ MODULE Promotion ------------------------------
VARIABLES phase, verdict, qualified
vars == <<phase, verdict, qualified>>
Init == /\ phase = "requested" /\ verdict = "pending" /\ qualified = FALSE
Resolve == /\ phase = "requested" /\ phase' = "resolved" /\ UNCHANGED <<verdict, qualified>>
GateAllow == /\ phase = "resolved" /\ phase' = "applying" /\ UNCHANGED <<verdict, qualified>>
GateNeedsApproval == /\ phase = "resolved" /\ phase' = "approval" /\ UNCHANGED <<verdict, qualified>>
Reject == /\ phase \in {"resolved", "approval"} /\ phase' = "rejected" /\ UNCHANGED <<verdict, qualified>>
Approve == /\ phase = "approval" /\ phase' = "applying" /\ UNCHANGED <<verdict, qualified>>
Apply == /\ phase = "applying" /\ phase' = "rollout" /\ UNCHANGED <<verdict, qualified>>
Converge == /\ phase = "rollout" /\ phase' = "verifying" /\ UNCHANGED <<verdict, qualified>>
VerifyPass == /\ phase = "verifying" /\ verdict' = "pass" /\ phase' = "verified"
              /\ UNCHANGED qualified
VerifyFail == /\ phase = "verifying" /\ verdict' = "fail" /\ phase' = "compensating"
              /\ UNCHANGED qualified
Qualify == /\ phase = "verified" /\ verdict = "pass" /\ qualified' = TRUE
           /\ phase' = "qualified" /\ UNCHANGED verdict
Promote == /\ phase = "qualified" /\ phase' = "promoted" /\ UNCHANGED <<verdict, qualified>>
Compensate == /\ phase = "compensating" /\ phase' = "compensated" /\ UNCHANGED <<verdict, qualified>>
Done == /\ phase \in {"rejected", "promoted", "compensated"} /\ UNCHANGED vars
Next == Resolve \/ GateAllow \/ GateNeedsApproval \/ Reject \/ Approve \/ Apply \/ Converge \/ VerifyPass \/ VerifyFail \/ Qualify \/ Promote \/ Compensate \/ Done
Spec == Init /\ [][Next]_vars
QualificationRequiresPass == qualified => verdict = "pass"
TypeOK == /\ phase \in {"requested", "resolved", "applying", "approval", "rejected", "rollout", "verifying", "verified", "compensating", "qualified", "promoted", "compensated"}
          /\ verdict \in {"pending", "pass", "fail"} /\ qualified \in BOOLEAN
=============================================================================
