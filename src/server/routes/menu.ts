import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createDailyPost, createPost, deleteAllPosts, postCommentUrl } from '../core/post';
import { today } from '../core/daily';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    const post = await createPost();
    // Mod-created post is the main app post — pin it to the top (slot 1) so it
    // sits above the daily. This is the re-pin lever: a same-version reinstall
    // no-ops (won't re-fire onAppInstall), so the menu is the only way to
    // re-establish the top pin. Best-effort: needs mod, must not fail the post.
    try {
      await post.sticky(1);
    } catch (error) {
      console.error('post-create sticky failed:', error);
    }

    return c.json<UiResponse>(
      {
        navigateTo: postCommentUrl(post.id, context.subredditName),
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
    const post = await createDailyPost(today());
    return c.json<UiResponse>(
      { navigateTo: postCommentUrl(post.id, context.subredditName) },
      200
    );
  } catch (error) {
    console.error(`Error creating daily post: ${error}`);
    return c.json<UiResponse>({ showToast: 'Failed to create daily post' }, 400);
  }
});
