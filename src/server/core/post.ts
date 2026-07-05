import { reddit, context } from '@devvit/web/server';
import { createGame } from './game';
import { markDailyPost } from './daily';

// Reddit thing-ids (post.id, context.postId) are `t3_`-prefixed; comment URLs
// need the bare id. Single source of truth for the strip — three call sites
// (menu, /new-game, turn DM) previously handled this inconsistently.
export const postCommentUrl = (id: string, subredditName?: string): string => {
  const bare = id.replace(/^t3_/, '');
  return subredditName
    ? `https://www.reddit.com/r/${subredditName}/comments/${bare}`
    : `https://www.reddit.com/comments/${bare}`;
};

export const createPost = async () => {
  const post = await reddit.submitCustomPost({
    title: 'squeezeblocks',
  });
  // Seed the lobby so the first visitors can join immediately.
  await createGame(post.id);
  return post;
};

// Nukes every post in the subreddit — for the app's dedicated test sub where
// all posts are app posts. Mod-removes each (title is immutable, so recreating
// is the only way to fix an old title). Returns the count removed.
// ponytail: removes ALL posts, not just app-authored ones — fine on a dedicated
// dev sub, guard by author if this ever runs on a shared subreddit.
export const deleteAllPosts = async (): Promise<number> => {
  const posts = await reddit
    .getNewPosts({
      subredditName: context.subredditName!,
      limit: 1000,
    })
    .all();
  for (const post of posts) {
    await post.remove(false);
  }
  return posts.length;
};

// The daily-challenge post: opens straight into the daily. Marked so the client
// skips the lobby. Pinned to sticky slot 2 — the main app post owns slot 1, so
// the daily sits directly below it deterministically (unstickied would float
// above the app by recency whenever the app's slot-1 pin fails). `date`
// (YYYY-MM-DD) is appended to the title so auto-posted days are distinguishable.
export const createDailyPost = async (date?: string) => {
  const post = await reddit.submitCustomPost({
    title: `squeezeblocks — Daily Challenge 🔥${date ? ` (${date})` : ''}`,
  });
  await markDailyPost(post.id);
  // Best-effort: needs mod. Slot 2 keeps it below the app's slot-1 pin.
  try {
    await post.sticky(2);
  } catch (error) {
    console.error('daily post sticky failed:', error);
  }
  return post;
};
