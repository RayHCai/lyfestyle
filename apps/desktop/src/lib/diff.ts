export interface DiffLine {
    /** ' ' kept, '+' added, '-' removed. */
    kind: ' ' | '+' | '-';
    text: string;
}

/** Inputs whose line counts multiply past this skip the diff; the table would be too big. */
const MAX_CELLS = 1_000_000;

/** Line diff by longest common subsequence, or null when the inputs are too big to compare. */
export function diffLines(before: string, after: string): DiffLine[] | null {
    const a = before.replace(/\n$/, '').split('\n');
    const b = after.replace(/\n$/, '').split('\n');
    if (a.length * b.length > MAX_CELLS) return null;
    // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
    for (let i = a.length - 1; i >= 0; i--) {
        const row = lcs[i];
        if (!row) continue;
        for (let j = b.length - 1; j >= 0; j--)
            row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        const x = a[i];
        const y = b[j];
        if (x !== undefined && y !== undefined && x === y) {
            out.push({ kind: ' ', text: x });
            i++;
            j++;
        } else if (y !== undefined && (x === undefined || at(i, j + 1) >= at(i + 1, j))) {
            out.push({ kind: '+', text: y });
            j++;
        } else if (x !== undefined) {
            out.push({ kind: '-', text: x });
            i++;
        }
    }
    return out;
}
