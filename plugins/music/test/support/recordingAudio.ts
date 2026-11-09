import { createComposer, type ComposerClock } from '../../client/composer/composer.ts';
import { DEFAULT_TUNING, type ComposerTuning } from '../../client/composer/tuning.ts';

interface AutomationEvent {
  readonly kind: string;
  readonly value: number;
  readonly time: number;
}

class RecordingParam {
  value = 0;
  events: AutomationEvent[] = [];

  private record(kind: string, value: number, time: number): void {
    this.value = value;
    this.events.push({ kind, value, time });
  }

  setValueAtTime(value: number, time: number): void { this.record('set', value, time); }
  linearRampToValueAtTime(value: number, time: number): void { this.record('linear', value, time); }
  exponentialRampToValueAtTime(value: number, time: number): void { this.record('exponential', value, time); }
  setTargetAtTime(value: number, time: number): void { this.record('target', value, time); }
  cancelScheduledValues(time: number): void { this.events = this.events.filter((event) => event.time < time); }
}

export class RecordingNode {
  readonly kind: string;
  readonly gain = new RecordingParam();
  readonly frequency = new RecordingParam();
  readonly detune = new RecordingParam();
  readonly Q = new RecordingParam();
  startTime: number | null = null;
  stopTime: number | null = null;
  onended: (() => void) | null = null;
  destination: RecordingNode | null = null;
  ended = false;
  disconnected = false;

  constructor(kind: string) { this.kind = kind; }
  connect(destination: RecordingNode): void { this.destination = destination; }
  disconnect(): void { this.disconnected = true; }
  start(time: number): void { this.startTime = time; }
  stop(time: number): void { this.stopTime = time; }

  asAudioNode(): AudioNode { return this as unknown as AudioNode; }
}

export class RecordingAudioContext {
  currentTime = 0;
  readonly nodes: RecordingNode[] = [];

  private create(kind: string): RecordingNode {
    const node = new RecordingNode(kind);
    this.nodes.push(node);
    return node;
  }

  createGain(): RecordingNode { return this.create('gain'); }
  createBiquadFilter(): RecordingNode { return this.create('filter'); }
  createOscillator(): RecordingNode { return this.create('oscillator'); }
  asAudioContext(): AudioContext { return this as unknown as AudioContext; }

  advance(time: number): void {
    this.currentTime = time;
    for (const node of this.nodes) {
      if (!node.ended && node.stopTime !== null && node.stopTime <= time) {
        node.ended = true;
        node.onended?.();
      }
    }
  }
}

export function createHarness(tuning: ComposerTuning = DEFAULT_TUNING) {
  const context = new RecordingAudioContext();
  let interval: (() => void) | null = null;
  const clock: ComposerClock = {
    setInterval(handler) {
      interval = handler;
      return () => { interval = null; };
    },
    setTimeout: () => () => {},
  };
  const composer = createComposer(context.asAudioContext(), new RecordingNode('destination').asAudioNode(), 1, tuning, clock);
  composer.start();
  return {
    context,
    composer,
    tick(time: number): void {
      context.advance(time);
      if (interval === null) throw new Error('Composer scheduler is stopped');
      interval();
    },
  };
}
