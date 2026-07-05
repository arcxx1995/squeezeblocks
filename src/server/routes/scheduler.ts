import { Hono } from 'hono';
import { sweepDueGames } from '../core/game';
import { broadcast, notifyNextTurn, notifyTurnExpiring } from '../core/notify';
import { claimDailyPost, releaseDailyPost, today } from '../core/daily';
import { createDailyPost } from '../core/post';

export const scheduler = new Hono();

// Daily cron (00:00 UTC, see devvit.json): create a fresh daily challenge post
// (not stickied — it sits below the pinned main post). Idempotent — the day's
// claim guards against a double-fire.
scheduler.post('/daily', async (c) => {
  const date = today();
  if (!(await claimDailyPost(date))) return c.json({ status: 'skipped' });
  try {
    await createDailyPost(date);
  } catch (error) {
    console.error('daily post cron failed:', error);
    await releaseDailyPost(date); // let the next sweep retry
    return c.json({ status: 'error' }, 500);
  }
  return c.json({ status: 'ok' });
});

// Cron-driven turn sweep (see devvit.json scheduler.tasks). Advances bot turns
// and system-skips expired human turns for every due game, then pushes the new
// state to watchers and DMs whoever is up next.
scheduler.post('/sweep', async (c) => {
  const now = Date.now();
  const changed = await sweepDueGames(now);
  for (const swept of changed) {
    if (swept.kind === 'reminder') {
      void notifyTurnExpiring(swept.game); // no state change → no broadcast
    } else {
      await broadcast(swept.game, swept.revealOrder);
      void notifyNextTurn(swept.game, swept.previousPlayerId);
    }
  }
  return c.json({ status: 'ok', swept: changed.length });
});
