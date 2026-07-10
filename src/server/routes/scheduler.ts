import { Hono } from 'hono';
import { dueAbandonedLobbies, dueDonePosts, ensureStatsRecorded, purgeGame, resetToLobby, sweepDueGames } from '../core/game';
import { broadcast, notifyNextTurn, notifyTurnExpiring } from '../core/notify';
import { today } from '../core/daily';
import { createDailyPost, createOrReuseMainPost, ensureTodayDaily, getMainPostId, isPostLive, removePost } from '../core/post';

export const scheduler = new Hono();

// Daily cron (00:00 UTC, see devvit.json): create a fresh daily challenge post
// (not stickied — it sits below the pinned main post). Idempotent — the day's
// claim guards against a double-fire.
scheduler.post('/daily', async (c) => {
  const date = today();
  // Also re-assert the pinned hub daily, so there's always exactly one and it
  // keeps slot 1 even if the pin was lost. Idempotent (reuses the live hub).
  try {
    await createOrReuseMainPost();
  } catch (error) {
    console.error('hub ensure on daily cron failed:', error);
  }
  // createDailyPost owns the atomic once-per-day claim now, so a double-fire (or
  // a 00:00 sweep tick coinciding) is deduped inside it — null means already made.
  try {
    const post = await createDailyPost(date);
    return c.json({ status: post ? 'ok' : 'skipped' });
  } catch (error) {
    console.error('daily post cron failed:', error); // claim already freed inside
    return c.json({ status: 'error' }, 500);
  }
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

  // Prune clutter. Never remove the hub.
  const mainPostId = await getMainPostId();
  let cleaned = 0;
  // Finished games: remove the post; but if a game finished ON the hub, reset it
  // to a fresh lobby so the community-highlights entry stays usable.
  for (const postId of await dueDonePosts(now)) {
    if (postId === mainPostId) {
      await resetToLobby(postId);
      cleaned += 1;
    } else if (!(await ensureStatsRecorded(postId))) {
      continue; // stats/ELO not booked yet — keep the post, retry next tick
    } else if (await removePost(postId)) {
      await purgeGame(postId); // only drop tracking once the post is truly gone
      cleaned += 1;
    }
  }
  // Abandoned lobbies: remove. Skip the hub entirely — its createdAt is ancient,
  // so it always reads "stale"; a player waiting on it must not be wiped.
  for (const postId of await dueAbandonedLobbies(now)) {
    if (postId === mainPostId) continue;
    if (await removePost(postId)) {
      await purgeGame(postId);
      cleaned += 1;
    }
  }

  // Self-heal the essentials so the sub always has exactly one pinned hub and
  // today's daily — even right after a delete-all. Hub only (re)created when
  // missing, so we don't re-pin every tick.
  if (!mainPostId || !(await isPostLive(mainPostId))) {
    try {
      await createOrReuseMainPost();
    } catch (error) {
      console.error('hub self-heal failed:', error);
    }
  }
  try {
    await ensureTodayDaily();
  } catch (error) {
    console.error('daily self-heal failed:', error);
  }

  return c.json({ status: 'ok', swept: changed.length, cleaned });
});
