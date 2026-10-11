import { FLIGHT_SECONDS, type ApacheFlight } from '../protocol.ts';

const RENDER_DELAY = 0.1;
const STALE_SECONDS = 1.5;

export class FlightPlayback {
  flight: ApacheFlight | null = null;
  elapsed = 0;
  visibleSeconds = 0;
  private receivedAt = 0;
  private lastFrameAt = 0;

  receive(flight: ApacheFlight | null, now: number): void {
    if (flight === null) {
      this.clear();
      return;
    }
    if (this.flight?.id !== flight.id || now - this.receivedAt > STALE_SECONDS) {
      this.elapsed = Math.max(0, flight.elapsed - RENDER_DELAY);
      this.visibleSeconds = 0;
      this.lastFrameAt = now;
    }
    this.flight = flight;
    this.receivedAt = now;
  }

  advance(now: number): boolean {
    if (this.flight === null) return false;
    const sinceMessage = Math.max(0, now - this.receivedAt);
    if (sinceMessage > STALE_SECONDS) return false;
    const dt = Math.max(0, now - this.lastFrameAt);
    this.lastFrameAt = now;
    const target = Math.max(0, this.flight.elapsed + sinceMessage - RENDER_DELAY);
    if (dt > 0.5) {
      // Returning from a suspended tab or snapshot hold resumes the current server pass.
      this.elapsed = target;
      this.visibleSeconds = 0;
    } else {
      const error = target - (this.elapsed + dt);
      // Correct clock drift by at most 15% of flight speed; never reverse or snap on a packet.
      this.elapsed += dt + Math.max(-dt * 0.15, Math.min(dt * 0.15, error * (1 - Math.exp(-dt * 4))));
      this.visibleSeconds += dt;
    }
    return this.elapsed < FLIGHT_SECONDS;
  }

  signalFade(now: number): number {
    return Math.min(1, this.visibleSeconds / 0.4, Math.max(0, (STALE_SECONDS - (now - this.receivedAt)) / 0.4));
  }

  clear(): void {
    this.flight = null;
    this.elapsed = 0;
    this.visibleSeconds = 0;
    this.receivedAt = 0;
    this.lastFrameAt = 0;
  }
}
