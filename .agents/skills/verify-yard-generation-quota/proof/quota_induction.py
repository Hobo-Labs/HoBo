from z3 import And, Ints, Not, Solver, sat, unsat

active, tenant, max_active, max_tenant = Ints('active tenant max_active max_tenant')
base = [active >= 0, tenant >= 0, max_active > 0, max_tenant > 0,
        active <= max_active, tenant <= max_tenant]

def prove(name, assumptions, conclusion):
    witness = Solver()
    witness.add(*assumptions)
    if witness.check() != sat:
        raise RuntimeError(f'{name}: premises have no witness')
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    if solver.check() != unsat:
        raise RuntimeError(f'{name}: obligation failed: {solver.model()}')
    print(f'PASS {name}', flush=True)

def counterexample(name, assumptions, conclusion):
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    if solver.check() != sat:
        raise RuntimeError(f'{name}: expected counterexample missing')
    print(f'Expected proof counterexample: {name}', flush=True)

post_reserve = And(active + 1 <= max_active, tenant + 1 <= max_tenant)
prove('reserve preserves both integer limits', base + [active < max_active, tenant < max_tenant], post_reserve)
prove('verified ready releases only an active slot', base + [active > 0], And(active - 1 >= 0, active - 1 <= max_active, tenant <= max_tenant))
prove('a full tenant cannot reserve another Yard', [tenant >= max_tenant], Not(tenant < max_tenant))
counterexample('missing concurrency guard', base + [tenant < max_tenant], post_reserve)
counterexample('missing tenant guard', base + [active < max_active], post_reserve)
counterexample('ready without a pending slot', base, active - 1 >= 0)
print('SCOPE: exact integer counter abstraction; assumes atomic transitions, complete inventory, verified readiness and unchanged limits; no TypeScript refinement', flush=True)
