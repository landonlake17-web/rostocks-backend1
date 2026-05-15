// RoStocks Backend Server
// Fetches real top 100 games dynamically from Roblox's public API
// Deploy on Railway (free) at railway.app

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let cachedData = null;
let lastFetch = 0;
const CACHE_MS = 10 * 60 * 1000;

async function fetchGameData() {
  const now = Date.now();
  if (cachedData && (now - lastFetch) < CACHE_MS) {
    console.log("[Cache] Returning cached data");
    return cachedData;
  }

  console.log("[Fetch] Pulling top games from Roblox API...");

  try {
    const listUrl = "https://games.roblox.com/v1/games/list?sortToken=&gameFilter=default&startRows=0&maxRows=100&browserFilter=default&SortType=1&sortOrder=0";
    const listRes = await fetch(listUrl, { headers: { "Accept": "application/json" } });

    if (!listRes.ok) throw new Error(`Games list API returned ${listRes.status}`);

    const listJson = await listRes.json();
    const gameList = listJson.games || [];

    if (gameList.length === 0) throw new Error("No games returned from Roblox API");

    const universeIds = gameList.map(g => g.universeId).filter(Boolean);

    const detailRes = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(",")}`, {
      headers: { "Accept": "application/json" }
    });

    const detailJson = detailRes.ok ? await detailRes.json() : { data: [] };
    const detailMap = {};
    (detailJson.data || []).forEach(d => { detailMap[d.id] = d; });

    const mapped = gameList.map((g, i) => {
      const detail = detailMap[g.universeId] || {};
      const ccu    = g.playerCount || detail.playing || 0;
      const visits = detail.visits || 0;
      return {
        rank:       i + 1,
        universeId: g.universeId,
        name:       g.name || detail.name || "Unknown",
        creator:    "@" + (g.creatorName || detail.creator?.name || "Unknown"),
        ccu:        formatCCU(ccu),
        ccuRaw:     ccu,
        visits:     visits,
        price:      calculateSharePrice(ccu, visits),
        change:     simulatePriceChange(g.universeId),
      };
    }).filter(g => g.name !== "Unknown");

    cachedData = mapped;
    lastFetch = now;
    console.log(`[Fetch] Got ${mapped.length} games, top: ${mapped[0]?.name}`);
    return mapped;

  } catch (err) {
    console.error("[Fetch] Error:", err.message);
    if (cachedData) return cachedData;
    throw err;
  }
}

function calculateSharePrice(ccu, visits) {
  const base = Math.round(ccu * 0.0002 + visits * 0.000000005);
  return Math.min(Math.max(base, 10), 10000);
}

function simulatePriceChange(universeId) {
  const hour = new Date().getHours();
  const seed = (universeId % 100) + hour;
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

app.get("/game/:universeId", async (req, res) => {
  try {
    const games = await fetchGameData();
    const game = games.find(g => g.universeId == req.params.universeId);
    if (!game) return res.status(404).json({ error: "Game not found" });
    res.json(game);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[RoStocks] Backend running on port ${PORT}`);
});
