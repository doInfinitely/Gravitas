// ── Reddit JSON API (no auth required for reading public data) ──────

const REDDIT_BASE = "https://www.reddit.com";
const OAUTH_BASE = "https://oauth.reddit.com";

// ── Reddit OAuth2 ───────────────────────────────────────────────────

const CLIENT_ID = import.meta.env.VITE_REDDIT_CLIENT_ID ?? "";
const REDIRECT_URI = `${window.location.origin}/auth/callback`;
const SCOPES = "identity read submit";
const TOKEN_KEY = "gravitas_reddit_token";
const STATE_KEY = "gravitas_oauth_state";

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

function getStoredToken(): TokenData | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeToken(data: TokenData): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(data));
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function exchangeCode(code: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = await res.json();
  const token: TokenData = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  storeToken(token);
  return token;
}

async function refreshAccessToken(): Promise<TokenData | null> {
  const stored = getStoredToken();
  if (!stored?.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
  });
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    clearToken();
    return null;
  }
  const json = await res.json();
  const token: TokenData = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? stored.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  storeToken(token);
  return token;
}

async function getValidToken(): Promise<string | null> {
  let token = getStoredToken();
  if (!token) return null;
  if (Date.now() > token.expires_at - 60_000) {
    token = await refreshAccessToken();
  }
  return token?.access_token ?? null;
}

async function oauthFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getValidToken();
  if (!accessToken) throw new Error("Not authenticated");
  const res = await fetch(`${OAUTH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`OAuth API error: ${res.status}`);
  return res.json();
}

export interface RedditUser {
  name: string;
  icon_img: string;
  total_karma: number;
}

export const auth = {
  login(): void {
    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      state,
      redirect_uri: REDIRECT_URI,
      duration: "permanent",
      scope: SCOPES,
    });
    window.location.href = `https://www.reddit.com/api/v1/authorize?${params}`;
  },

  async handleCallback(): Promise<boolean> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const savedState = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);

    if (!code || !state || state !== savedState) return false;
    await exchangeCode(code);
    window.history.replaceState({}, "", "/");
    return true;
  },

  logout(): void {
    clearToken();
  },

  isLoggedIn(): boolean {
    return getStoredToken() !== null;
  },

  async getUser(): Promise<RedditUser> {
    return oauthFetch<RedditUser>("/api/v1/me");
  },
};

export const post = {
  async submit(sr: string, title: string, text: string): Promise<void> {
    await oauthFetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_type: "json",
        kind: "self",
        sr,
        title,
        text,
      }),
    });
  },

  async comment(thingId: string, text: string): Promise<void> {
    await oauthFetch("/api/comment", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_type: "json",
        thing_id: thingId,
        text,
      }),
    });
  },
};

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
  is_video: boolean;
  preview?: { images?: { source?: { url: string } }[] };
  media?: { reddit_video?: { fallback_url: string } };
  media_metadata?: Record<string, { s?: { u?: string }; status?: string }>;
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
