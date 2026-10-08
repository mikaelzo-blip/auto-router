export function allocateMoney(totalCents: number, ratios: number[]): number[] {
  if (totalCents < 0) {
    throw new Error("totalCents must be non-negative");
  }
  if (!ratios || ratios.length === 0) {
    throw new Error("ratios must not be empty");
  }
  let sumRatios = 0;
  for (const r of ratios) {
    if (r < 0) throw new Error("ratios must be non-negative");
    sumRatios += r;
  }
  if (sumRatios <= 0) {
    throw new Error("sum of ratios must be positive");
  }

  if (totalCents === 0) {
    return new Array(ratios.length).fill(0);
  }

  const n = ratios.length;
  const results = new Array<number>(n);
  const remainders: Array<{ index: number; rem: number }> = [];

  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const unrounded = (totalCents * ratios[i]!) / sumRatios;
    const base = Math.floor(unrounded);
    results[i] = base;
    allocated += base;
    remainders.push({ index: i, rem: unrounded - base });
  }

  let remainderCents = totalCents - allocated;
  // Sort descending by remainder, tie-break by original index ascending
  remainders.sort((a, b) => b.rem - a.rem || a.index - b.index);

  for (let i = 0; i < remainderCents; i++) {
    const idx = remainders[i % n]!.index;
    results[idx]! += 1;
  }

  return results;
}
