------------------------- MODULE StartFenceHandler -------------------------
VARIABLES auth, pre, outcome, post, live, phase, committed, receipt
vars == <<auth, pre, outcome, post, live, phase, committed, receipt>>
Init == /\ auth \in BOOLEAN /\ pre \in BOOLEAN /\ post \in BOOLEAN /\ live \in BOOLEAN
        /\ outcome \in {"commit", "reject", "lost"} /\ phase = "received"
        /\ committed = FALSE /\ receipt = FALSE
Authenticate == /\ phase = "received" /\ phase' = IF auth THEN "lookup" ELSE "rejected"
                /\ UNCHANGED <<auth, pre, outcome, post, live, committed, receipt>>
Lookup == /\ phase = "lookup" /\ phase' = IF pre THEN "binding" ELSE "rejected"
          /\ UNCHANGED <<auth, pre, outcome, post, live, committed, receipt>>
Bind == /\ phase = "binding"
        /\ CASE outcome = "commit" -> /\ committed' = TRUE /\ phase' = "recheck"
             [] outcome = "reject" -> /\ committed' = FALSE /\ phase' = "rejected"
             [] outcome = "lost" -> /\ committed' \in BOOLEAN /\ phase' = "uncertain"
        /\ UNCHANGED <<auth, pre, outcome, post, live, receipt>>
Recheck == /\ phase = "recheck" /\ phase' = IF post THEN "claimread" ELSE "uncertain"
           /\ UNCHANGED <<auth, pre, outcome, post, live, committed, receipt>>
CheckClaim == /\ phase = "claimread"
              /\ IF live THEN /\ phase' = "issued" /\ receipt' = TRUE
                         ELSE /\ phase' = "uncertain" /\ receipt' = FALSE
              /\ UNCHANGED <<auth, pre, outcome, post, live, committed>>
Done == /\ phase \in {"rejected", "uncertain", "issued"} /\ UNCHANGED vars
Next == Authenticate \/ Lookup \/ Bind \/ Recheck \/ CheckClaim \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ auth \in BOOLEAN /\ pre \in BOOLEAN /\ post \in BOOLEAN /\ live \in BOOLEAN
          /\ committed \in BOOLEAN /\ receipt \in BOOLEAN
          /\ outcome \in {"commit", "reject", "lost"}
          /\ phase \in {"received", "lookup", "binding", "recheck", "claimread", "rejected", "uncertain", "issued"}
AuthenticatedBeforeBinding == phase \in {"binding", "recheck", "claimread", "issued"} => auth /\ pre
NoReceiptWithoutAssignment == receipt => pre /\ post
NoReceiptBeforeCommit == receipt => committed
NoReceiptForTerminalObservation == receipt => live
NoReceiptOnUncertainty == phase = "uncertain" => ~receipt
=============================================================================
