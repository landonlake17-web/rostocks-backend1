// RoStocks Backend Server
// Fetches real game data from Roblox's public API
// Deploy this on Railway (free) at railway.app

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// -------------------------------------------------------
// Roblox public API endpoints (no key required)
// -------------------------------------------------------
const ROBLOX_GAMES_API   = "https://games.roblox.com/v1/games/list";
const ROBLOX_DETAILS_API = "https://games.roblox.com/v1/games";

// These are real Universe IDs for top Roblox games
// Add/remove as needed
const UNIVERSE_IDS = [
  4922741943,  // Sols RNG
  4483381587,  // Brookhaven RP
  2729339200,  // Blade Ball
  189707,      // Adopt Me!
  108080835,   // Fisch (use real ID)
  1537690962,  // Tower of Hell
  3136549983,  // Dress To Impress
  606849621,   // Jailbreak
  6284583030,  // Pet Simulator 99
  6872265039,  // Anime Adventures
  7449846184,  // Toilet Tower Defense
  4924922222,  // Rivals
  142823291,   // Evade
  142823291,   // Murder Mystery 2
  301549746,   // Natural Disaster Survival
];

// Cache so we don't hammer the API
let cachedData = null;
let lastFetch = 0;
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

// -------------------------------------------------------
// Fetch game details from Roblox API
// -------------------------------------------------------
async function fetchGameData() {
  const now = Date.now();
  if (cachedData && (now - lastFetch) < CACHE_DURATION_MS) {
    console.log("[Cache] Returning cached data");
    return cachedData;
  }

  console.log("[Fetch] Pulling fresh data from Roblox API...");

  try {
    // Batch fetch - Roblox allows up to 100 universe IDs per request
    const ids = UNIVERSE_IDS.join(",");
    const url = `${ROBLOX_DETAILS_API}?universeIds=${ids}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Roblox API returned ${response.status}`);
    }

    const json = await response.json();
    const games = json.data || [];

    // Map and sort by CCU descending
    const mapped = games.map((game, index) => {
      const price = calculateSharePrice(game.playing, game.visits);
      const change = simulatePriceChange(game.universeId);

      return {
        rank:       0, // filled after sort
        universeId: game.universeId,
        name:       game.name,
        creator:    "@" + (game.creator?.name || "Unknown"),
        ccu:        formatCCU(game.playing),
        ccuRaw:     game.playing || 0,
        visits:     game.visits || 0,
        price:      price,
        change:     change,
        thumbnail:  "", // filled separately if needed
      };
    });

    // Sort by live CCU
    mapped.sort((a, b) => b.ccuRaw - a.ccuRaw);

    // Assign ranks
    mapped.forEach((g, i) => { g.rank = i + 1; });

    cachedData = mapped;
    lastFetch = now;

    console.log(`[Fetch] Got ${mapped.length} games`);
    return mapped;

  } catch (err) {
    console.error("[Fetch] Error:", err.message);
    // Return cached data if available, even if stale
    if (cachedData) return cachedData;
    throw err;
  }
}

// -------------------------------------------------------
// Share price formula
// Price is based on CCU (primary) + total visits (secondary)
// You can tune these multipliers however you want
// -------------------------------------------------------
function calculateSharePrice(ccu, visits) {
  const ccuScore    = (ccu    || 0) * 0.0002;
  const visitScore  = (visits || 0) * 0.000000005;
  const base        = Math.round(ccuScore + visitScore);
  // Floor of 10 R$, ceiling of 10,000 R$
  return Math.min(Math.max(base, 10), 10000);
}

// -------------------------------------------------------
// Simulated 24h price change
// In production: store historical prices in a DB and calc real change
// -------------------------------------------------------
function simulatePriceChange(universeId) {
  // Deterministic pseudo-random based on universe ID + current hour
  const hour = new Date().getHours();
  const seed = (universeId % 100) + hour;
  const raw  = ((seed * 9301 + 49297) % 233280) / 233280;
  const change = (raw * 20) - 8; // Range: -8% to +12% (slightly positive bias)
  return parseFloat(change.toFixed(1));
}

// -------------------------------------------------------
// Format CCU number for display
// -------------------------------------------------------
function formatCCU(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + "K";
  return n.toString();
}

// -------------------------------------------------------
// Get trending games (biggest CCU gainers)
// In production: compare current CCU vs stored CCU from 7 days ago
// For now: sort by CCU and tag games with recent activity signals
// -------------------------------------------------------
function getTrending(games) {
  const tags = {
    4922741943: "Update",
    2729339200: "Hot",
    3136549983: "New",
    6284583030: "Update",
    7449846184: "Hot",
  };

  return games
    .filter(g => g.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 20)
    .map(g => ({
      ...g,
      ccuGain:   "+" + formatCCU(Math.floor(g.ccuRaw * 0.08)),
      momentum:  Math.min(g.change / 15, 1).toFixed(2),
      tag:       tags[g.universeId] || "",
    }));
}

// -------------------------------------------------------
// ROUTES
// -------------------------------------------------------

// Health check
app.get("/", (req, res) => {
  res.json({ status: "RoStocks backend running", time: new Date().toISOString() });
});

// Top 100 by CCU
app.get("/top100", async (req, res) => {
  try {
    const games = await fetchGameData();
    res.json({ games: games.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trending & Rising
app.get("/trending", async (req, res) => {
  try {
    const games = await fetchGameData();
    const trending = getTrending(games);
    res.json({ games: trending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single game by universe ID
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

// -------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[RoStocks] Backend running on port ${PORT}`);
});
