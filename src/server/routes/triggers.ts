import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnCommentCreateRequest,
  OnPostDeleteRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { context, redis } from '@devvit/web/server';
import { createDailyPost, createOrReuseMainPost, SETUP_KEY } from '../core/post';
import { purgeGame } from '../core/game';
import { flairCommenter } from '../core/stats';
import { forgetDailyPost, getDailyPostId, unmarkDailyPost } from '../core/daily';

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

// Every commenter in the sub gets (or refreshes) their live ELO flair — so a
// rating shows up from engaging, not only from finishing a game.
triggers.post('/on-comment-create', async (c) => {
  try {
    const input = await c.req.json<OnCommentCreateRequest>();
    const username = input.author?.name;
    if (username) await flairCommenter(username);
    return c.json<TriggerResponse>(
      { status: 'success', message: `flaired ${username ?? 'unknown'}` },
      200
    );
  } catch (error) {
    console.error(`on-comment-create flair failed: ${error}`);
    return c.json<TriggerResponse>({ status: 'error', message: 'Failed to flair commenter' }, 400);
  }
});

// Devvit rules require deleting a post's app data when the post is deleted.
// purgeGame drops the game state (seats/usernames/moves), matchmaking and
// scheduler registrations, and the per-seat booking hash; daily posts also
// shed their flag and, if it's the tracked daily, the day's post-id claim so
// the cron can mint a replacement.
triggers.post('/on-post-delete', async (c) => {
  try {
    const input = await c.req.json<OnPostDeleteRequest>();
    const postId = input.postId;
    await purgeGame(postId);
    await unmarkDailyPost(postId);
    if ((await getDailyPostId()) === postId) await forgetDailyPost();
    return c.json<TriggerResponse>({ status: 'success', message: `purged ${postId}` }, 200);
  } catch (error) {
    console.error(`on-post-delete purge failed: ${error}`);
    return c.json<TriggerResponse>({ status: 'error', message: 'Failed to purge post data' }, 400);
  }
});
