// ── Reddit JSON API (no auth required for reading public data) ──────

const REDDIT_BASE = "https://www.reddit.com";

export interface RedditPost {
  id: string;
  name: string; // fullname e.g. "t3_abc123"
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  subreddit: string;
  author: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  created_utc: number;
  is_self: boolean;
  over_18: boolean;
  link_flair_text: string | null;
  thumbnail: string | null;
}

export interface RedditComment {
  id: string;
  name: string;
  body: string;
  author: string;
  score: number;
  created_utc: number;
  parent_id: string;
  link_id: string;
  permalink: string;
  replies: RedditComment[];
}

export interface SubredditInfo {
  name: string;
  display_name: string;
  title: string;
  public_description: string;
  subscribers: number;
  active_user_count: number | null;
  icon_img: string;
  banner_img: string;
  created_utc: number;
}

// ── Fetch helpers ───────────────────────────────────────────────────

async function redditFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${REDDIT_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Reddit API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ── Parse Reddit listing response ───────────────────────────────────

interface RedditListing<T> {
  kind: "Listing";
  data: {
    children: { kind: string; data: T }[];
    after: string | null;
    before: string | null;
  };
}

function extractListingItems<T>(listing: RedditListing<T>): T[] {
  return listing.data.children.map((c) => c.data);
}

// ── API ─────────────────────────────────────────────────────────────

export const reddit = {
  /** Get hot posts from a subreddit */
  getHot: async (subreddit: string, limit = 25): Promise<RedditPost[]> => {
    const listing = await redditFetch<RedditListing<RedditPost>>(
      `/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`
    );
    return extractListingItems(listing);
  },

  /** Get new posts from a subreddit */
  getNew: async (subreddit: string, limit = 25): Promise<RedditPost[]> => {
    const listing = await redditFetch<RedditListing<RedditPost>>(
      `/r/${subreddit}/new.json?limit=${limit}&raw_json=1`
    );
    return extractListingItems(listing);
  },

  /** Get subreddit info */
  getSubredditInfo: async (name: string): Promise<SubredditInfo> => {
    const res = await redditFetch<{ data: SubredditInfo }>(
      `/r/${name}/about.json?raw_json=1`
    );
    return res.data;
  },

  /** Get comments for a post */
  getComments: async (
    subreddit: string,
    postId: string,
    limit = 50
  ): Promise<RedditComment[]> => {
    // Reddit returns [post_listing, comments_listing]
    const res = await redditFetch<RedditListing<unknown>[]>(
      `/r/${subreddit}/comments/${postId}.json?limit=${limit}&raw_json=1`
    );
    if (res.length < 2) return [];
    return extractComments(res[1] as RedditListing<RawComment>);
  },

  /** Search for subreddits */
  searchSubreddits: async (query: string, limit = 10): Promise<SubredditInfo[]> => {
    const listing = await redditFetch<RedditListing<SubredditInfo>>(
      `/subreddits/search.json?q=${encodeURIComponent(query)}&limit=${limit}&raw_json=1`
    );
    return extractListingItems(listing);
  },

  /** Get popular subreddits */
  getPopularSubreddits: async (limit = 25): Promise<SubredditInfo[]> => {
    const listing = await redditFetch<RedditListing<SubredditInfo>>(
      `/subreddits/popular.json?limit=${limit}&raw_json=1`
    );
    return extractListingItems(listing);
  },
};

// ── Comment parsing (Reddit nests these weirdly) ────────────────────

interface RawComment {
  id: string;
  name: string;
  body?: string;
  author?: string;
  score?: number;
  created_utc?: number;
  parent_id?: string;
  link_id?: string;
  permalink?: string;
  replies?: RedditListing<RawComment> | "";
}

function extractComments(listing: RedditListing<RawComment>): RedditComment[] {
  const items = extractListingItems(listing);
  return items
    .filter((c) => c.body && c.author)
    .map((c) => ({
      id: c.id,
      name: c.name,
      body: c.body!,
      author: c.author!,
      score: c.score ?? 0,
      created_utc: c.created_utc ?? 0,
      parent_id: c.parent_id ?? "",
      link_id: c.link_id ?? "",
      permalink: c.permalink ?? "",
      replies:
        c.replies && typeof c.replies !== "string"
          ? extractComments(c.replies)
          : [],
    }));
}

// ── Saved subreddits (localStorage) ─────────────────────────────────

const SAVED_SUBS_KEY = "gravitas_subreddits";

export function getSavedSubreddits(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_SUBS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSubreddits(subs: string[]): void {
  localStorage.setItem(SAVED_SUBS_KEY, JSON.stringify(subs));
}
