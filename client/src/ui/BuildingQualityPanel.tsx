import { Show, type JSX } from 'solid-js';
import { frameRate } from '../state/hudState.ts';
import {
  buildingQuality, buildingQualityError, buildingQualityLoading, setBuildingQuality,
} from '../state/buildingQualityPrefs.ts';

export function BuildingQualityPanel(): JSX.Element {
  return (
    <div class="controls-panel">
      <div class="hud-row controls-row">
        <span class="controls-label">Buildings</span>
        <select class="controls-select" aria-label="Building model and texture quality"
          value={buildingQuality()} disabled={buildingQualityLoading()}
          onChange={(event) => {
            const quality = event.currentTarget.value;
            if (quality === 'low' || quality === 'original') void setBuildingQuality(quality);
            event.currentTarget.value = buildingQuality();
          }}>
          <option value="low">Low · 1024 textures</option>
          <option value="original">Original · 2048 textures</option>
        </select>
      </div>
      <p class="controls-hint" role="status">
        {buildingQualityLoading() ? 'Loading buildings…' : `${buildingQuality() === 'low' ? 'Low' : 'Original'} buildings active`}
        <Show when={frameRate() !== null}> · {frameRate()} fps</Show>
      </p>
      <p class="controls-hint">Switches models and compressed textures in place. Keep the camera still and let FPS settle to compare.</p>
      <Show when={buildingQualityError()}><p class="controls-hint" role="alert">{buildingQualityError()}</p></Show>
    </div>
  );
}
