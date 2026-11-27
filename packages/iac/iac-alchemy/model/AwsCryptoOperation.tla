------------------------- MODULE AwsCryptoOperation -------------------------
EXTENDS Naturals

VARIABLES phase, authorized, physical, processed, dispatchAuthorized,
          disclosureAuthorized, settled, second, secondSawFree
vars == <<phase, authorized, physical, processed, dispatchAuthorized,
          disclosureAuthorized, settled, second, secondSawFree>>

Init ==
  /\ phase = "new" /\ authorized = TRUE /\ physical = FALSE
  /\ processed = FALSE /\ dispatchAuthorized = FALSE
  /\ disclosureAuthorized = FALSE /\ settled = FALSE
  /\ second = "new" /\ secondSawFree = FALSE

Revoke ==
  /\ authorized
  /\ authorized' = FALSE
  /\ UNCHANGED <<phase, physical, processed, dispatchAuthorized,
                 disclosureAuthorized, settled, second, secondSawFree>>

Dispatch ==
  /\ phase = "new" /\ authorized /\ ~physical
  /\ phase' = "pending" /\ physical' = TRUE
  /\ dispatchAuthorized' = authorized
  /\ UNCHANGED <<authorized, processed, disclosureAuthorized, settled,
                 second, secondSawFree>>

Reject ==
  /\ phase = "new" /\ ~physical
  /\ phase' = "rejected"
  /\ UNCHANGED <<authorized, physical, processed, dispatchAuthorized,
                 disclosureAuthorized, settled, second, secondSawFree>>

Process ==
  /\ phase \in {"pending", "unknown"} /\ physical /\ ~processed
  /\ processed' = TRUE
  /\ UNCHANGED <<phase, authorized, physical, dispatchAuthorized,
                 disclosureAuthorized, settled, second, secondSawFree>>

Complete ==
  /\ phase = "pending" /\ processed /\ authorized /\ physical
  /\ phase' = "completed" /\ physical' = FALSE
  /\ disclosureAuthorized' = authorized
  /\ UNCHANGED <<authorized, processed, dispatchAuthorized, settled,
                 second, secondSawFree>>

Timeout ==
  /\ phase = "pending" /\ physical
  /\ phase' = "unknown"
  /\ UNCHANGED <<authorized, physical, processed, dispatchAuthorized,
                 disclosureAuthorized, settled, second, secondSawFree>>

Settle ==
  /\ phase = "unknown" /\ physical
  /\ physical' = FALSE /\ settled' = TRUE
  /\ UNCHANGED <<phase, authorized, processed, dispatchAuthorized,
                 disclosureAuthorized, second, secondSawFree>>

SecondReject ==
  /\ second = "new" /\ physical
  /\ second' = "rejected"
  /\ UNCHANGED <<phase, authorized, physical, processed, dispatchAuthorized,
                 disclosureAuthorized, settled, secondSawFree>>

SecondDispatch ==
  /\ second = "new" /\ phase \in {"unknown", "completed", "rejected"} /\ ~physical
  /\ second' = "dispatched" /\ secondSawFree' = ~physical
  /\ UNCHANGED <<phase, authorized, physical, processed, dispatchAuthorized,
                 disclosureAuthorized, settled>>

Spec == Init /\ [][Revoke \/ Dispatch \/ Reject \/ Process \/ Complete \/ Timeout \/ Settle \/ SecondReject \/ SecondDispatch]_vars
TypeOK == /\ phase \in {"new", "pending", "completed", "rejected", "unknown"}
          /\ second \in {"new", "rejected", "dispatched"}
          /\ authorized \in BOOLEAN /\ physical \in BOOLEAN /\ processed \in BOOLEAN
          /\ dispatchAuthorized \in BOOLEAN /\ disclosureAuthorized \in BOOLEAN
          /\ settled \in BOOLEAN /\ secondSawFree \in BOOLEAN
DispatchAuthorized == phase \in {"pending", "completed", "unknown"} => dispatchAuthorized
RejectedBeforeDispatch == phase = "rejected" => ~dispatchAuthorized
CompletedAfterProcessing == phase = "completed" => processed
DisclosureAuthorized == phase = "completed" => disclosureAuthorized
TimeoutKeepsCapacity == phase = "unknown" /\ ~settled => physical
SecondRequiresFreeCapacity == second = "dispatched" => secondSawFree
NoUnknownBeforeProcessing == ~(phase = "unknown" /\ ~processed)
NoUnknownAfterProcessing == ~(phase = "unknown" /\ processed)
NoCapacityRejectionAfterTimeout == ~(phase = "unknown" /\ second = "rejected")
NoRecoveryAfterTimeout == ~(phase = "unknown" /\ second = "dispatched")
=============================================================================
