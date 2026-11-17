------------------------- MODULE StartHookReceipt -------------------------
VARIABLES context, status, response, committed, active, phase, called, started
vars == <<context, status, response, committed, active, phase, called, started>>
Statuses == {200, 302, 503}
Responses == {"matching", "mismatch", "rejected", "malformed", "oversized"}
Init == /\ context \in BOOLEAN /\ status \in Statuses /\ response \in Responses /\ committed \in BOOLEAN /\ active \in BOOLEAN
        /\ (status = 200 /\ response = "matching" => committed /\ active)
        /\ phase = "ready" /\ called = FALSE /\ started = FALSE
CheckContext == /\ phase = "ready"
                /\ IF context THEN /\ phase' = "awaiting" /\ called' = TRUE
                              ELSE /\ phase' = "rejected" /\ called' = FALSE
                /\ UNCHANGED <<context, status, response, committed, active, started>>
CheckReceipt == /\ phase = "awaiting"
                /\ IF status = 200 /\ response = "matching"
                      THEN /\ phase' = "authorized" /\ started' = TRUE
                      ELSE /\ phase' = "rejected" /\ started' = FALSE
                /\ UNCHANGED <<context, status, response, committed, active, called>>
Done == /\ phase \in {"rejected", "authorized"} /\ UNCHANGED vars
Next == CheckContext \/ CheckReceipt \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ context \in BOOLEAN /\ status \in Statuses /\ response \in Responses /\ committed \in BOOLEAN /\ active \in BOOLEAN
          /\ phase \in {"ready", "awaiting", "authorized", "rejected"} /\ called \in BOOLEAN /\ started \in BOOLEAN
NoUncommittedStart == started => committed
NoTerminalStart == started => active
NoInvalidReceiptStart == started => context /\ status = 200 /\ response = "matching"
NoCallOnInvalidContext == ~context => ~called
=============================================================================
