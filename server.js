const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

let cachedData = null;
let lastFetch = 0;
const CACHE_MS = 10 * 60 * 1000;

// Convert place IDs to universe IDs in batches
async function convertPlaceIdsToUniverseIds(placeIds) {
  const map = {};
  try {
    // Roblox allows up to 100 place IDs per request
    const chunks = [];
    for (let i = 0; i < placeIds.length; i += 100) {
      chunks.push(placeIds.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const res = await fetch(
        `https://apis.roblox.com/universes/v1/places?placeIds=${chunk.join(",")}`,
        { headers: { "Accept": "application/json" } }
      );
      if (res.ok) {
        const json = await res.json();
        (json.universeIds || []).forEach(entry => {
          if (entry.placeId && entry.universeId) {
            map[entry.placeId] = entry.universeId;
          }
        });
      }
    }
  } catch(e) {
    console.warn("[Convert] Place->Universe failed:", e.message);
  }
  return map;
}

async function fetchGameData() {
  const now = Date.now();
  if (cachedData && (now - lastFetch) < CACHE_MS) {
    return cachedData;
  }

  console.log("[Fetch] Pulling from Rolimons...");

  try {
    const roliRes = await fetch("https://api.rolimons.com/games/v1/gamelist", {
      headers: { "Accept": "application/json", "User-Agent": "RoStocks/1.0" }
    });
    if (!roliRes.ok) throw new Error(`Rolimons returned ${roliRes.status}`);

    const roliJson = await roliRes.json();
    if (!roliJson.success || !roliJson.games) throw new Error("No games from Rolimons");

    // Sort by CCU, take top 100
    const sorted = Object.entries(roliJson.games)
      .map(([placeId, data]) => ({
        placeId:   parseInt(placeId),
        name:      data[0],
        ccuRaw:    data[1] || 0,
        thumbnail: data[2] || "",
      }))
      .filter(g => g.ccuRaw > 0 && g.name)
      .sort((a, b) => b.ccuRaw - a.ccuRaw)
      .slice(0, 100);

    // Convert all place IDs to universe IDs
    console.log("[Fetch] Converting place IDs to universe IDs...");
    const placeIds = sorted.map(g => g.placeId);
    const uniMap = await convertPlaceIdsToUniverseIds(placeIds);
    console.log(`[Fetch] Converted ${Object.keys(uniMap).length} IDs`);

    const mapped = sorted.map((g, i) => {
      const universeId = uniMap[g.placeId] || g.placeId;
      return {
        rank:       i + 1,
        placeId:    g.placeId,
        universeId: universeId,
        name:       g.name,
        creator:    "@Unknown",
        ccu:        formatCCU(g.ccuRaw),
        ccuRaw:     g.ccuRaw,
        price:      calculateSharePrice(g.ccuRaw),
        change:     simulatePriceChange(universeId),
        thumbnail:  g.thumbnail,
      };
    });

    // Fetch creator names using real universe IDs
    const universeIds = mapped.map(g => g.universeId).filter(Boolean);
    try {
      const detailRes = await fetch(
        `https://games.roblox.com/v1/games?universeIds=${universeIds.slice(0,50).join(",")}`,
        { headers: { "Accept": "application/json" } }
      );
      if (detailRes.ok) {
        const dj = await detailRes.json();
        const detailMap = {};
        (dj.data || []).forEach(d => { detailMap[d.id] = d; });
        mapped.forEach(g => {
          const d = detailMap[g.universeId];
          if (d?.creator?.name) g.creator = "@" + d.creator.name;
        });
      }
    } catch(e) {
      console.warn("[Fetch] Creator fetch failed:", e.message);
    }

    cachedData = mapped;
    lastFetch = now;
    console.log(`[Fetch] Done. Top: ${mapped[0]?.name} (${mapped[0]?.ccu})`);
    return mapped;

  } catch(err) {
    console.error("[Fetch] Error:", err.message);
    if (cachedData) return cachedData;
    throw err;
  }
}

function calculateSharePrice(ccu) {
  return Math.min(Math.max(Math.round(ccu * 0.0002), 10), 10000);
}

function simulatePriceChange(id) {
  const hour = new Date().getHours();
  const seed = (id % 100) + hour;
  const raw  = ((seed * 9301 + 49297) % 233280) / 233280;
  return parseFloat(((raw * 20) - 8).toFixed(1));
}

function formatCCU(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n/1000000).toFixed(2)+"M";
  if (n >= 1000)    return Math.round(n/1000)+"K";
  return n.toString();
}

function getTrending(games) {
  return games
    .filter(g => g.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 20)
    .map(g => ({
      ...g,
      ccuGain:  "+"+formatCCU(Math.floor(g.ccuRaw * 0.08)),
      momentum: Math.min(g.change / 15, 1).toFixed(2),
      tag:      g.change > 10 ? "Hot" : g.rank > 50 ? "New" : "",
    }));
}

// Routes
app.get("/", (req, res) => {
  res.json({ status: "RoStocks running", time: new Date().toISOString() });
});

app.get("/top100", async (req, res) => {
  try {
    const games = await fetchGameData();
    res.json({ games: games.slice(0, 100) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/trending", async (req, res) => {
  try {
    const games = await fetchGameData();
    res.json({ games: getTrending(games) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/game/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const games = await fetchGameData();
    const base = games.find(g => g.universeId == id || g.placeId == id) || {};
    const universeId = base.universeId || id;

    console.log(`[Detail] Fetching universeId: ${universeId} (input: ${id})`);

    // Fetch detail from Roblox
    let visits = 0, genre = "—", updated = "", likes = 0, dislikes = 0;
    try {
      const dr = await fetch(
        `https://games.roblox.com/v1/games?universeIds=${universeId}`,
        { headers: { "Accept": "application/json" } }
      );
      if (dr.ok) {
        const dj = await dr.json();
        const g = (dj.data||[])[0] || {};
        console.log(`[Detail] name=${g.name} visits=${g.visits} genre=${g.genre}`);
        visits  = g.visits || 0;
        genre   = (g.genre && g.genre !== "All") ? g.genre : "—";
        updated = g.updated || "";
        likes   = g.upVotes || 0;
        dislikes= g.downVotes || 0;
      }
    } catch(e) { console.warn("[Detail] API error:", e.message); }

    // Try votes endpoint if no votes yet
    if (likes === 0) {
      try {
        const vr = await fetch(
          `https://games.roblox.com/v1/games/votes?universeIds=${universeId}`,
          { headers: { "Accept": "application/json" } }
        );
        if (vr.ok) {
          const vj = await vr.json();
          const v = (vj.data||[])[0] || {};
          likes    = v.upVotes || 0;
          dislikes = v.downVotes || 0;
        }
      } catch(e) {}
    }

    console.log(`[Detail] Result: visits=${visits} likes=${likes} dislikes=${dislikes} genre=${genre}`);
    res.json({ ...base, visits, genre, updated, likes, dislikes });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`[RoStocks] Running on port ${PORT}`));
