from z3 import Consts, DeclareSort, If, K, Not, Select, Solver, Store, sat, unsat

Name = DeclareSort('Name')
old_id, old_alias, new_id, new_alias = Consts('old_id old_alias new_id new_alias', Name)
has_alias = Store(K(Name, False), old_alias, True)
alias_target = Store(K(Name, old_id), old_alias, old_id)
next_has_alias = Store(has_alias, new_alias, True)
next_target = Store(alias_target, new_alias, new_id)
def lookup(name):
    return If(Select(next_has_alias, name), Select(next_target, name), name)

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    result = solver.check()
    if result != expected:
        raise AssertionError(f'{name}: expected {expected}, got {result}')
    print(f"{'Proved' if expected == unsat else 'Expected witness'}: {name}")

base = [old_id != old_alias, new_id != old_id]
guards = [new_id != old_alias, new_alias != old_id, new_alias != old_alias]
check('valid distinct names exist', base + guards, sat)
check('guarded insertion preserves old names and the new ID', base + guards + [Not((lookup(old_id) == old_id) & (lookup(old_alias) == old_id) & (lookup(new_id) == new_id))], unsat)
check('an alias colliding with the old ID changes its lookup', base + [new_alias == old_id, lookup(old_id) != old_id], sat)
check('an ID colliding with the old alias cannot resolve to itself', base + [new_id == old_alias, new_alias != old_alias, lookup(new_id) != new_id], sat)
