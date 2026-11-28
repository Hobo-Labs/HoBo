---------------------- MODULE YardRequestValidation ----------------------
EXTENDS Naturals
CONSTANTS CheckEstimate, CheckSelection, CheckYard, CheckBindle, CheckCamp
Cases == {"explicit-zero", "positive", "default-mode", "missing-amount", "negative-amount",
          "bad-mode", "bad-yard-list", "bad-yard-label", "bad-yard-id",
          "bad-bindle", "bad-camp"}
VARIABLES inputCase, phase
vars == <<inputCase, phase>>
Valid == {"explicit-zero", "positive", "default-mode"}

Init == /\ inputCase \in Cases /\ phase = "received"
Parse == /\ phase = "received"
         /\ phase' = IF (inputCase \in {"missing-amount", "negative-amount"} /\ CheckEstimate) \/
                        (inputCase = "bad-mode" /\ CheckSelection) \/
                        (inputCase \in {"bad-yard-list", "bad-yard-label", "bad-yard-id"} /\ CheckYard) \/
                        (inputCase = "bad-bindle" /\ CheckBindle) \/
                        (inputCase = "bad-camp" /\ CheckCamp)
                     THEN "refused" ELSE "parsed"
         /\ UNCHANGED inputCase
Authorize == /\ phase = "parsed" /\ phase' = "authorized" /\ UNCHANGED inputCase
Done == /\ phase \in {"refused", "authorized"} /\ UNCHANGED vars
Next == Parse \/ Authorize \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ inputCase \in Cases /\ phase \in {"received", "refused", "parsed", "authorized"}
ValidEstimate == phase = "authorized" => inputCase \notin {"missing-amount", "negative-amount"}
ValidMode == phase = "authorized" => inputCase # "bad-mode"
ValidYard == phase = "authorized" => inputCase \notin {"bad-yard-list", "bad-yard-label", "bad-yard-id"}
ValidBindle == phase = "authorized" => inputCase # "bad-bindle"
ValidCamp == phase = "authorized" => inputCase # "bad-camp"
ValidNotRefused == phase = "refused" => inputCase \notin Valid
=============================================================================
