/** لغو شبکه به‌تنهایی کافی نیست؛ پاسخِ در حال پردازش هم باید کنار گذاشته شود. */
export class RequestSequence {
  private generation = 0;
  private controller: AbortController | null = null;

  cancel() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  begin() {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return { signal: controller.signal, current: () => generation === this.generation && !controller.signal.aborted };
  }
}
