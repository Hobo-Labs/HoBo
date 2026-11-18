------------------------ MODULE WorkflowDefinitionSnapshot ------------------------
\* One captured definition field, one caller edit, three entry points.
CONSTANTS CaptureName, CaptureRun, CaptureTools, CaptureCapabilities, CaptureInvocation
VARIABLES phase, mode, field, live, captured, selected, edited
vars == <<phase, mode, field, live, captured, selected, edited>>
Fields == {"name", "run", "tools", "capabilities", "invocation"}
ShouldCapture == CASE field = "name" -> CaptureName
                   [] field = "run" -> CaptureRun
                   [] field = "tools" -> CaptureTools
                   [] field = "capabilities" -> CaptureCapabilities
                   [] OTHER -> CaptureInvocation
Init == /\ phase = "received" /\ mode \in {"start", "resume", "replay"}
        /\ field \in Fields /\ live = "original" /\ captured = "none"
        /\ selected = "none" /\ edited = FALSE
Capture == /\ phase = "received" /\ phase' = "waiting"
           /\ captured' = live /\ UNCHANGED <<mode, field, live, selected, edited>>
Edit == /\ phase = "waiting" /\ ~edited
        /\ live' = "changed" /\ edited' = TRUE
        /\ UNCHANGED <<phase, mode, field, captured, selected>>
Use == /\ phase = "waiting" /\ phase' = "executed"
       /\ selected' = IF ShouldCapture THEN captured ELSE live
       /\ UNCHANGED <<mode, field, live, captured, edited>>
Done == /\ phase = "executed" /\ UNCHANGED vars
Next == Capture \/ Edit \/ Use \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "waiting", "executed"}
          /\ mode \in {"start", "resume", "replay"} /\ field \in Fields
          /\ live \in {"original", "changed"} /\ captured \in {"none", "original"}
          /\ selected \in {"none", "original", "changed"} /\ edited \in BOOLEAN
SelectedCaptured == phase = "executed" => selected = captured
=============================================================================
