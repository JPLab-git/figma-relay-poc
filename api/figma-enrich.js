// Simple in-memory cache (best-effort on Vercel)
const cache = globalThis.__FIGMA_CACHE__ || (globalThis.__FIGMA_CACHE__ = new Map());

// 10 minutes TTL
const TTL_MS = 10 * 60 * 1000;

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  cache.set(key, { ts: Date.now(), value });
}

async function fetchJson(url, headers) {
  const resp = await fetch(url, { headers });
  const ct = resp.headers.get("content-type") || "";
  let bodyText = "";
  let bodyJson = null;

  if (ct.includes("application/json")) {
    bodyJson = await resp.json().catch(() => null);
  } else {
    bodyText = await resp.text().catch(() => "");
  }

  return { ok: resp.ok, status: resp.status, json: bodyJson, text: bodyText };
}

function pickTopScreens(fileJson, limit) {
  const screens = [];
  const pages = fileJson?.document?.children || [];
  for (const page of pages) {
    if (page?.type !== "CANVAS") continue;
    for (const node of page.children || []) {
      if (["FRAME", "SECTION"].includes(node?.type)) {
        screens.push({ id: node.id, name: node.name });
        if (screens.length >= limit) return screens;
      }
    }
  }
  return screens;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const relayKey = req.headers["x-relay-key"];
    if (!process.env.RELAY_KEY || relayKey !== process.env.RELAY_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const fileKey = req.query.file_key;
    const depth = String(req.query.depth || "1");
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 25);

    if (!fileKey) return res.status(400).json({ error: "Missing file_key" });
    if (!["1", "2", "3"].includes(depth)) return res.status(400).json({ error: "depth must be 1,2,3" });
    if (!process.env.FIGMA_PAT) return res.status(500).json({ error: "Server misconfigured: FIGMA_PAT missing" });

    const figmaHeaders = {
      "X-Figma-Token": process.env.FIGMA_PAT,
      "Accept": "application/json",
    };

    // Cache key includes fileKey+depth+limit (so we don't mix payloads)
    const ckey = `${fileKey}|d=${depth}|l=${limit}`;

    // 1) Serve from cache if available (fast path)
    const cached = getCache(ckey);
    if (cached) {
      // Mark as cached for debugging/telemetry
      return res.status(200).json({ ...cached, _cache: "hit" });
    }

    // 2) Fetch file from Figma
    const fileUrl = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?depth=${encodeURIComponent(depth)}`;
    const fileRes = await fetchJson(fileUrl, figmaHeaders);

    // If rate-limited, try any older cache variants (same fileKey) as fallback
    if (fileRes.status === 429) {
      // Search any cache entry for same fileKey
      for (const [k, v] of cache.entries()) {
        if (String(k).startsWith(`${fileKey}|`) && Date.now() - v.ts <= TTL_MS) {
          return res.status(200).json({ ...v.value, _cache: "fallback_on_429" });
        }
      }
      return res.status(429).json({
        error: "Figma rate limited (429) and no cache available yet. Retry in a few minutes.",
      });
    }

    if (!fileRes.ok || !fileRes.json) {
      return res.status(fileRes.status || 502).json({
        error: "Figma file fetch failed",
        figma_status: fileRes.status,
        figma_body: fileRes.json || fileRes.text || null,
      });
    }

    const fileJson = fileRes.json;
    const screens = pickTopScreens(fileJson, limit);
    const ids = screens.map(s => s.id).join(",");

    // 3) Fetch nodes for selected screens (optional, can also rate-limit)
    let nodes = {};
    if (ids) {
      const nodesUrl = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids)}`;
      const nodesRes = await fetchJson(nodesUrl, figmaHeaders);

      if (nodesRes.status === 429) {
        // return without nodes if rate-limited; still useful
        nodes = {};
      } else if (nodesRes.ok && nodesRes.json) {
        nodes = nodesRes.json.nodes || {};
      }
    }

    const payload = {
      file_key: fileKey,
      file_name: fileJson?.name || "",
      last_modified: fileJson?.lastModified || "",
      screens,
      nodes,
    };

    // 4) Save to cache
    setCache(ckey, payload);

    return res.status(200).json({ ...payload, _cache: "miss_set" });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error", detail: String(e?.message || e) });
  }
}



