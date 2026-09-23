import { createWorkshop, surfaceArraysOf, type SurfaceArrays } from './geometry.ts';
import {
  buildTemplate,
  templateSurfaceTransfers,
  type TemplateKey,
  type TemplateSurfaces,
} from './models.ts';

// Runs the same template factory the main thread runs, keeping only its organic surfaces.
self.onmessage = (event: MessageEvent<TemplateKey>): void => {
  const key = event.data;
  const surfaces: Array<readonly [string, SurfaceArrays]> = [];
  const workshop = createWorkshop({
    record: (surfaceKey, geometry) => surfaces.push([surfaceKey, surfaceArraysOf(geometry)]),
  });
  buildTemplate(workshop, key);
  workshop.dispose();
  const answer: TemplateSurfaces = { key, surfaces };
  (self as unknown as Worker).postMessage(answer, templateSurfaceTransfers(answer));
};
