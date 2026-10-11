import { createSignal } from 'solid-js';

const [chartOpen, setChartOpenSignal] = createSignal(false);

export { chartOpen };

export function setChartOpen(open: boolean): void {
  setChartOpenSignal(open);
}
