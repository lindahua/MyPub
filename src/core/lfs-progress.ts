/** Equal-weight progress across the files selected for one Git LFS operation. */
export class LfsProgressTracker {
  private readonly ratios = new Map<string, number>();
  private lastPercent = 0;
  private ratioSum = 0;

  constructor(
    private readonly direction: "checkout" | "download" | "upload",
    names: readonly string[],
  ) {
    for (const name of names) this.ratios.set(name, 0);
  }

  accept(line: string): number | undefined {
    const match = /^(checkout|download|upload) (\d+)\/(\d+) (\d+)\/(\d+) (.+)$/.exec(line);
    if (!match || match[1] !== this.direction) return;
    const name = match[6]!;
    if (!this.ratios.has(name)) return;
    const bytes = Number(match[4]), size = Number(match[5]);
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(size)) return;
    const ratio = size === 0 ? 1 : Math.min(1, bytes / size);
    const previous = this.ratios.get(name)!;
    if (ratio > previous) {
      this.ratios.set(name, ratio);
      this.ratioSum += ratio - previous;
    }
    return this.changedPercent();
  }

  finish(): number | undefined {
    for (const name of this.ratios.keys()) this.ratios.set(name, 1);
    this.ratioSum = this.ratios.size;
    return this.changedPercent();
  }

  private changedPercent(): number | undefined {
    if (!this.ratios.size) return;
    const percent = Math.min(100, Math.floor(this.ratioSum * 100 / this.ratios.size));
    if (percent <= this.lastPercent) return;
    this.lastPercent = percent;
    return percent;
  }
}
