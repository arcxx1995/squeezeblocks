import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createDailyPost, createPost, deleteAllPosts } from '../core/post';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  try {
    // Clear leftover posts from a prior install (uninstall doesn't remove them),
    // so an old community-pinned daily can't linger above the fresh main post.
    try {
      await deleteAllPosts();
    } catch (error) {
      console.error('install cleanup failed:', error);
    }
    const post = await createPost();
    // Pin the main app post to the top (slot 1). Daily posts are not stickied,
    // so they land in the normal feed below it. Best-effort: needs mod, must not
    // fail the install.
    try {
      await post.sticky(1);
    } catch (error) {
      console.error('welcome post sticky failed:', error);
    }
    // Also stand up the daily-challenge post. Best-effort: a failure here
    // must not fail the install (the mod menu can create it later).
    try {
      await createDailyPost();
    } catch (error) {
      console.error('daily post on install failed:', error);
    }
    const input = await c.req.json<OnAppInstallRequest>();

    return c.json<TriggerResponse>(
      {
        status: 'success',
        message: `Post created in subreddit ${context.subredditName} with id ${post.id} (trigger: ${input.type})`,
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
