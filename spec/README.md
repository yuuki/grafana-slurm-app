# Proofs of the node list budget

[`lean/NodeBudget.lean`](lean/NodeBudget.lean) proves, with Lean's
`bv_decide`, the arithmetic that keeps `ExpandNodeList`
(`pkg/plugin/slurm/nodeutil.go`) within its budget of 10000 nodes. Go's `int`
is modeled as a two's complement machine word (`BitVec 64`, and `BitVec 32`
for 32-bit builds) with signed comparisons, so each theorem holds for every
pair of range bounds, including those at the limits of `int` where
`endNum-startNum+1` used to wrap around.

Each theorem has a `_64` and a `_32` version.

| Theorem | Meaning |
|---|---|
| `rangeLen_bounded` | `rangeLen` is between 0 and `maxExpandedNodes + 1`. |
| `rangeLen_reversed` | A reversed range has no index. |
| `rangeLen_exact` | A range within the budget gets its exact length. |
| `rangeLen_capped` | A longer range gets `maxExpandedNodes + 1`, so the budget check fails. |
| `index_in_range` | Every index the loops compute, `startNum + k` for `k < rangeLen`, has no overflow and lies in the range. |
| `budget_sum_no_overflow` | `checkRemainingBudget`'s sum of counted nodes, pending indices and a range length cannot wrap. |

An `example` shows that the length computed before the fix is negative for
`0..maxInt`. Parsing and recursion are not modeled; `FuzzExpandNodeList`
checks them.

`make test-lean` builds the proofs with the toolchain that
`lean/lean-toolchain` pins (elan on `PATH` installs it); CI runs it. Change
them together with `rangeLen`, the expansion loops or
`checkRemainingBudget`.
