// start.js — Launches both server.js and bot.js together on Render
// This is more reliable than concurrently on Render free tier

require("./server.js");
require("./bot.js");
