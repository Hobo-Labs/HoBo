--------------------------- MODULE Connection ---------------------------
EXTENDS Naturals
VARIABLES phase, revokedOnce, usedAfterRevocation
vars == <<phase, revokedOnce, usedAfterRevocation>>
Init == /\ phase = "absent" /\ revokedOnce = FALSE /\ usedAfterRevocation = FALSE
Create == /\ phase = "absent" /\ phase' = "pending"
          /\ UNCHANGED <<revokedOnce, usedAfterRevocation>>
Authorize == /\ phase \in {"pending", "active", "needs-reauth"}
             /\ phase' = "active"
             /\ UNCHANGED <<revokedOnce, usedAfterRevocation>>
Revoke == /\ phase \in {"pending", "active", "needs-reauth", "revoked"}
          /\ phase' = "revoked" /\ revokedOnce' = TRUE
          /\ UNCHANGED usedAfterRevocation
NeedsReauth == /\ phase \in {"pending", "active", "needs-reauth"}
               /\ phase' = "needs-reauth"
               /\ UNCHANGED <<revokedOnce, usedAfterRevocation>>
Rotate == /\ phase \in {"pending", "active", "needs-reauth"}
          /\ phase' = "active" /\ UNCHANGED <<revokedOnce, usedAfterRevocation>>
LateFact == /\ phase = "revoked" /\ UNCHANGED vars
Resolve == /\ phase = "active"
           /\ usedAfterRevocation' = (usedAfterRevocation \/ revokedOnce)
           /\ UNCHANGED <<phase, revokedOnce>>
Next == Create \/ Authorize \/ Revoke \/ NeedsReauth \/ Rotate \/ LateFact \/ Resolve
Spec == Init /\ [][Next]_vars
NoUseAfterRevocation == ~usedAfterRevocation
RevokedRemainsRevoked == revokedOnce => phase = "revoked"
TypeOK == /\ phase \in {"absent", "pending", "active", "needs-reauth", "revoked"}
          /\ revokedOnce \in BOOLEAN /\ usedAfterRevocation \in BOOLEAN
=============================================================================
