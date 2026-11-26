---------------------------- MODULE TopicPolicy ----------------------------
EXTENDS TLC

VARIABLES topic, method, destination, active, verified, dispatched, effect,
          disclosed, unknown, dispatchProof, disclosureProof
vars == <<topic, method, destination, active, verified, dispatched, effect,
          disclosed, unknown, dispatchProof, disclosureProof>>

Expected == /\ topic = "orders"
           /\ method \in {"publish", "subscribe"}
           /\ (method # "subscribe" \/ destination = "dlq")
Allowed == Expected

Init == /\ topic \in {"orders", "other"}
        /\ method \in {"publish", "subscribe", "admin"}
        /\ destination \in {"dlq", "other"}
        /\ active = TRUE /\ verified = TRUE
        /\ dispatched = FALSE /\ effect = FALSE /\ disclosed = FALSE
        /\ unknown = FALSE /\ dispatchProof = FALSE /\ disclosureProof = FALSE

Dispatch ==
  /\ active /\ verified /\ Allowed /\ ~dispatched
  /\ dispatched' = TRUE /\ dispatchProof' = (active /\ verified /\ Expected)
  /\ UNCHANGED <<topic, method, destination, active, verified, effect,
                 disclosed, unknown, disclosureProof>>

Commit ==
  /\ dispatched /\ ~effect
  /\ effect' = TRUE
  /\ UNCHANGED <<topic, method, destination, active, verified, dispatched,
                 disclosed, unknown, dispatchProof, disclosureProof>>

Disclose ==
  /\ active /\ verified /\ Allowed /\ effect /\ ~disclosed /\ ~unknown
  /\ disclosed' = TRUE /\ disclosureProof' = (active /\ verified /\ Expected)
  /\ UNCHANGED <<topic, method, destination, active, verified, dispatched,
                 effect, unknown, dispatchProof>>

Revoke ==
  /\ active /\ active' = FALSE
  /\ UNCHANGED <<topic, method, destination, verified, dispatched, effect,
                 disclosed, unknown, dispatchProof, disclosureProof>>

Timeout ==
  /\ dispatched /\ ~disclosed /\ ~unknown
  /\ unknown' = TRUE
  /\ UNCHANGED <<topic, method, destination, active, verified, dispatched,
                 effect, disclosed, dispatchProof, disclosureProof>>

Next == Dispatch \/ Commit \/ Disclose \/ Revoke \/ Timeout
Spec == Init /\ [][Next]_vars

TypeOK == /\ topic \in {"orders", "other"}
          /\ method \in {"publish", "subscribe", "admin"}
          /\ destination \in {"dlq", "other"}
          /\ active \in BOOLEAN /\ verified \in BOOLEAN
          /\ dispatched \in BOOLEAN /\ effect \in BOOLEAN /\ disclosed \in BOOLEAN
          /\ unknown \in BOOLEAN /\ dispatchProof \in BOOLEAN /\ disclosureProof \in BOOLEAN
DispatchAuthorized == dispatched => dispatchProof
DisclosureAuthorized == disclosed => disclosureProof /\ effect
NoAmbiguousDisclosure == ~(unknown /\ disclosed)
NeverAllowedPublish == ~(disclosed /\ method = "publish")
NeverAllowedSubscribe == ~(disclosed /\ method = "subscribe")
NeverUnknownCommit == ~(unknown /\ effect)
=============================================================================
