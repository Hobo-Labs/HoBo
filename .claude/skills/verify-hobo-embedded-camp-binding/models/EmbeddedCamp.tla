--------------------------- MODULE EmbeddedCamp ----------------------------
EXTENDS Naturals
CONSTANTS CaptureInput, ForwardInput, ReturnReceipt, ReportCaptured
Inputs == {"none", "local", "foreign"}
VARIABLES initial, caller, captured, sent, receipt, returned, phase, edited
vars == <<initial, caller, captured, sent, receipt, returned, phase, edited>>
Init == /\ initial \in Inputs /\ caller = initial
        /\ captured = "unset" /\ sent = "unset"
        /\ receipt = "unset" /\ returned = "unset"
        /\ phase = "received" /\ edited = FALSE
Capture == /\ phase = "received"
           /\ captured' = IF CaptureInput THEN caller ELSE "unset"
           /\ phase' = "captured"
           /\ UNCHANGED <<initial, caller, sent, receipt, returned, edited>>
Edit == /\ phase \in {"captured", "sent", "approved"} /\ ~edited
        /\ caller' \in Inputs /\ edited' = TRUE
        /\ UNCHANGED <<initial, captured, sent, receipt, returned, phase>>
Send == /\ phase = "captured"
        /\ sent' = IF ForwardInput
                    THEN (IF CaptureInput THEN captured ELSE caller)
                    ELSE "none"
        /\ phase' = "sent"
        /\ UNCHANGED <<initial, caller, captured, receipt, returned, edited>>
Broker == /\ phase = "sent"
          /\ phase' = IF sent = "foreign" THEN "refused" ELSE "approved"
          /\ receipt' = IF sent = "foreign" THEN "unset"
                        ELSE IF sent = "local" THEN "local-authorized"
                        ELSE "default-authorized"
          /\ returned' = IF sent = "foreign"
                          THEN (IF ReportCaptured THEN captured ELSE caller)
                          ELSE returned
          /\ UNCHANGED <<initial, caller, captured, sent, edited>>
Return == /\ phase = "approved"
          /\ returned' = IF (ReturnReceipt \/ caller = "none") THEN receipt
                         ELSE IF caller = "local" THEN "local-raw" ELSE "foreign-raw"
          /\ phase' = "returned"
          /\ UNCHANGED <<initial, caller, captured, sent, receipt, edited>>
Done == /\ phase \in {"refused", "returned"} /\ UNCHANGED vars
Next == Capture \/ Edit \/ Send \/ Broker \/ Return \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ initial \in Inputs /\ caller \in Inputs
          /\ captured \in Inputs \cup {"unset"} /\ sent \in Inputs \cup {"unset"}
          /\ receipt \in {"unset", "local-authorized", "default-authorized"}
          /\ returned \in Inputs \cup {"unset", "local-authorized", "default-authorized", "local-raw", "foreign-raw"}
          /\ phase \in {"received", "captured", "sent", "refused", "approved", "returned"}
          /\ edited \in BOOLEAN
RequestBound == phase \in {"sent", "refused", "approved", "returned"} => sent = initial
NoForeignApproval == (phase \in {"approved", "returned"}) => initial # "foreign"
ReturnedReceipt == phase = "returned" => returned = receipt
RejectedRequestBound == phase = "refused" => returned = initial
=============================================================================
