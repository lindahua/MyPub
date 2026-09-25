import type { ProgressEvent } from "../core/types.js";

export class ProgressPrinter {
  private activeLine = false;
  private lastMilestone = new Map<string, number>();

  constructor(
    private readonly write: (text: string) => void,
    private readonly interactive: boolean,
  ) {}

  report(event: ProgressEvent): void {
    if (event.percent === undefined) {
      this.finish();
      this.write(`${event.message}\n`);
      return;
    }

    if (this.interactive) {
      this.write(`\r\x1b[2K${event.message}`);
      this.activeLine = true;
      return;
    }

    const milestone = Math.floor(event.percent / 10);
    if (event.percent === 100 || milestone > (this.lastMilestone.get(event.phase) ?? -1)) {
      this.write(`${event.message}\n`);
      this.lastMilestone.set(event.phase, milestone);
    }
  }

  finish(): void {
    if (this.activeLine) {
      this.write("\n");
      this.activeLine = false;
    }
  }
}
