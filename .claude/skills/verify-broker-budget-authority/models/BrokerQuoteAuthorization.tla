-------------------- MODULE BrokerQuoteAuthorization --------------------
EXTENDS Naturals
VARIABLES version, source, validQuote, amount, rounded, budget, cap,
          budgetUnlimited, capUnlimited, phase
vars == <<version,source,validQuote,amount,rounded,budget,cap,budgetUnlimited,capUnlimited,phase>>
Init == /\ version \in {"old","new"} /\ source \in {"quote","rawQuote","estimate"}
        /\ validQuote \in BOOLEAN /\ amount \in 0..2 /\ rounded \in BOOLEAN
        /\ budget \in 0..1 /\ cap \in 0..1 /\ budgetUnlimited \in BOOLEAN /\ capUnlimited \in BOOLEAN
        /\ phase = "received"
Authorize == /\ phase = "received"
             /\ LET reported == IF rounded /\ amount > 0 THEN amount - 1 ELSE amount
                    oldAllowed == (cap = 0 \/ reported <= cap) /\ (budget = 0 \/ reported <= budget)
                    evidence == source # "rawQuote" /\ (source # "quote" \/ validQuote)
                    newAllowed == evidence /\ (capUnlimited \/ amount <= cap) /\ (budgetUnlimited \/ amount <= budget)
                IN phase' = IF (IF version = "new" THEN newAllowed ELSE oldAllowed)
                              THEN "authorized" ELSE "denied"
             /\ UNCHANGED <<version,source,validQuote,amount,rounded,budget,cap,budgetUnlimited,capUnlimited>>
Done == /\ phase \in {"authorized","denied"} /\ UNCHANGED vars
Next == Authorize \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","new"} /\ source \in {"quote","rawQuote","estimate"}
          /\ validQuote \in BOOLEAN /\ amount \in 0..2 /\ rounded \in BOOLEAN
          /\ budget \in 0..1 /\ cap \in 0..1 /\ budgetUnlimited \in BOOLEAN /\ capUnlimited \in BOOLEAN
          /\ phase \in {"received","authorized","denied"}
CurrentBudgetSafe == version = "new" /\ phase = "authorized" =>
                     /\ (capUnlimited \/ amount <= cap) /\ (budgetUnlimited \/ amount <= budget)
CurrentQuoteSafe == version = "new" /\ phase = "authorized" =>
                    /\ source # "rawQuote" /\ (source = "quote" => validQuote)
AllBudgetSafe == phase = "authorized" => /\ (capUnlimited \/ amount <= cap) /\ (budgetUnlimited \/ amount <= budget)
AllQuoteSafe == phase = "authorized" => /\ source # "rawQuote" /\ (source = "quote" => validQuote)
ChartSubset == cap = 1 /\ capUnlimited = FALSE /\ rounded = FALSE /\ amount = 1
=============================================================================
