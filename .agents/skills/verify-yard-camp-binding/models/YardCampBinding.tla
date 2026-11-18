-------------------------- MODULE YardCampBinding ---------------------------
EXTENDS Naturals
CONSTANTS PreserveEnv, ValidateEnv, CheckParent, HonorExplicit
VARIABLES initialEnv, liveEnv, camp, hostAllows, phase, parsedEnv,
          selected, parent, approved
vars == <<initialEnv, liveEnv, camp, hostAllows, phase, parsedEnv,
          selected, parent, approved>>

Init == /\ initialEnv \in {"none", "production", "invalid"}
        /\ liveEnv = initialEnv
        /\ camp \in {"none", "relative", "same-yard", "foreign", "nested"}
        /\ hostAllows \in BOOLEAN
        /\ phase = "parse" /\ parsedEnv = "unset" /\ selected = "unset"
        /\ parent = "unset" /\ approved = FALSE

Parse == /\ phase = "parse"
         /\ phase' = IF initialEnv = "invalid" /\ ValidateEnv
                     THEN "rejected" ELSE "select"
         /\ parsedEnv' = IF PreserveEnv THEN initialEnv ELSE "none"
         /\ UNCHANGED <<initialEnv, liveEnv, camp, hostAllows, selected,
                        parent, approved>>

Select == /\ phase = "select"
          /\ phase' = IF camp \in {"foreign", "nested"} /\ CheckParent
                      THEN "rejected" ELSE "selected"
          /\ parent' = IF camp \in {"foreign", "nested"} /\ ~CheckParent
                       THEN "other" ELSE "yard"
          /\ selected' = IF camp # "none" /\ HonorExplicit THEN "explicit"
                          ELSE IF parsedEnv = "none" THEN "dev" ELSE parsedEnv
          /\ UNCHANGED <<initialEnv, liveEnv, camp, hostAllows, parsedEnv, approved>>

EditSource == /\ phase \in {"select", "selected", "allowed"}
              /\ liveEnv' \in {"production", "edited"} \ {liveEnv}
              /\ UNCHANGED <<initialEnv, camp, hostAllows, phase, parsedEnv,
                             selected, parent, approved>>

Authorize == /\ phase = "selected"
             /\ phase' = IF hostAllows THEN "allowed" ELSE "rejected"
             /\ approved' = hostAllows
             /\ UNCHANGED <<initialEnv, liveEnv, camp, hostAllows, parsedEnv,
                            selected, parent>>

Issue == /\ phase = "allowed" /\ phase' = "issued"
         /\ UNCHANGED <<initialEnv, liveEnv, camp, hostAllows, parsedEnv,
                        selected, parent, approved>>
Done == /\ phase \in {"issued", "rejected"} /\ UNCHANGED vars
Next == Parse \/ Select \/ EditSource \/ Authorize \/ Issue \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ initialEnv \in {"none", "production", "invalid"}
          /\ liveEnv \in {"none", "production", "invalid", "edited"}
          /\ camp \in {"none", "relative", "same-yard", "foreign", "nested"}
          /\ hostAllows \in BOOLEAN
          /\ phase \in {"parse", "select", "selected", "allowed", "issued", "rejected"}
          /\ parsedEnv \in {"unset", "none", "production", "invalid"}
          /\ selected \in {"unset", "explicit", "dev", "production", "invalid"}
          /\ parent \in {"unset", "yard", "other"} /\ approved \in BOOLEAN
EnvCaptured == phase \in {"select", "selected", "allowed", "issued"} =>
               parsedEnv = initialEnv
InvalidRefused == phase \in {"select", "selected", "allowed", "issued"} =>
                  initialEnv # "invalid"
ParentBound == phase \in {"selected", "allowed", "issued"} => parent = "yard"
ExplicitPreserved == phase \in {"selected", "allowed", "issued"} /\ camp # "none"
                     => selected = "explicit"
GeneratedEnvCorrect == phase \in {"selected", "allowed", "issued"} /\ camp = "none"
                       => selected = IF initialEnv = "none" THEN "dev" ELSE initialEnv
ApprovalRequired == phase = "issued" => approved
=============================================================================
