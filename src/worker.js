// Backend for The Inside: Bludle (Claude), the request box, and the updates list.
// Everything else on the site is plain files served from the public folder.

const MAX_MESSAGES = 12;
const MAX_CHARS = 1000;
const MAX_REQUEST = 500;

const SYSTEM = [
  "You are Bludle, a friendly, laid-back AI assistant on a website called The Inside.",
  "Keep answers short and clear, use plain language, and stay upbeat.",
  "You can help with explanations, ideas, writing, coding, and general questions.",
  "Never claim to be human. If someone asks what you are, say you're an AI assistant called Bludle.",
  "Politely decline anything dangerous, hateful, sexual, or illegal. If someone seems unsafe or in crisis, respond kindly and encourage them to talk to a trusted adult or local emergency services.",
  "You have a tool that finds the newest video on a YouTube channel. Use it when someone asks for the latest or newest video from a creator or channel.",
  "Only share links that come from your tools. Never guess or invent a link. Always say which channel you found so the person can check it is the right one, and put the full link on its own line."
].join(" ");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

// Small per-visitor limiter. It resets when the Worker restarts, so also add a
// rate limiting rule in the Cloudflare dashboard for /api/ (see the setup steps).
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

function supabase(env, path, init = {}) {
  const key = env.SUPABASE_SECRET_KEY || "";
  const headers = { apikey: key, "content-type": "application/json", ...(init.headers || {}) };
  // Old-style service_role keys are JWTs and also go in the Authorization header.
  if (key.startsWith("eyJ")) headers.authorization = "Bearer " + key;
  return fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path, { ...init, headers });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

const TOOLS = [{
  name: "latest_youtube_video",
  description: "Find the newest video uploaded to a YouTube channel. Returns the channel name, the video title, its link and the upload date.",
  input_schema: {
    type: "object",
    properties: { channel: { type: "string", description: "The channel name or @handle, like @examplechannel or Example Creator" } },
    required: ["channel"]
  }
}];

// Remember lookups for 10 minutes so repeat questions don't use up the daily YouTube allowance.
const videoCache = new Map();

async function latestVideo(env, channel) {
  const key = env.YOUTUBE_API_KEY;
  if (!key) return { error: "YouTube lookup is not set up yet." };
  const q = String(channel || "").trim().slice(0, 80);
  if (!q) return { error: "No channel name was given." };
  const cached = videoCache.get(q.toLowerCase());
  if (cached && Date.now() - cached.at < 600000) return cached.value;

  const yt = async (path, params) => {
    const u = new URL("https://www.googleapis.com/youtube/v3/" + path);
    Object.entries({ ...params, key }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u);
    if (!r.ok) {
      let why = "";
      try {
        const e = (await r.json()).error || {};
        const reason = e.errors && e.errors[0] && e.errors[0].reason;
        why = (reason ? reason + ": " : "") + (e.message || "");
      } catch {}
      throw new Error("YouTube said " + r.status + (why ? " (" + why.slice(0, 180) + ")" : ""));
    }
    return r.json();
  };

  let channelId = null, channelTitle = "";
  const handle = q.startsWith("@") ? q : "@" + q.replace(/\s+/g, "");
  if (/^@[A-Za-z0-9._-]{3,30}$/.test(handle)) {
    const d = await yt("channels", { part: "id,snippet", forHandle: handle });
    const c = d.items && d.items[0];
    if (c) { channelId = c.id; channelTitle = c.snippet.title; }
  }
  if (!channelId) {
    const d = await yt("search", { part: "snippet", type: "channel", q, maxResults: 1 });
    const c = d.items && d.items[0];
    if (!c) return { error: "No channel was found with that name." };
    channelId = c.snippet.channelId || (c.id && c.id.channelId);
    channelTitle = c.snippet.title || c.snippet.channelTitle || q;
  }
  if (!channelId) return { error: "No channel was found with that name." };

  // Every channel has an "uploads" list whose id is the channel id with UC swapped for UU.
  const v = await yt("playlistItems", { part: "snippet,contentDetails", playlistId: "UU" + channelId.slice(2), maxResults: 1 });
  const item = v.items && v.items[0];
  if (!item) return { error: "That channel has no public videos." };
  const value = {
    channel: channelTitle,
    title: item.snippet.title,
    published: (item.contentDetails && item.contentDetails.videoPublishedAt) || item.snippet.publishedAt,
    url: "https://www.youtube.com/watch?v=" + item.contentDetails.videoId
  };
  if (videoCache.size > 200) videoCache.clear();
  videoCache.set(q.toLowerCase(), { at: Date.now(), value });
  return value;
}

async function runTool(env, use) {
  try {
    if (use.name === "latest_youtube_video") return await latestVideo(env, use.input && use.input.channel);
  } catch (e) {
    console.error("YouTube lookup failed:", e && e.message);
    return { error: "The YouTube lookup failed. " + (e && e.message ? e.message : "") };
  }
  return { error: "Unknown tool." };
}

async function askClaude(env, messages) {
  const body = {
    model: env.CLAUDE_MODEL || "claude-haiku-5-5",
    max_tokens: 500,
    system: SYSTEM,
    messages
  };
  if (env.YOUTUBE_API_KEY) body.tools = TOOLS;
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function chat(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Bludle isn't set up yet." }, 503);
  const body = await readJson(request);
  const raw = body && Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  let messages = raw
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "Say something first." }, 400);
  }
  // Claude may ask for a tool (like the YouTube lookup). Run it and let Claude finish its answer.
  for (let turn = 0; turn < 3; turn++) {
    const res = await askClaude(env, messages);
    if (!res.ok) return json({ error: "Bludle is having a moment. Try again." }, 502);
    const data = await res.json();
    if (data.stop_reason !== "tool_use") {
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return json({ reply: text || "..." });
    }
    const uses = (data.content || []).filter(b => b.type === "tool_use");
    const results = await Promise.all(uses.map(async u => {
      const out = await runTool(env, u);
      return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) };
    }));
    messages = [...messages, { role: "assistant", content: data.content }, { role: "user", content: results }];
  }
  return json({ reply: "I couldn't finish that one. Try asking again." });
}

async function submitRequest(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: "Bad request." }, 400);
  if (body.website) return json({ ok: true }); // hidden field only bots fill in
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 3 || text.length > MAX_REQUEST) {
    return json({ error: "Requests need 3 to 500 characters." }, 400);
  }
  const res = await supabase(env, "requests", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ message: text })
  });
  if (!res.ok) return json({ error: "Couldn't save your request." }, 502);
  return json({ ok: true });
}

async function updates(env) {
  const res = await supabase(env, "updates?select=title,created_at&order=created_at.desc&limit=10");
  if (!res.ok) return json({ error: "Updates aren't set up yet." }, 503);
  return json({ updates: await res.json() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      if (request.method === "POST" && !sameOrigin(request, url)) return json({ error: "Not allowed." }, 403);
      if (path === "/api/chat" && request.method === "POST") {
        if (limited(ip + ":chat", 12, 60000)) return json({ error: "Slow down a little." }, 429);
        return await chat(request, env);
      }
      if (path === "/api/request" && request.method === "POST") {
        if (limited(ip + ":req", 5, 60000)) return json({ error: "Slow down a little." }, 429);
        return await submitRequest(request, env);
      }
      if (path === "/api/updates" && request.method === "GET") return await updates(env);
      return json({ error: "Not found." }, 404);
    } catch {
      return json({ error: "Something went wrong." }, 500);
    }
  }
};
