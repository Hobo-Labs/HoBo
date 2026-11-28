---------------------- MODULE YardUncertaintyBinding ----------------------
\* One uncertainty write; other reservation fields and status are assumed
\* valid. The adapter may return or expose different quote/execution digests.
CONSTANTS CheckReturnQuote, CheckStoredQuote, CheckDomain, CheckAgreement, CheckClaimed
VARIABLES claimed, returnedQuote, storedQuote, returnedExec, storedExec, phase
vars == <<claimed, returnedQuote, storedQuote, returnedExec, storedExec, phase>>
Init == /\ claimed \in BOOLEAN
        /\ returnedQuote \in {"bound", "other"} /\ storedQuote \in {"bound", "other"}
        /\ returnedExec \in {"empty", "expected", "other"}
        /\ storedExec \in {"empty", "expected", "other"}
        /\ phase = "checking"
Valid == /\ returnedQuote = "bound" /\ storedQuote = "bound"
         /\ returnedExec \in {"empty", "expected"} /\ storedExec \in {"empty", "expected"}
         /\ returnedExec = storedExec
         /\ (claimed => returnedExec = "expected")
Check == /\ phase = "checking"
         /\ phase' = IF /\ (returnedQuote = "bound" \/ ~CheckReturnQuote)
                        /\ (storedQuote = "bound" \/ ~CheckStoredQuote)
                        /\ ((returnedExec \in {"empty", "expected"} /\ storedExec \in {"empty", "expected"}) \/ ~CheckDomain)
                        /\ (returnedExec = storedExec \/ ~CheckAgreement)
                        /\ (~claimed \/ (returnedExec = "expected" /\ storedExec = "expected") \/ ~CheckClaimed)
                      THEN "accepted" ELSE "reconcile"
         /\ UNCHANGED <<claimed, returnedQuote, storedQuote, returnedExec, storedExec>>
Done == UNCHANGED vars
Next == Check \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ claimed \in BOOLEAN /\ returnedQuote \in {"bound", "other"}
          /\ storedQuote \in {"bound", "other"} /\ returnedExec \in {"empty", "expected", "other"}
          /\ storedExec \in {"empty", "expected", "other"} /\ phase \in {"checking", "accepted", "reconcile"}
ReturnedQuoteBound == phase = "accepted" => returnedQuote = "bound"
StoredQuoteBound == phase = "accepted" => storedQuote = "bound"
ExecutionDomain == phase = "accepted" => (returnedExec \in {"empty", "expected"} /\ storedExec \in {"empty", "expected"})
ExecutionsAgree == phase = "accepted" => returnedExec = storedExec
KnownClaimPreserved == phase = "accepted" /\ claimed => returnedExec = "expected"
ValidEvidenceAccepted == phase = "reconcile" => ~Valid
===========================================================================
