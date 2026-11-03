/**
 * When Google truly cannot serve a model: the run's busy ledger.
 *
 * A Gemini call through the Antigravity SDK comes back `unavailable` when its own budget against Google is spent
 * (its refusals, or its stall tries). One such call is not enough to stop a run that Google is still serving: holds
 * hit single requests, not pools, and a resend usually answers in seconds. So the ledger keeps, per model, when a
 * call of it was last served and when the stretch of unserved calls since began (when the first of them was sent, not
 * when it came back: a held call is unserved from its start); a batch, a stage or the agent door stops on a model only
 * once that stretch has lasted the window (BUSY_WINDOW_SEC) with nothing served. Until then an unavailable call is a
 * bounded wait: not an attempt, never handed to another model, and sent again. A wait has a set end for each packet
 * too: one whose own calls were none of them served for the window, while other calls of the model were (so the run
 * goes on), ends as a failed dispatch with Google's reason (`unservedFor`).
 *
 * One ledger per run (server.ts), so every batch, stage and dispatch of the run reads the same account.
 */
import { BUSY_WINDOW_SEC } from "./executor/stall.js";

interface ModelAccount {
  lastServedAt: number | null;
  /** When the current stretch of unserved calls began (the first one sent after the last served call), or null. */
  unavailableSince: number | null;
  /** Google's reason for the stretch's latest unavailable call. */
  reason: string;
}

export class BusyLedger {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly accounts = new Map<string, ModelAccount>();

  constructor(o: { windowSec?: number; now?: () => number } = {}) {
    this.windowMs = (o.windowSec ?? BUSY_WINDOW_SEC) * 1000;
    this.now = o.now ?? Date.now;
  }

  private account(model: string): ModelAccount {
    let a = this.accounts.get(model);
    if (!a) { a = { lastServedAt: null, unavailableSince: null, reason: "" }; this.accounts.set(model, a); }
    return a;
  }

  /** The ledger's clock: a caller notes when it sends a call, and passes that to `unavailable`. */
  time(): number {
    return this.now();
  }

  /** A call of `model` was served (Google answered it, whatever the answer's own verdict). */
  served(model: string): void {
    const a = this.account(model);
    a.lastServedAt = this.now();
    a.unavailableSince = null;
  }

  /**
   * A call of `model`, sent at `sentAt` on the ledger's clock (default: now), came back unavailable with Google's
   * `reason`: the sentence that stops the run, once nothing of the model was served for the whole window while its
   * calls kept coming back unavailable; else null (a wait). A call served after this one was sent restarted the window.
   */
  unavailable(model: string, reason: string, sentAt?: number): string | null {
    const a = this.account(model);
    const now = this.now();
    if (a.unavailableSince === null) {
      const sent = Math.min(sentAt ?? now, now);
      a.unavailableSince = a.lastServedAt === null ? sent : Math.max(sent, a.lastServedAt);
    }
    a.reason = reason;
    return this.closed(model);
  }

  /**
   * The sentence that stops the run once `model`'s window has passed with its calls unavailable and nothing of it
   * served, else null. A call is sent again only while this is null: a caller that waited before a resend asks again.
   */
  closed(model: string): string | null {
    const a = this.accounts.get(model);
    if (!a || a.unavailableSince === null || this.now() - a.unavailableSince < this.windowMs) return null;
    const window = Math.round(this.windowMs / 1000);
    return `Google could not serve ${model}: ${a.reason}; no call of it was served for ${window} s`;
  }

  /**
   * The sentence that ends one packet or stage job (`what`) whose own calls of `model` have all come back unavailable
   * since `since` (when the first of them was sent, on the ledger's clock) for the whole window, with Google's latest
   * `reason`; else null. It ends that one only: the model's other calls were served meanwhile, or `closed` would have
   * stopped the run. Without it such a packet would be sent again for as long as its neighbours are served.
   */
  unservedFor(model: string, since: number | null, reason: string, what: "packet" | "job"): string | null {
    if (since === null || this.now() - since < this.windowMs) return null;
    const window = Math.round(this.windowMs / 1000);
    return `none of this ${what}'s calls was served for ${window} s, while other calls of ${model} were: ${reason}`;
  }
}
