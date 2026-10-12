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
  "Politely decline anything dangerous, hateful, sexual, or illegal. If someone seems unsafe or in crisis, respond kindly and encourage them to talk to a trusted adult or local emergency services."
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

async function chat(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Bludle isn't set up yet." }, 503);
  const body = await readJson(request);
  const raw = body && Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  const messages = raw
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "Say something first." }, 400);
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-haiku-5-5",
      max_tokens: 500,
      system: SYSTEM,
      messages
    })
  });
  if (!res.ok) return json({ error: "Bludle is having a moment. Try again." }, 502);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return json({ reply: text || "..." });
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

// Setup check: open /api/health on your site to see what is and isn't connected.
// It never shows your keys, only yes/no answers and error messages. Remove it once everything works.
function keyKind(k) {
  if (!k) return "missing";
  if (k !== k.trim()) return "has a space or line break at the start or end (re-paste it)";
  if (k.startsWith("sb_secret_")) return "secret key (correct)";
  if (k.startsWith("sb_publishable_")) return "publishable key (WRONG: use the secret key)";
  if (k.startsWith("eyJ")) {
    try {
      const role = JSON.parse(atob(k.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role;
      return role === "service_role" ? "service_role key (correct)" : role + " key (WRONG: use the secret key)";
    } catch { return "not recognized"; }
  }
  return "not recognized";
}

async function health(env) {
  const model = env.CLAUDE_MODEL || "claude-haiku-5-5";
  const out = { anthropic: { keySet: !!env.ANTHROPIC_API_KEY, model }, supabase: {} };
  if (env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
      });
      out.anthropic.status = r.status;
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        out.anthropic.problem = (e.error && e.error.message) || "unknown problem";
      }
    } catch { out.anthropic.problem = "could not reach Anthropic"; }
  }
  const url = env.SUPABASE_URL || "";
  out.supabase.url = !url ? "missing" : url !== url.trim() ? "has a space or line break (re-paste it)"
    : /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url) ? "looks right" : "does not look like https://yourproject.supabase.co";
  out.supabase.key = keyKind(env.SUPABASE_SECRET_KEY);
  if (url && env.SUPABASE_SECRET_KEY) {
    for (const table of ["requests", "updates"]) {
      try {
        const r = await supabase(env, table + "?select=id&limit=1");
        out.supabase[table] = r.ok ? "ok" : "error " + r.status + ": " + (await r.text()).slice(0, 140);
      } catch { out.supabase[table] = "could not reach Supabase (check the URL)"; }
    }
  }
  return json(out);
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
      if (path === "/api/health" && request.method === "GET") {
        if (limited(ip + ":health", 4, 60000)) return json({ error: "Slow down a little." }, 429);
        return await health(env);
      }
      return json({ error: "Not found." }, 404);
    } catch {
      return json({ error: "Something went wrong." }, 500);
    }
  }
};
