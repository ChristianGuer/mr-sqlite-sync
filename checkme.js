// checkme.js — scratch helper for inspecting a single match payload from the API.
// Usage: node checkme.js [matchUid]
require("dotenv").config();

const API_KEY = process.env.MR_API_KEY;
const MATCH_UID = process.argv[2] || process.env.MR_SAMPLE_MATCH_UID;

if (!API_KEY) throw new Error("MR_API_KEY is missing from .env");
if (!MATCH_UID) throw new Error("Pass a match UID: node checkme.js <matchUid>");

fetch(`https://marvelrivalsapi.com/api/v1/match/${MATCH_UID}`, {
  method: "GET",
  headers: { "x-api-key": API_KEY, accept: "application/json" },
})
  .then((response) => response.text())
  .then((result) => console.log(result))
  .catch((error) => console.error("error", error));
