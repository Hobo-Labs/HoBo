----------------------------- MODULE ComponentCalls -----------------------------
EXTENDS Naturals
CONSTANTS GuardBusy, ReleaseOnSettle
VARIABLES phase, mode, started, pending, fence
vars == <<phase, mode, started, pending, fence>>
Init == /\ phase = "loaded" /\ mode \in {"linked", "http"}
        /\ started = 0 /\ pending = 0 /\ fence = 0
Start == /\ phase = "loaded" /\ started < 2
         /\ started' = started + 1 /\ pending' = pending + 1 /\ fence' = fence + 1
         /\ UNCHANGED <<phase, mode>>
Settle == /\ pending > 0 /\ pending' = pending - 1
          /\ fence' = IF ReleaseOnSettle THEN fence - 1 ELSE fence
          /\ UNCHANGED <<phase, mode, started>>
Teardown == /\ phase = "loaded" /\ (fence = 0 \/ ~GuardBusy) /\ phase' = "torn-down"
            /\ UNCHANGED <<mode, started, pending, fence>>
Done == /\ (phase = "torn-down" \/ (phase = "loaded" /\ started = 2 /\ pending = 0))
        /\ UNCHANGED vars
Next == Start \/ Settle \/ Teardown \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"loaded", "torn-down"} /\ mode \in {"linked", "http"}
          /\ started \in 0..2 /\ pending \in 0..2 /\ fence \in 0..2
          /\ pending <= started
NoTeardownDuringCall == phase = "torn-down" => pending = 0
ReleasedAfterSettle == fence = pending
=============================================================================
