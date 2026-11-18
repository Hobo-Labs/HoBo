-------------------------- MODULE FuzzCapabilityInput --------------------------
EXTENDS Integers, FiniteSets
CONSTANTS GuardAdd, GuardKeep, CopyInput, IntersectKeep
VARIABLES initial, input, keep, edit, value, replayed, prior, revision, alias, phase
vars == <<initial, input, keep, edit, value, replayed, prior, revision, alias, phase>>
Allowed == {"read", "write"}
All == Allowed \cup {"other"}
Init == /\ initial \in {{}, {"read"}}
        /\ input \in {{"read"}, {"other"}}
        /\ keep \in {{"read"}, {"write"}, {"other"}}
        /\ edit \in {{"write"}, {"other"}}
        /\ value = initial /\ replayed = initial /\ prior = initial
        /\ revision = 0 /\ alias = FALSE /\ phase = "new"
AddRejected == GuardAdd /\ ~(input \subseteq Allowed)
Add == /\ phase = "new"
       /\ phase' = IF AddRejected THEN "add-rejected" ELSE "added"
       /\ value' = IF AddRejected THEN value ELSE input
       /\ replayed' = IF AddRejected THEN replayed ELSE input \cap Allowed
       /\ revision' = IF AddRejected THEN revision ELSE revision + 1
       /\ alias' = IF AddRejected THEN FALSE ELSE ~CopyInput
       /\ UNCHANGED <<initial, input, keep, edit, prior>>
CallerEdit == /\ phase = "added" /\ phase' = "edited"
              /\ value' = IF alias THEN edit ELSE value
              /\ UNCHANGED <<initial, input, keep, edit, replayed, prior, revision, alias>>
KeepRejected == GuardKeep /\ ~(keep \subseteq Allowed)
Kept == IF IntersectKeep THEN value \cap keep ELSE keep
Attenuate == /\ phase = "edited" /\ prior' = value
             /\ phase' = IF KeepRejected THEN "keep-rejected" ELSE "attenuated"
             /\ value' = IF KeepRejected THEN value ELSE Kept
             /\ replayed' = IF KeepRejected THEN replayed ELSE Kept \cap Allowed
             /\ revision' = IF KeepRejected THEN revision ELSE revision + 1
             /\ alias' = FALSE
             /\ UNCHANGED <<initial, input, keep, edit>>
Wait == /\ phase \in {"add-rejected", "keep-rejected", "attenuated"} /\ UNCHANGED vars
Next == Add \/ CallerEdit \/ Attenuate \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ initial \subseteq Allowed /\ input \subseteq All /\ keep \subseteq All
          /\ edit \subseteq All /\ value \subseteq All /\ replayed \subseteq Allowed
          /\ prior \subseteq All /\ revision \in 0..2 /\ alias \in BOOLEAN
          /\ phase \in {"new", "add-rejected", "added", "edited", "keep-rejected", "attenuated"}
OnlyValidState == value \subseteq Allowed
ReplayMatches == value = replayed
ValidAttenuation == phase # "attenuated" \/ keep \subseteq Allowed
NoWiden == phase # "attenuated" \/ value \subseteq prior
RefusalUnchanged == /\ (phase # "add-rejected" \/ (value = initial /\ replayed = initial /\ revision = 0))
                    /\ (phase # "keep-rejected" \/ (value = prior /\ revision = 1))
=============================================================================
