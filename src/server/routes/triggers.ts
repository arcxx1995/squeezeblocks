import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { context, redis } from '@devvit/web/server';
import { createDailyPost, createOrReuseMainPost, SETUP_KEY } from '../core/post';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  try {
    const input = await c.req.json<OnAppInstallRequest>();

    // Devvit re-fires onAppInstall on EVERY version install — including each
    // playtest hot-reload (version bumps .2 → .4 → .8…). The old handler ran
    // deleteAllPosts() here, so every reload mod-removed every post in the sub:
    // any post you were viewing — or a new-match/rematch post you'd just made —
    // showed "moderator deleted this post". Guard so first-install setup runs
    // once and later installs no-op. Manual clearing still lives on the mod menu.
    // ponytail: get→set, not atomic — fine for a non-concurrent install trigger.
    if (await redis.get(SETUP_KEY)) {
      return c.json<TriggerResponse>({ status: 'success', message: 'already set up' }, 200);
    }
    await redis.set(SETUP_KEY, '1');

    // The single community-highlights hub, pinned to slot 1. Daily posts are not
    // stickied, so they land in the normal feed below it.
    const mainPostId = await createOrReuseMainPost();
    // Also stand up the daily-challenge post. Best-effort: a failure here
    // must not fail the install (the mod menu can create it later).
    try {
      await createDailyPost();
    } catch (error) {
      console.error('daily post on install failed:', error);
    }

    return c.json<TriggerResponse>(
      {
        status: 'success',
        message: `Hub post ${mainPostId} in ${context.subredditName} (trigger: ${input.type})`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<TriggerResponse>(
      {
        status: 'error',
        message: 'Failed to create post',
      },
      400
    );
  }
});
