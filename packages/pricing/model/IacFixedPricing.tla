--------------------------- MODULE IacFixedPricing ---------------------------
EXTENDS Naturals

\* One bounded workload after the V2 quote has validated all usage rates.
\* This is a decision model, not a refinement proof of the TypeScript code.
VARIABLES usagePriced, fixedApplicable, requiresQuantity,
          agreementQuantity, workloadQuantity, amount, decision
vars == <<usagePriced, fixedApplicable, requiresQuantity,
          agreementQuantity, workloadQuantity, amount, decision>>

Init ==
  /\ usagePriced \in BOOLEAN
  /\ fixedApplicable \in BOOLEAN
  /\ requiresQuantity \in BOOLEAN
  /\ agreementQuantity \in BOOLEAN
  /\ workloadQuantity \in BOOLEAN
  /\ amount \in 0..1
  /\ decision = "pending"

Eligible ==
  /\ usagePriced \/ fixedApplicable
  /\ ~fixedApplicable \/ ~requiresQuantity \/ (agreementQuantity /\ workloadQuantity)

Decide ==
  /\ decision = "pending"
  /\ decision' = IF Eligible
                  THEN IF amount = 0 THEN "zero" ELSE "positive"
                  ELSE "unavailable"
  /\ UNCHANGED <<usagePriced, fixedApplicable, requiresQuantity,
                 agreementQuantity, workloadQuantity, amount>>

Spec == Init /\ [][Decide]_vars

TypeOK ==
  /\ usagePriced \in BOOLEAN
  /\ fixedApplicable \in BOOLEAN
  /\ requiresQuantity \in BOOLEAN
  /\ agreementQuantity \in BOOLEAN
  /\ workloadQuantity \in BOOLEAN
  /\ amount \in 0..1
  /\ decision \in {"pending", "zero", "positive", "unavailable"}

QuotedHasApplicableCharge ==
  decision \in {"zero", "positive"} => usagePriced \/ fixedApplicable
QuotedHasExplicitQuantity ==
  decision \in {"zero", "positive"} /\ fixedApplicable /\ requiresQuantity
    => agreementQuantity /\ workloadQuantity
ZeroRequiresExplicitPrice == decision = "zero" => Eligible /\ amount = 0
PositiveRequiresExplicitPrice == decision = "positive" => Eligible /\ amount = 1
EligibleModelIsQuoted == decision = "unavailable" => ~Eligible

NoFixedZero ==
  ~(decision = "zero" /\ ~usagePriced /\ fixedApplicable /\ requiresQuantity
    /\ agreementQuantity /\ workloadQuantity)
NoFixedPositive ==
  ~(decision = "positive" /\ ~usagePriced /\ fixedApplicable /\ requiresQuantity
    /\ agreementQuantity /\ workloadQuantity)
NoUnavailable == decision # "unavailable"
=============================================================================
