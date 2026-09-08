import { For, Show, type JSX } from 'solid-js';
import { frameDraw, frameRate, frameStats, perfOpen, serverVersion } from '../state/hudState.ts';
import { pluginDrawRows } from '../plugins/hudPanels.ts';

const CLIENT_VERSION: string =
  typeof __CLIENT_VERSION__ === 'string' ? __CLIENT_VERSION__ : 'unversioned';

const MIN_PRINTABLE_FPS = 1;

function asFps(ms: number): string {
  if (ms <= 0) return '';
  const fps = 1000 / ms;
  return fps < MIN_PRINTABLE_FPS ? '<1 fps' : `${String(Math.round(fps))} fps`;
}

function PerfMsRow(props: { label: string; ms: number }): JSX.Element {
  const fps = (): string => asFps(props.ms);
  return (
    <PerfRow
      label={props.label}
      value={`${props.ms.toFixed(2)} ms${fps() === '' ? '' : ` (${fps()})`}`}
    />
  );
}

function PerfRow(props: { label: string; value: string }): JSX.Element {
  return (
    <span class="hud-version__perf">
      <span class="hud-version__perf-label">{props.label}</span>
      <span>{props.value}</span>
    </span>
  );
}

export function VersionWatermark(): JSX.Element {
  const mismatch = (): boolean =>
    serverVersion() !== null && serverVersion() !== CLIENT_VERSION;
  return (
    <div class="hud-version" classList={{ 'hud-version--mismatch': mismatch() }}>
      <span>cli {CLIENT_VERSION}</span>
      <Show when={serverVersion()}>{(v) => <span>srv {v()}</span>}</Show>
      {
}
      <Show when={frameRate() !== null}>
        <span class="hud-version__fps">{frameRate()} fps</span>
      </Show>
      {
}
      <Show when={frameDraw()}>
        {(draw) => (
          <span
            class="hud-version__draw"
            classList={{
              'hud-version__draw--over': draw().objects > draw().budget,
            }}
          >
            {draw().objects}/{draw().budget} objects · {draw().calls} calls
          </span>
        )}
      </Show>
      {

}
      <Show when={perfOpen() ? frameStats() : null}>
        {(stat) => (

          <div class="hud-version__perf-panel">
            {

}
            <PerfRow label="up" value={`${Math.round(stat().uptimeS)}s`} />
            <PerfRow label="frames" value={String(stat().frames)} />
            <PerfRow
              label="pixels"
              value={`${stat().counters.pixelWidth}x${stat().counters.pixelHeight}`}
            />
            {
}
            <PerfMsRow label="render" ms={stat().renderMsP50} />
            <PerfMsRow label="outside" ms={stat().outsideMsP50} />
            <PerfMsRow label="frame" ms={stat().frameMsP50} />
            <PerfMsRow label="p99" ms={stat().frameMsP99} />
            <PerfMsRow label="max" ms={stat().frameMsMax} />
            <PerfMsRow label="interval" ms={stat().intervalMsP50} />
            {
}
            <Show when={stat().gpuMsP50 !== null} fallback={<PerfRow label="gpu" value="unavailable" />}>
              <PerfMsRow label="gpu" ms={stat().gpuMsP50 ?? 0} />
            </Show>
            {
}
            <PerfRow label="camera" value={stat().counters.cameraDistance.toFixed(0)} />
            <PerfRow label="draws" value={String(stat().counters.drawCalls)} />
            <PerfRow
              label="triangles"
              value={`${(stat().counters.triangles / 1e6).toFixed(2)} M`}
            />
            <PerfRow label="geometries" value={String(stat().counters.geometries)} />
            <PerfRow label="textures" value={String(stat().counters.textures)} />
            <PerfRow label="programs" value={String(stat().counters.programs)} />
            {

}
            <For each={stat().plugins}>
              {(row) => (
                <PerfRow
                  label={row.name}
                  value={`${row.msPerFrame.toFixed(2)} ms (${String(Math.round(row.shareOfFrame * 100))}%)`}
                />
              )}
            </For>
          </div>
        )}
      </Show>
      {
}
      <For each={pluginDrawRows().filter((row) => row.breached)}>
        {(row) => (
          <span class="hud-version__draw hud-version__draw--over">
            {row.pluginName} {row.objects}/{row.budget}
          </span>
        )}
      </For>
      <Show when={mismatch()}>
        <span class="hud-version__flag">version skew — restart the stack</span>
      </Show>
    </div>
  );
}
