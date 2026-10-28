// Deck builder: each player picks the cards of their deck from their own
// collection. The deck is saved in this browser and used by solo and online
// games (game.js calls deckForGame()).

import { cards, typeInfo, collection, openCardInspection } from "./script.js";

// ---- Tunable settings -------------------------------------------------------
// A deck has exactly DECK_SIZE cards (set DECK_MIN lower to allow smaller decks).
export const DECK_MAX = 20;
export const DECK_MIN = DECK_MAX;
const DECK_KEY = "my-gacha-deck-v1";
// -----------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const norm = t => String(t ?? "").toLowerCase().replace(/[\s_-]+/g, "");
const typeOrder = ["workforce", "item", "particle", "astro", "gravity", "condmatt", "thermo", "electromag", "hydro"];
const rarityRank = { Legendary: 3, Rare: 2, Common: 1 };

// Folded type groups in the deck builder (remembered in this browser).
const DECK_FOLD_KEY = "my-gacha-deck-folded-v1";
const folded = new Set((() => {
  try { return JSON.parse(localStorage.getItem(DECK_FOLD_KEY) || "[]"); } catch { return []; }
})());
function saveFolded() {
  try { localStorage.setItem(DECK_FOLD_KEY, JSON.stringify([...folded])); } catch { /* ignore */ }
}

// deck = { cardId: number of copies }
let deck = loadDeck();

function loadDeck() {
  try {
    const saved = JSON.parse(localStorage.getItem(DECK_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const clean = {};
    for (const [id, n] of Object.entries(saved)) {
      if (Number.isSafeInteger(n) && n > 0) clean[id] = n;
    }
    return clean;
  } catch {
    return {};
  }
}

function saveDeck() {
  try { localStorage.setItem(DECK_KEY, JSON.stringify(deck)); } catch { /* ignore */ }
}

const owned = id => collection[id] || 0;

// Copies of each card actually usable: a card you own twice can be in the deck
// at most twice (the saved deck is trimmed, e.g. after a collection reset).
function usableDeck() {
  const out = {};
  for (const [id, n] of Object.entries(deck)) {
    const k = Math.min(n, owned(id));
    if (k > 0) out[id] = k;
  }
  return out;
}

const deckCount = () => Object.values(usableDeck()).reduce((a, b) => a + b, 0);
const ownedTotal = () => Object.values(collection).reduce((a, b) => a + b, 0);

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// The deck to play with, as a shuffled list of card ids.
// Returns { ids, custom } -- custom is false when a random deck from the
// whole collection is used because no valid deck was built.
export function deckForGame() {
  const chosen = usableDeck();
  const count = Object.values(chosen).reduce((a, b) => a + b, 0);
  const ids = [];
  if (count >= DECK_MIN) {
    for (const [id, n] of Object.entries(chosen)) for (let i = 0; i < n; i++) ids.push(String(id));
    return { ids: shuffle(ids).slice(0, DECK_MAX), custom: true };
  }
  for (const card of cards) for (let i = 0; i < owned(card.id); i++) ids.push(String(card.id));
  return { ids: shuffle(ids).slice(0, DECK_MAX), custom: false };
}

// Short description for the Play tab.
export function deckSummary() {
  const n = deckCount();
  if (n >= DECK_MIN) return `Your deck: ${n} cards`;
  if (!ownedTotal()) return "No cards yet — open some boosters";
  return n
    ? `Your deck has ${n}/${DECK_MAX} cards: a random deck will be used until it is complete`
    : "No deck built yet: a random deck from your collection will be used";
}

// ---- editing ----
function setCopies(id, n) {
  n = Math.max(0, Math.min(n, owned(id)));
  if (n > 0) deck[id] = n; else delete deck[id];
  saveDeck();
  renderDeckBuilder();
}

function add(id) {
  const now = usableDeck()[id] || 0;
  if (deckCount() >= DECK_MAX) { flash(`The deck is full (${DECK_MAX} cards): remove a card first.`); return; }
  if (now >= owned(id)) { flash("You don't own more copies of this card."); return; }
  setCopies(id, now + 1);
}

function remove(id) {
  setCopies(id, (usableDeck()[id] || 0) - 1);
}

function autofill() {
  // Fill the free places with random cards you own and haven't put in yet.
  const current = usableDeck();
  const pool = [];
  for (const card of cards) {
    const free = owned(card.id) - (current[card.id] || 0);
    for (let i = 0; i < free; i++) pool.push(String(card.id));
  }
  shuffle(pool);
  let room = DECK_MAX - deckCount();
  deck = { ...current };
  for (const id of pool) {
    if (room <= 0) break;
    deck[id] = (deck[id] || 0) + 1;
    room--;
  }
  saveDeck();
  renderDeckBuilder();
}

function clearDeck() {
  if (deckCount() && !confirm("Remove all cards from your deck?")) return;
  deck = {};
  saveDeck();
  renderDeckBuilder();
}

let flashTimer = null;
function flash(text) {
  $("deck-message").textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $("deck-message").textContent = ""; }, 2500);
}

