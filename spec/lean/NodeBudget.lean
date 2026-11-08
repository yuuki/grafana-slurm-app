import Std.Tactic.BVDecide

/-!
# The arithmetic of the node list budget

`ExpandNodeList` (`pkg/plugin/slurm/nodeutil.go`) expands at most
`maxExpandedNodes` (10000) nodes. It counts a bracket range with `rangeLen`
and loops over `startNum + k` for `k < rangeLen`. A range ending at the
largest `int` once made `endNum - startNum + 1` wrap around, so a crafted
nodelist bypassed the budget and expanded forever.

Go's `int` is a two's complement machine word, so this file models it as
`BitVec n` (`n = 64` on the plugin's 64-bit targets, `32` elsewhere) with
signed comparisons, and `bv_decide` proves each statement for every pair of
range bounds. `Wide` is the same value sign-extended by one bit, where
subtraction and addition cannot wrap: it stands for the integer the Go code
means.

What is proved: `rangeLen` never wraps, returns the exact length of a
range within the budget and `maxExpandedNodes + 1` for a longer one, every
index the loops produce is inside the range without overflow, and the
budget check's sum cannot wrap. The parsing and recursion of
`ExpandNodeList` are not modeled; `FuzzExpandNodeList` checks them.
-/

namespace NodeBudget

/-- `maxExpandedNodes`. -/
def maxNodes (n : Nat) : BitVec n := BitVec.ofNat n 10000

/-- `rangeLen` in `nodeutil.go`:

    if endNum < startNum { return 0 }
    if diff := endNum - startNum; diff < 0 || diff >= maxExpandedNodes {
        return maxExpandedNodes + 1
    }
    return endNum - startNum + 1
-/
def rangeLen {n : Nat} (s e : BitVec n) : BitVec n :=
  if e.slt s then 0
  else if (e - s).slt 0 || !(e - s).slt (maxNodes n) then maxNodes n + 1
  else e - s + 1

/-- The length that the code computed before the fix: `endNum-startNum+1`. -/
def oldRangeLen {n : Nat} (s e : BitVec n) : BitVec n := e - s + 1

/-- Sign extension by one bit: the integer value, with room to subtract. -/
abbrev Wide {n : Nat} (x : BitVec n) : BitVec (n + 1) := x.signExtend (n + 1)

/-- The true length of `s..e`, minus one, computed without wrapping. -/
abbrev span {n : Nat} (s e : BitVec n) : BitVec (n + 1) := Wide e - Wide s

section W64

/-- The old length wraps around: `0..maxInt` has a negative length. -/
example : (oldRangeLen (0 : BitVec 64) 0x7fffffffffffffff).slt 0 := by decide

theorem rangeLen_bounded_64 (s e : BitVec 64) :
    (0 : BitVec 64).sle (rangeLen s e) ∧ (rangeLen s e).sle (maxNodes 64 + 1) := by
  unfold rangeLen maxNodes; bv_decide

theorem rangeLen_reversed_64 (s e : BitVec 64) (h : e.slt s) : rangeLen s e = 0 := by
  unfold rangeLen maxNodes; bv_decide

theorem rangeLen_exact_64 (s e : BitVec 64) (h : s.sle e)
    (hlen : (span s e).slt (Wide (maxNodes 64))) :
    Wide (rangeLen s e) = span s e + 1 := by
  unfold rangeLen maxNodes at *; bv_decide

theorem rangeLen_capped_64 (s e : BitVec 64) (h : s.sle e)
    (hlen : ¬ (span s e).slt (Wide (maxNodes 64))) :
    rangeLen s e = maxNodes 64 + 1 := by
  unfold rangeLen maxNodes at *; bv_decide

/-- Every index of the loops, `startNum + k` for `0 ≤ k < rangeLen`, is
computed without overflow and lies in `startNum..endNum`. -/
theorem index_in_range_64 (s e k : BitVec 64)
    (hk0 : (0 : BitVec 64).sle k) (hk : k.slt (rangeLen s e)) :
    Wide (s + k) = Wide s + Wide k ∧ s.sle (s + k) ∧ (s + k).sle e := by
  unfold rangeLen maxNodes at *; bv_decide

/-- `checkRemainingBudget` adds the nodes counted so far (at most one past
the budget, where `incrementNodeCount` stops), the pending indices (within
the budget) and a range length: the sum cannot wrap. -/
theorem budget_sum_no_overflow_64 (count pending size : BitVec 64)
    (hc : (0 : BitVec 64).sle count ∧ count.sle (maxNodes 64 + 1))
    (hp : (0 : BitVec 64).sle pending ∧ pending.sle (maxNodes 64))
    (hs : (0 : BitVec 64).sle size ∧ size.sle (maxNodes 64 + 1)) :
    Wide (count + pending + size) = Wide count + Wide pending + Wide size := by
  unfold maxNodes at *; bv_decide

end W64

section W32

example : (oldRangeLen (0 : BitVec 32) 0x7fffffff).slt 0 := by decide

theorem rangeLen_bounded_32 (s e : BitVec 32) :
    (0 : BitVec 32).sle (rangeLen s e) ∧ (rangeLen s e).sle (maxNodes 32 + 1) := by
  unfold rangeLen maxNodes; bv_decide

theorem rangeLen_reversed_32 (s e : BitVec 32) (h : e.slt s) : rangeLen s e = 0 := by
  unfold rangeLen maxNodes; bv_decide

theorem rangeLen_exact_32 (s e : BitVec 32) (h : s.sle e)
    (hlen : (span s e).slt (Wide (maxNodes 32))) :
    Wide (rangeLen s e) = span s e + 1 := by
  unfold rangeLen maxNodes at *; bv_decide

theorem rangeLen_capped_32 (s e : BitVec 32) (h : s.sle e)
    (hlen : ¬ (span s e).slt (Wide (maxNodes 32))) :
    rangeLen s e = maxNodes 32 + 1 := by
  unfold rangeLen maxNodes at *; bv_decide

theorem index_in_range_32 (s e k : BitVec 32)
    (hk0 : (0 : BitVec 32).sle k) (hk : k.slt (rangeLen s e)) :
    Wide (s + k) = Wide s + Wide k ∧ s.sle (s + k) ∧ (s + k).sle e := by
  unfold rangeLen maxNodes at *; bv_decide

theorem budget_sum_no_overflow_32 (count pending size : BitVec 32)
    (hc : (0 : BitVec 32).sle count ∧ count.sle (maxNodes 32 + 1))
    (hp : (0 : BitVec 32).sle pending ∧ pending.sle (maxNodes 32))
    (hs : (0 : BitVec 32).sle size ∧ size.sle (maxNodes 32 + 1)) :
    Wide (count + pending + size) = Wide count + Wide pending + Wide size := by
  unfold maxNodes at *; bv_decide

end W32

end NodeBudget
