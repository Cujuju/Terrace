// Operator-facing wording for world-admin refusals, shared by the Worlds
// panel (WorldManager.tsx) and the admin panel (AdminPanel.tsx) — one place,
// so the two screens never explain the same refusal in two ways.

import type { WorldAdminRefusal } from '@terrace/shared';

/** Plain-language reason, so the server never composes player-facing prose. */
export function refusalText(reason: WorldAdminRefusal): string {
  switch (reason) {
    case 'disabled':
      return 'This server has no world-admin key set. Set WORLD_ADMIN_KEY in its environment and restart it.';
    case 'badKey':
      return 'That key does not match this server’s WORLD_ADMIN_KEY.';
    case 'throttled':
      return 'Too many wrong keys. Wait a minute, then try again.';
    case 'unknownWorld':
      return 'That world is not on this server any more. Refresh the list.';
    case 'alreadyActive':
      return 'That world is already the one you are in.';
    case 'nameInUse':
      return 'A world of that name already exists. Nothing was overwritten — pick another name.';
    case 'invalidName':
      return 'That name has no usable letters or digits in it. Try another.';
    case 'invalidSize':
      return 'That world size is outside what this server allows, or is not a whole number of chunks.';
    case 'notArchived':
      return 'That world is not in the trash. Archive it first.';
    case 'confirmationMismatch':
      return 'The name you typed does not match the world’s name. Nothing was deleted.';
    case 'switchInProgress':
      return 'A world switch is already counting down. Cancel it first.';
    case 'restartInProgress':
      return 'A restart is already under way. There is nothing to cancel — wait for the server to come back.';
    case 'unknownPlugin':
      return 'This server has no plugin by that name any more. Reopen the plugin list.';
    case 'reloadFailed':
      return 'That plugin’s new code was rejected — the build that was running still is. The server log says which step failed.';
    case 'reloadLeftNoWorld':
      return 'That plugin’s new code was rejected, and the world could not be reopened over the old one either — no world is loaded now. Load one again; the server log says what failed.';
    case 'unknownSetting':
      return 'That plugin does not offer that setting, or does not accept that value. Reopen the plugin list.';
    case 'unknownAction':
      return 'That plugin does not offer that action any more. Reopen the admin panel.';
    case 'pluginDisabled':
      return 'That plugin is switched off for this world. Enable it in the Worlds panel first.';
    case 'actionDeclined':
      return 'The plugin found nothing to do — its own note says why.';
    case 'worldIsActive':
      return 'That world is loaded right now. Switch to another world (or unload) first.';
    case 'noWorldLoaded':
      return 'No world is loaded, so there was nothing to do.';
    case 'noSwitchPending':
      return 'There was no switch counting down.';
    case 'failed':
      return 'The server could not complete that. Nothing was destroyed — check the server log.';
  }
}

