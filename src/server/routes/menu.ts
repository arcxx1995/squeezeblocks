import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createDailyPost, createOrReuseMainPost, deleteAllPosts, isPostLive, postCommentUrl } from '../core/post';
import { getDailyPostId, today } from '../core/daily';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    // Reuse the single community-highlights hub (pinned to slot 1) if it's still
    // live; only make a fresh one when there isn't one. Repeat taps never spawn
    // duplicate hub posts. Also the re-pin lever if the pin was ever lost.
    const postId = await createOrReuseMainPost();
    return c.json<UiResponse>(
      {
        navigateTo: postCommentUrl(postId, context.subredditName),
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create post',
      },
      400
    );
  }
});

menu.post('/delete-all', async (c) => {
  try {
    const count = await deleteAllPosts();
    return c.json<UiResponse>({ showToast: `Removed ${count} post(s)` }, 200);
  } catch (error) {
    console.error(`Error deleting posts: ${error}`);
    return c.json<UiResponse>({ showToast: 'Failed to delete posts' }, 400);
  }
});

menu.post('/daily-create', async (c) => {
  try {
    const date = today();
    // Idempotent: if today's daily already exists and is still live, go to it
    // instead of spawning another (repeat taps used to litter the sub with
    // duplicate dailies). A removed one is remade so we never land on "removed
    // by moderator".
    const existing = await getDailyPostId(date);
    // createDailyPost returns null if another path (cron/sweep/second tap) won
    // the once-per-day claim first — fall back to the winner's tracked id so we
    // still navigate to today's daily instead of erroring.
    const postId =
      existing && (await isPostLive(existing))
        ? existing
        : ((await createDailyPost(date))?.id ?? (await getDailyPostId(date)));
    if (!postId) {
      return c.json<UiResponse>({ showToast: 'Daily challenge is being created — try again' }, 503);
    }
    return c.json<UiResponse>(
      { navigateTo: postCommentUrl(postId, context.subredditName) },
      200
    );
  } catch (error) {
    console.error(`Error creating daily post: ${error}`);
    return c.json<UiResponse>({ showToast: 'Failed to create daily post' }, 400);
  }
});
