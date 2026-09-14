export type DiffPart = { kind: "same" | "del" | "add"; text: string };

/**
 * Word-level diff (LCS over whitespace-separated tokens, whitespace kept with its word). Final answers are
 * a few hundred characters, so the quadratic table is trivially small.
 */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.match(/\S+\s*/g) ?? [];
  const B = b.match(/\S+\s*/g) ?? [];
  const key = (t: string) => t.trim();
  const n = A.length;
  const m = B.length;
  const T: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) T[i][j] = key(A[i]) === key(B[j]) ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);

  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(A[i]) === key(B[j])) {
      push("same", B[j]);
      i++;
      j++;
    } else if (T[i + 1][j] >= T[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}
