import { logWarn } from '../log.ts';
import { handleSculptIntent, refuseFaultedSculpt } from '../intent/pipeline.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { LogThrottle, throttledLog } from './contain-message.ts';
import type { SculptRateLimiter } from './sculpt-rate-limit.ts';
import type { TerraceClient } from './room-contract.ts';

export interface SculptHandlerDeps {
  readonly manager: WorldManager;
  readonly rate: SculptRateLimiter;
  readonly rewriteLog: LogThrottle;
}

export function handleSculptMessage(
  deps: SculptHandlerDeps,
  client: TerraceClient,
  message: unknown,
): void {
  if (!deps.rate.allow(client.sessionId)) return;
  const player = client.userData?.player;
  if (!player) return;
  const session = deps.manager.current;
  if (session === null) return;
  const outcome = handleSculptIntent(
    { world: session.world, interceptors: session.host },
    player,
    message,
  );
  if (!outcome.applied && outcome.reason === 'plugin-modified-invalid') {
    notePluginRewriteFailure(deps.rewriteLog, outcome.detail);
  }
}

export function refuseSculptMessage(
  deps: Pick<SculptHandlerDeps, 'manager'>,
  client: TerraceClient,
  message: unknown,
): void {
  const session = deps.manager.current;
  if (session === null) return;
  refuseFaultedSculpt(session.world, message, (denial) => {
    client.send(denial.type, denial);
  });
}

function notePluginRewriteFailure(rewriteLog: LogThrottle, detail?: string): void {
  throttledLog(rewriteLog, () => {
    logWarn(
      'a plugin rewrote a sculpt intent into one core had to refuse ' +
        `(${detail ?? 'failed re-validation'}); those players cannot sculpt until it is fixed`,
    );
  });
}
