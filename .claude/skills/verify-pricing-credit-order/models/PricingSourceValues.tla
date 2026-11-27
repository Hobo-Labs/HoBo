----------------------- MODULE PricingSourceValues -----------------------
EXTENDS Integers
CONSTANTS CheckBalance, CheckCapacity, CheckCharge, CheckDerived, CheckBasis, CommitmentInCurrency
VARIABLES version, kind, initialBalance, capacity, charge, initialBasis,
          requestedBasis, derived, phase, debit, balance, basisLeft, allocated, unit
vars == <<version, kind, initialBalance, capacity, charge, initialBasis,
          requestedBasis, derived, phase, debit, balance, basisLeft, allocated, unit>>
Min(a,b) == IF a < b THEN a ELSE b
Max(a,b) == IF a > b THEN a ELSE b
Init == /\ version \in {"old", "v5"}
        /\ kind \in {"allowance", "credit", "commitment"}
        /\ initialBalance \in -1..2 /\ capacity \in 0..1 /\ charge \in -1..1
        /\ initialBasis \in 0..1 /\ requestedBasis \in 0..1 /\ derived \in BOOLEAN
        /\ (kind # "credit" => ~derived)
        /\ phase = "received" /\ debit = 0 /\ balance = initialBalance
        /\ basisLeft = initialBasis /\ allocated = 0 /\ unit = "none"
Unsafe == \/ CheckBalance /\ initialBalance < 0
          \/ CheckCapacity /\ initialBalance > capacity
          \/ CheckCharge /\ charge < 0
          \/ CheckDerived /\ derived /\ requestedBasis > 0
Validate == /\ phase = "received"
            /\ phase' = IF version = "v5" /\ Unsafe THEN "rejected" ELSE "ready"
            /\ UNCHANGED <<version,kind,initialBalance,capacity,charge,initialBasis,requestedBasis,derived,debit,balance,basisLeft,allocated,unit>>
Consume == /\ phase = "ready"
           /\ LET amount == Min(initialBalance,charge)
                  cost == IF kind = "credit" /\ amount # 0 THEN requestedBasis ELSE 0
                  blocked == version = "v5" /\ CheckBasis /\ cost > initialBasis
              IN /\ phase' = IF blocked THEN "rejected" ELSE "applied"
                 /\ debit' = IF blocked THEN 0 ELSE amount
                 /\ balance' = IF blocked THEN initialBalance ELSE initialBalance - amount
                 /\ allocated' = IF blocked THEN 0 ELSE cost
                 /\ basisLeft' = IF blocked THEN initialBasis ELSE Max(initialBasis - cost,0)
                 /\ unit' = IF blocked THEN "none" ELSE IF kind = "allowance" THEN "usage" ELSE IF kind = "commitment" /\ (version = "old" \/ ~CommitmentInCurrency) THEN "usage" ELSE "currency"
           /\ UNCHANGED <<version,kind,initialBalance,capacity,charge,initialBasis,requestedBasis,derived>>
Done == /\ phase \in {"rejected","applied"} /\ UNCHANGED vars
Next == Validate \/ Consume \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old", "v5"} /\ kind \in {"allowance", "credit", "commitment"}
          /\ initialBalance \in -1..2 /\ capacity \in 0..1 /\ charge \in -1..1
          /\ initialBasis \in 0..1 /\ requestedBasis \in 0..1 /\ derived \in BOOLEAN
          /\ phase \in {"received","ready","rejected","applied"} /\ debit \in -1..1
          /\ balance \in -1..3 /\ basisLeft \in 0..1 /\ allocated \in 0..1
          /\ unit \in {"none","usage","currency"}
CurrentAmountSafe == version = "v5" /\ phase = "applied" =>
                     /\ debit >= 0 /\ debit <= initialBalance /\ debit <= charge
                     /\ initialBalance <= capacity /\ balance = initialBalance - debit
AmountSafe == CurrentAmountSafe
CurrentBasisConserved == version = "v5" /\ phase = "applied" /\ kind = "credit" =>
                         /\ basisLeft >= 0 /\ basisLeft + allocated = initialBasis
BasisConserved == CurrentBasisConserved
CurrentDerivedNoBasis == version = "v5" /\ phase = "applied" /\ derived => allocated = 0
DerivedNoBasis == CurrentDerivedNoBasis
CurrentCommitmentCurrency == version = "v5" /\ phase = "applied" /\ kind = "commitment" => unit = "currency"
CommitmentCurrency == CurrentCommitmentCurrency
ChartSubset == initialBalance \in {-1, 1, 2} /\ capacity = 1 /\ charge = 1
AllAmountSafe == phase = "applied" => debit >= 0 /\ debit <= initialBalance /\ debit <= charge /\ initialBalance <= capacity
=============================================================================
