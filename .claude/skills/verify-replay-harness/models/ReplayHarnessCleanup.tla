---------------------- MODULE ReplayHarnessCleanup ----------------------
\* Two temporary process-global intrinsics; restoration can itself fail.
CONSTANTS CleanupOnSetupFailure, TryClockAfterFailure, UseDescriptors
VARIABLES clockWritable, randomWritable, clockRestorable, randomRestorable,
          clock, random, outcome, phase
vars == <<clockWritable, randomWritable, clockRestorable, randomRestorable,
          clock, random, outcome, phase>>

Init == /\ clockWritable \in BOOLEAN /\ randomWritable \in BOOLEAN
        /\ clockRestorable \in BOOLEAN /\ randomRestorable \in BOOLEAN
        /\ clock = "original" /\ random = "original"
        /\ outcome = "none" /\ phase = "install-clock"
InstallClock == /\ phase = "install-clock"
                /\ clock' = IF clockWritable THEN "override" ELSE clock
                /\ phase' = IF clockWritable THEN "install-random" ELSE "done"
                /\ UNCHANGED <<clockWritable, randomWritable, clockRestorable,
                                randomRestorable, random, outcome>>
InstallRandom == /\ phase = "install-random"
                 /\ random' = IF randomWritable THEN "override" ELSE random
                 /\ phase' = IF randomWritable THEN "callback"
                              ELSE IF CleanupOnSetupFailure THEN "restore-clock" ELSE "done"
                 /\ UNCHANGED <<clockWritable, randomWritable, clockRestorable,
                                 randomRestorable, clock, outcome>>
Callback == /\ phase = "callback"
            /\ \E alterClock, alterRandom, throws \in BOOLEAN:
                 /\ clock' = IF alterClock THEN "modified" ELSE clock
                 /\ random' = IF alterRandom THEN "modified" ELSE random
                 /\ outcome' = IF throws THEN "throw" ELSE "return"
            /\ phase' = "restore-random"
            /\ UNCHANGED <<clockWritable, randomWritable, clockRestorable, randomRestorable>>
RestoreRandom == /\ phase = "restore-random"
                 /\ LET fails == ~randomRestorable \/ (~UseDescriptors /\ random = "modified")
                    IN /\ random' = IF fails THEN random ELSE "original"
                       /\ phase' = IF fails /\ ~TryClockAfterFailure THEN "done" ELSE "restore-clock"
                 /\ UNCHANGED <<clockWritable, randomWritable, clockRestorable,
                                 randomRestorable, clock, outcome>>
RestoreClock == /\ phase = "restore-clock"
                /\ clock' = IF clockRestorable /\ (UseDescriptors \/ clock # "modified")
                            THEN "original" ELSE clock
                /\ phase' = "done"
                /\ UNCHANGED <<clockWritable, randomWritable, clockRestorable,
                                randomRestorable, random, outcome>>
Done == UNCHANGED vars
Next == InstallClock \/ InstallRandom \/ Callback \/ RestoreRandom \/ RestoreClock \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ clockWritable \in BOOLEAN /\ randomWritable \in BOOLEAN
          /\ clockRestorable \in BOOLEAN /\ randomRestorable \in BOOLEAN
          /\ clock \in {"original", "override", "modified"}
          /\ random \in {"original", "override", "modified"}
          /\ outcome \in {"none", "return", "throw"}
          /\ phase \in {"install-clock", "install-random", "callback",
                        "restore-random", "restore-clock", "done"}
ClockRestored == phase = "done" /\ clockRestorable => clock = "original"
RandomRestored == phase = "done" /\ randomRestorable => random = "original"
============================================================================
