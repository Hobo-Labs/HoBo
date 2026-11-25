"""Coverage of two adjacent abstract tiers over unbounded exact-real inputs."""
import os
from z3 import If, Or, Real, Solver, sat, unsat
end, start, point = Real('first_end'), Real('second_start'), Real('point')
mutation=os.environ.get('PRICING_TIER_PROOF_MUTATION') == 'omit-adjacency'
assumptions=[end > 0,start > 0,point >= 0]
if not mutation: assumptions.append(end == start)
covered=If(point < end,1,0)+If(point >= start,1,0)
witness=Solver();witness.add(*assumptions,point > 0)
if witness.check()!=sat: raise SystemExit('tier premises have no witness')
proof=Solver();proof.add(*assumptions,covered != 1)
if proof.check()!=unsat:
 print('FAIL: a point has a gap or overlapping coverage:',proof.model())
 raise SystemExit(1)
print('PASS: adjacent abstract tiers cover each nonnegative point exactly once')
