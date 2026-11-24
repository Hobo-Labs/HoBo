--------------------- MODULE StrictGithubAssignment ---------------------
VARIABLES scope, identity, groupLabels, unique, current, complete, phase, accepted
vars == <<scope, identity, groupLabels, unique, current, complete, phase, accepted>>
Init == /\ scope \in BOOLEAN /\ identity \in BOOLEAN /\ groupLabels \in BOOLEAN
        /\ unique \in BOOLEAN /\ current \in BOOLEAN /\ complete \in BOOLEAN
        /\ phase = "observed" /\ accepted = FALSE
Verify == /\ phase = "observed" /\ phase' = "decided"
          /\ accepted' = (scope /\ identity /\ groupLabels /\ unique /\ current /\ complete)
          /\ UNCHANGED <<scope, identity, groupLabels, unique, current, complete>>
Done == /\ phase = "decided" /\ UNCHANGED vars
Next == Verify \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ scope \in BOOLEAN /\ identity \in BOOLEAN /\ groupLabels \in BOOLEAN
          /\ unique \in BOOLEAN /\ current \in BOOLEAN /\ complete \in BOOLEAN
          /\ phase \in {"observed", "decided"} /\ accepted \in BOOLEAN
TrustedScope == accepted => scope
MatchingIdentity == accepted => identity
MatchingGroupLabels == accepted => groupLabels
UniqueAssignment == accepted => unique
CurrentEvidence == accepted => current
CompleteScan == accepted => complete
=============================================================================
