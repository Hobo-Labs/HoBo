------------------------ MODULE BrokerQuoteAdmission ------------------------
EXTENDS Naturals
CONSTANTS RecheckAfterHold, RequireHold, BindBound, CheckEnvironment, CheckCatalog
VARIABLES phase, fresh, environment, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog
vars == <<phase, fresh, environment, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Init == /\ phase = "pending" /\ fresh = TRUE /\ environment = TRUE /\ catalog = TRUE
        /\ confirmed \in BOOLEAN /\ held = FALSE /\ gateBound = FALSE /\ holdBound = FALSE
        /\ checkedFresh = FALSE /\ checkedEnvironment = FALSE /\ checkedCatalog = FALSE
CurrentEnvironment == IF CheckEnvironment THEN environment ELSE TRUE
CurrentCatalog == IF CheckCatalog THEN catalog ELSE TRUE
Ready == fresh /\ CurrentEnvironment /\ CurrentCatalog
Quote == /\ phase = "pending" /\ Ready
         /\ phase' = "gated" /\ gateBound' = BindBound
         /\ UNCHANGED <<fresh, environment, catalog, confirmed, held, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Recheck == /\ phase = "gated" /\ Ready /\ phase' = "checked"
           /\ UNCHANGED <<fresh, environment, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Hold == /\ phase = "checked" /\ Ready /\ (IF RequireHold THEN confirmed ELSE TRUE)
        /\ phase' = "held" /\ held' = confirmed /\ holdBound' = gateBound
        /\ UNCHANGED <<fresh, environment, catalog, confirmed, gateBound, checkedFresh, checkedEnvironment, checkedCatalog>>
IssueReady == /\ (IF RecheckAfterHold THEN fresh ELSE TRUE)
              /\ CurrentEnvironment /\ CurrentCatalog
FinalCheck == /\ phase = "held" /\ IssueReady /\ phase' = "finalChecked"
              /\ checkedFresh' = fresh /\ checkedEnvironment' = environment /\ checkedCatalog' = catalog
              /\ UNCHANGED <<fresh, environment, catalog, confirmed, held, gateBound, holdBound>>
Issue == /\ phase = "finalChecked" /\ phase' = "resolved"
         /\ UNCHANGED <<fresh, environment, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Refuse == /\ \/ /\ phase \in {"pending", "gated"} /\ ~Ready
              \/ /\ phase = "checked" /\ ~(Ready /\ (IF RequireHold THEN confirmed ELSE TRUE))
              \/ /\ phase = "held" /\ ~IssueReady
          /\ phase' = "rejected"
          /\ UNCHANGED <<fresh, environment, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Expire == /\ phase \notin {"resolved", "rejected"} /\ fresh /\ fresh' = FALSE
          /\ UNCHANGED <<phase, environment, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Revoke == /\ phase \notin {"resolved", "rejected"} /\ environment /\ environment' = FALSE
          /\ UNCHANGED <<phase, fresh, catalog, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
ChangeCatalog == /\ phase \notin {"resolved", "rejected"} /\ catalog /\ catalog' = FALSE
          /\ UNCHANGED <<phase, fresh, environment, confirmed, held, gateBound, holdBound, checkedFresh, checkedEnvironment, checkedCatalog>>
Done == /\ phase \in {"resolved", "rejected"} /\ UNCHANGED vars
Next == Quote \/ Recheck \/ Hold \/ FinalCheck \/ Issue \/ Refuse \/ Expire \/ Revoke \/ ChangeCatalog \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"pending", "gated", "checked", "held", "finalChecked", "resolved", "rejected"}
          /\ fresh \in BOOLEAN /\ environment \in BOOLEAN /\ catalog \in BOOLEAN
          /\ confirmed \in BOOLEAN /\ held \in BOOLEAN /\ gateBound \in BOOLEAN /\ holdBound \in BOOLEAN
          /\ checkedFresh \in BOOLEAN /\ checkedEnvironment \in BOOLEAN /\ checkedCatalog \in BOOLEAN
ResolvedHasHold == phase = "resolved" => held /\ confirmed
ResolvedFreshAtCheck == phase = "resolved" => checkedFresh
ResolvedStillFresh == phase = "resolved" => fresh
ResolvedEnvironment == phase = "resolved" => checkedEnvironment
ResolvedCatalog == phase = "resolved" => checkedCatalog
ResolvedBound == phase = "resolved" => gateBound /\ holdBound
=============================================================================
