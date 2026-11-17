"""Inductive exact-real linear-price grouping obligations."""
import os
from z3 import And, Real, Or, Solver, sat, unsat

price_a, price_b, total_a, total_b, quantity = [Real(s) for s in ('price_a','price_b','total_a','total_b','quantity')]
assumptions=[price_a >= 0, price_b >= 0, total_a >= 0, total_b >= 0, quantity >= 0]
base=price_a*total_a+price_b*total_b
mutated=os.environ.get('PRICING_SELECTOR_PROOF_MUTATION') == 'wrong-group'
after_a=(price_b if mutated else price_a)*(total_a+quantity)+price_b*total_b
# In the mutation the existing A total must still be valued correctly.
if mutated: after_a=base+price_b*quantity
after_b=price_a*total_a+price_b*(total_b+quantity)
witness=Solver();witness.add(*assumptions,price_a != price_b,quantity > 0)
if witness.check()!=sat: raise SystemExit('grouping premises have no witness')
proof=Solver();proof.add(*assumptions,Or(after_a != base+price_a*quantity,after_b != base+price_b*quantity))
if proof.check()!=unsat:
 print('FAIL: a workload is charged at the wrong group price:',proof.model())
 raise SystemExit(1)
print('PASS: each grouped increment contributes its own price for unbounded exact-real amounts')