// ---- rendering ----
function kindOf(card) {
  const t = norm(card.type);
  if (t === "workforce") return "workforce";
  if (t === "item") return "item";
  return "play";
}

function cardTile(card, inDeck) {
  const el = document.createElement("article");
  const rarityClass = String(card.rarity).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  el.className = `card deck-card rarity-${rarityClass}` + (inDeck ? " in-deck" : "");

  const img = document.createElement("img");
  img.src = card.image;
  img.alt = card.name;
  img.loading = "lazy";
  img.title = "Click to inspect";
  img.addEventListener("click", () => openCardInspection(card));

  const name = document.createElement("h3");
  name.textContent = card.name;

  const row = document.createElement("div");
  row.className = "deck-count-row";
  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "secondary deck-btn";
  minus.textContent = "−";
  minus.disabled = !inDeck;
  minus.setAttribute("aria-label", `Remove one ${card.name} from the deck`);
  minus.addEventListener("click", () => remove(String(card.id)));
  const count = document.createElement("span");
  count.className = "deck-count";
  count.textContent = `${inDeck} / ${owned(card.id)}`;
  count.title = "In deck / owned";
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "secondary deck-btn";
  plus.textContent = "+";
  plus.disabled = inDeck >= owned(card.id) || deckCount() >= DECK_MAX;
  plus.setAttribute("aria-label", `Add one ${card.name} to the deck`);
  plus.addEventListener("click", () => add(String(card.id)));
  row.append(minus, count, plus);

  el.append(img, name, row);
  return el;
}

export function renderDeckBuilder() {
  const area = $("deck-cards");
  if (!area) return;
  area.replaceChildren();
  const current = usableDeck();
  const n = deckCount();

  // header: count + validity + composition
  const kinds = { play: 0, workforce: 0, item: 0 };
  for (const [id, k] of Object.entries(current)) {
    const card = cards.find(c => String(c.id) === id);
    if (card) kinds[kindOf(card)] += k;
  }
  $("deck-size").textContent = `${n} / ${DECK_MAX}`;
  $("deck-size").className = n >= DECK_MIN ? "ok" : "short";
  const total = ownedTotal();
  $("deck-validity").textContent = n >= DECK_MIN
    ? "Ready to play."
    : total < DECK_MAX
      ? `A deck needs ${DECK_MAX} cards and you own ${total}: open more boosters. Until then a random deck is used.`
      : `Add ${DECK_MAX - n} more card(s): a deck needs exactly ${DECK_MAX}.`;
  $("deck-play").disabled = n < DECK_MIN;
  $("deck-play").title = n < DECK_MIN ? `The deck needs exactly ${DECK_MAX} cards` : "";
  $("deck-composition").textContent =
    `${kinds.play} regular · ${kinds.workforce} work force · ${kinds.item} item(s)`;

  const ownedCards = cards.filter(c => owned(c.id) > 0);
  if (!ownedCards.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Your collection is empty. Open some boosters first!";
    area.append(empty);
    return;
  }

  // group by type, like the collection
  ownedCards.sort((a, b) => {
    const ta = typeOrder.indexOf(norm(a.type)), tb = typeOrder.indexOf(norm(b.type));
    const oa = ta === -1 ? 99 : ta, ob = tb === -1 ? 99 : tb;
    if (oa !== ob) return oa - ob;
    const ra = rarityRank[a.rarity] || 0, rb = rarityRank[b.rarity] || 0;
    if (ra !== rb) return rb - ra;
    return String(a.name).localeCompare(String(b.name));
  });
  const groups = new Map();
  for (const card of ownedCards) {
    const t = card.type || "Unclassified";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(card);
  }
  for (const [type, list] of groups) {
    const section = document.createElement("details");
    section.className = "deck-type";
    section.open = !folded.has(type);
    section.addEventListener("toggle", () => {
      if (section.open) folded.delete(type); else folded.add(type);
      saveFolded();
    });
    const h = document.createElement("summary");
    h.className = "deck-type-heading";
    const inType = list.reduce((s, c) => s + (current[String(c.id)] || 0), 0);
    h.textContent = `${(typeInfo[type] || {}).name || type}` + (inType ? ` · ${inType} in deck` : "");
    const grid = document.createElement("div");
    grid.className = "deck-grid";
    for (const card of list) grid.append(cardTile(card, current[String(card.id)] || 0));
    section.append(h, grid);
    area.append(section);
  }
}

// ---- wiring ----
$("deck-autofill").addEventListener("click", autofill);
$("deck-clear").addEventListener("click", clearDeck);
renderDeckBuilder();