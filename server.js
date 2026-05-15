// RoStocks Backend Server
// Uses Rolimons API (free, no key needed) to get real top games by CCU
// Deploy on Railway (free) at railway.app

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let cachedData = null;
let lastFetch = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

// -------------------------------------------------------
// Fetch top games from Rolimons (returns all tracked games with live CCU)
// Then fetch details from Roblox games API for visits/creator info
// -------------------------------------------------------
async function fetchGameData() {
  const now = Date.now();
  if (cachedData && (now - lastFetch) < CACHE_MS) {
    console.log("[Cache] Returning cached data");
    return cachedData;
  }

  console.log("[Fetch] Pulling games from Rolimons...");

  try {
    // Step 1: Get all games from Rolimons (includes live player count)
    const roliRes = await fetch("https://api.rolimons.com/games/v1/gamelist", {
      headers: { "Accept": "application/json", "User-Agent": "RoStocks/1.0" }
    });

    if (!roliRes.ok) throw new Error(`Rolimons API returned ${roliRes.status}`);

    const roliJson = await roliRes.json();
    if (!roliJson.success || !roliJson.games) throw new Error("Rolimons returned no games");

    // roliJson.games is an object: { "placeId": [name, ccu, thumbnailUrl], ... }
    const entries = Object.entries(roliJson.games);

    // Sort by CCU descending, take top 100
    const sorted = entries
      .map(([placeId, data]) => ({
        placeId:  parseInt(placeId),
        name:     data[0],
        ccuRaw:   data[1] || 0,
        thumbnail: data[2] || "",
      }))
      .filter(g => g.ccuRaw > 0 && g.name)
      .sort((a, b) => b.ccuRaw - a.ccuRaw)
      .slice(0, 100);

    // Step 2: Get universe IDs from place IDs so we can fetch creator info
    // Batch in groups of 100
    const placeIds = sorted.map(g => g.placeId).join(",");
    let universeMap = {};

    try {
      const uniRes = await fetch(`https://apis.roblox.com/universes/v1/places?placeIds=${placeIds}`, {
        headers: { "Accept": "application/json" }
      });
      if (uniRes.ok) {
        const uniJson = await uniRes.json();
        (uniJson.universeIds || []).forEach((entry) => {
          if (entry.placeId && entry.universeId) {
            universeMap[entry.placeId] = entry.universeId;
          }
        });
      }
    } catch(e) {
      console.warn("[Fetch] Universe ID lookup failed, skipping:", e.message);
    }

    // Step 3: Build final mapped array
    const mapped = sorted.map((g, i) => {
      const universeId = universeMap[g.placeId] || g.placeId;
      return {
        rank:       i + 1,
        universeId: universeId,
        placeId:    g.placeId,
        name:       g.name,
        creator:    "@Unknown", // filled below if universe lookup worked
        ccu:        formatCCU(g.ccuRaw),
        ccuRaw:     g.ccuRaw,
        price:      calculateSharePrice(g.ccuRaw),
        change:     simulatePriceChange(universeId),
        thumbnail:  g.thumbnail,
      };
    });

    // Step 4: Fetch creator names using universe IDs (batched)
    const universeIds = mapped.map(g => g.universeId).filter(Boolean).slice(0, 100);
    try {
      const detailRes = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(",")}`, {
        headers: { "Accept": "application/json" }
      });
      if (detailRes.ok) {
        const detailJson = await detailRes.json();
        const detailMap = {};
        (detailJson.data || []).forEach(d => { detailMap[d.id] = d; });
        mapped.forEach(g => {
          const detail = detailMap[g.universeId];
          if (detail?.creator?.name) {
            g.creator = "@" + detail.creator.name;
          }
        });
      }
    } catch(e) {
      console.warn("[Fetch] Creator name lookup failed:", e.message);
    }

    cachedData = mapped;
    lastFetch = now;
    console.log(`[Fetch] Done. Top game: ${mapped[0]?.name} (${mapped[0]?.ccu} CCU)`);
    return mapped;

  } catch (err) {
    console.error("[Fetch] Error:", err.message);
    if (cachedData) {
      console.log("[Fetch] Returning stale cache");
      return cachedData;
    }
    throw err;
  }
}

function calculateSharePrice(ccu) {
  const base = Math.round(ccu * 0.0002);
  return Math.min(Math.max(base, 10), 10000);
}

function simulatePriceChange(id) {
  const hour = new Date().getHours();
  const seed = (id % 100) + hour;
  const raw  = ((seed * 9301 + 49297) % 233280) / 233280;
  return parseFloat(((raw * 20) - 8).toFixed(1));
}

function formatCCU(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000)    return Math.round(n / 1000) + "K";
  return n.toString();
}

function getTrending(games) {
  return games
    .filter(g => g.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 20)
    .map(g => ({
      ...g,
      ccuGain:  "+" + formatCCU(Math.floor(g.ccuRaw * 0.08)),
      momentum: Math.min(g.change / 15, 1).toFixed(2),
      tag:      g.change > 10 ? "Hot" : g.rank > 50 ? "New" : "",
    }));
}

// Routes
app.get("/", (req, res) => {
  res.json({ status: "RoStocks backend running", time: new Date().toISOString() });
});

app.get("/top100", async (req, res) => {
  try {
    const games = await fetchGameData();
    res.json({ games: games.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/trending", async (req, res) => {
  try {
    const games = await fetchGameData();
    res.json({ games: getTrending(games) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Convert placeId to universeId
async function placeToUniverse(placeId) {
  try {
    const res = await fetch(`https://apis.roblox.com/universes/v1/places?placeIds=${placeId}`, {
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) return placeId;
    const json = await res.json();
    const entry = (json.universeIds || [])[0];
    return entry ? entry.universeId : placeId;
  } catch(e) {
    return placeId;
  }
}

app.get("/game/:universeId", async (req, res) => {
  let universeId = req.params.universeId;
  try {
    // Get base data from cache
    const games = await fetchGameData();
    const base = games.find(g => g.universeId == universeId || g.placeId == universeId) || {};

    // If we have a placeId stored, convert it to real universeId for detail lookup
    if (base.placeId && base.placeId != base.universeId) {
      const realId = await placeToUniverse(base.placeId);
      console.log(`[Detail] placeId ${base.placeId} -> universeId ${realId}`);
      universeId = realId;
    }

    // Fetch rich detail from Roblox API
    let detail = {};
    try {
      const detailRes = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, {
        headers: { "Accept": "application/json" }
      });
      if (detailRes.ok) {
        const dj = await detailRes.json();
        const g = (dj.data || [])[0] || {};
        console.log(`[Detail] Raw for ${universeId}:`, JSON.stringify(g).substring(0, 400));
        // Roblox genre is often "All" — check sourceName for real genre
        const genre = (g.genre && g.genre !== "All") ? g.genre :
                      (g.sourceName || "—");
        detail = {
          visits:         g.visits || 0,
          genre:          genre,
          updated:        g.updated || "",
          created:        g.created || "",
          maxPlayers:     g.maxPlayers || 0,
          favoritedCount: g.favoritedCount || 0,
          upVotes:        g.upVotes || 0,
          downVotes:      g.downVotes || 0,
        };
      } else {
        console.warn("[Detail] Roblox API status:", detailRes.status);
      }
    } catch(e) {
      console.warn("[Detail] Roblox API error:", e.message);
    }

    // Use votes from games API if available, else try votes endpoint
    let likes = detail.upVotes || 0;
    let dislikes = detail.downVotes || 0;

    if (likes === 0) {
      try {
        const voteRes = await fetch(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`, {
          headers: { "Accept": "application/json" }
        });
        if (voteRes.ok) {
          const vj = await voteRes.json();
          console.log(`[Votes] Raw:`, JSON.stringify(vj).substring(0, 200));
          const v = (vj.data || [])[0] || {};
          likes    = v.upVotes || 0;
          dislikes = v.downVotes || 0;
        }
      } catch(e) {
        console.warn("[Detail] Votes API error:", e.message);
      }
    }

    const response = {
      ...base,
      visits:         detail.visits || base.visits || 0,
      genre:          detail.genre || "—",
      updated:        detail.updated || "",
      created:        detail.created || "",
      likes:          likes,
      dislikes:       dislikes,
      favoritedCount: detail.favoritedCount || 0,
    };
    console.log(`[Detail] Sending: visits=${response.visits} likes=${likes} dislikes=${dislikes} genre=${response.genre}`);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[RoStocks] Backend running on port ${PORT}`);
});
