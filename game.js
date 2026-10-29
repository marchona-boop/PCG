// Card game mode: play cards from your collection onto the board.
//
// Rules
// - A deck is shuffled from the cards you own (each owned copy counts).
// - You start with HAND_SIZE cards. Each turn you play one card (or discard,
//   or pass), then draw one card.
// - Every card has a "cost". To play it you need that much work force:
//     * permanent work force cards sit on the work force board and give their
//       full value again every turn (unspent work force does not carry over);
//     * single-use work force cards stay in your hand and are consumed when
//       they are used to pay.
//   Payment is automatic: the board pays first, then the cheapest combination
//   of single-use cards in your hand covers the rest (any excess is lost).
// - Once per turn you may also place a permanent work force card on the work
//   force board. This is free in terms of turns (it doesn't end your turn),
//   but you must still pay its cost, if it has one.
// - A card can go on an empty board slot, or on top of a stack whose top card
//   SHARES A TYPE OR SUBTYPE with it and has a STRICTLY HIGHER degree.
//   Subtypes are listed as "subtypes": ["a", "b"] in cards_data.json.
// - Item cards ("type": "item") change the robustness of a card on the board
//   by their "improve robustness" value (positive or negative). Using one is
//   your play for the turn, and it is paid like any other card.
//     * permanent items attach to the targeted card (any card in a stack) and
//       modify its robustness for as long as that card stays on the board;
//     * single-use items can only be used on a card they would destroy.
//   When a card's robustness drops to 0 or below, it is destroyed together
//   with every card stacked above it (and the items attached to them).
//   Cards without a "robustness" stat cannot be destroyed.
//   Items with an "improve budget" stat work the same way on the permanent
//   work force cards on the work force board: their "budget" is changed, and a
//   work force card whose budget drops to 0 or below is destroyed.
// - Conditional effects: a card with
//     "condition": ["text1", "text2"],
//     "effect": [["reach", "+10"], ["robustness", "-5"]]
//   gets the effect while it is on a board AND at least one OTHER card of the
//   same stack has "text1" or "text2" in its name (case-insensitive). All the
//   cards on the work force board count as one stack. Any numeric stat can be
//   changed (reach, robustness, budget, workforce, degree, ...). A card without
//   "condition" but with "effect" has its effect always on while on a board.
//   If an effect drops a robustness or budget to 0 or below, the card is
//   destroyed like with items.
// - Score = sum of the reach of every card on the main board.
// - The game ends when your hand is empty, when the deck is empty and no card
//   can be played, or when you press "End game".
// - Two-player games ("Play against someone online"): one player hosts and
//   sends an invitation link, the other joins. Each plays from their own
//   collection; players alternate turns until a player starts a turn with an
//   empty deck: that round is the last one (both players get a last turn),
//   then the highest total reach wins. Cards can also be played on the
//   opponent's board or bench (they then belong to the opponent). Items can target cards on either side.
//   Connection: PeerJS (browser to browser; peerjs.min.js must sit next to
//   index.html). Add ?local=1 to the address to test with two tabs instead.

import { cards, typeInfo, collection, openCardInspection } from "./script.js";
import { deckForGame, deckSummary, renderDeckBuilder } from "./deck.js?v=2026-10-28";
import { specialFor } from "./special_cards/index.js?v=2026-10-29";

const GAME_VERSION = "2026-10-29b";

// ---- Tunable settings -------------------------------------------------------
const HAND_SIZE = 5;          // cards in hand at the start
const DECK_SIZE = 20;         // cards dealt into the deck (if you own enough)
const BOARD_SLOTS = 4;        // number of stacks that fit on the main board
const WORKFORCE_TYPE = "workforce";
const ITEM_TYPE = "item";
const ROBUSTNESS_FIELD = "robustness";
const IMPROVE_FIELD = "improve robustness";
const BUDGET_FIELD = "budget";
const IMPROVE_BUDGET_FIELD = "improve budget";
const WF_PLACEMENTS_PER_TURN = 1; // permanent work force cards placeable per turn
const BEST_KEY = "my-gacha-best-score-v1";
const STACK_BONUS = 10;       // a stack of n cards gets +STACK_BONUS*(n-1) reach
const PEER_PREFIX = "physics-card-game-";  // PeerJS ids are this + the room code
// PeerJS 1.5.4 (MIT licence): local copy first, CDN as a fallback.
const PEERJS_URLS = ["peerjs.min.js", "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"];
// -----------------------------------------------------------------------------

const $ = id => document.getElementById(id);

// Parse stat values: numbers, "infinity", "∞", or fractions "1/2".
function parseStat(value) {
  if (typeof value === "number") return value;
  const s = String(value ?? "").trim().toLowerCase();
  if (["infinity", "+infinity", "inf", "∞"].includes(s)) return Infinity;
  if (["-infinity", "-inf", "-∞"].includes(s)) return -Infinity;
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(s);
  return s !== "" && !Number.isNaN(n) ? n : NaN;
}

function formatStat(n) {
  if (n === Infinity) return "∞";
  if (n === -Infinity) return "−∞";
  if (Number.isNaN(n)) return "?";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

const nonNegative = n => (Number.isNaN(n) || n < 0 ? 0 : n);

const degreeOf = card => parseStat(card.degree);
const reachOf = card => nonNegative(parseStat(card.reach));
const costOf = card => nonNegative(parseStat(card.cost));
const workforceOf = card => nonNegative(parseStat(card.workforce));
const isWorkforce = card => normType(card.type) === normType(WORKFORCE_TYPE);
const isPermanent = card => {
  const p = card.permanent;
  return p === true || p === 1 ||
    ["true", "yes", "1"].includes(String(p ?? "").trim().toLowerCase());
};
const isPermanentWf = card => isWorkforce(card) && isPermanent(card);
// A regular card with "workforce" among its subtypes: it can go either on the
// main board (as a normal card) or on the work force bench (as permanent work force).
const isHybridWf = card => isPlayCard(card) && typesOf(card).has(normType(WORKFORCE_TYPE));
// A permanent item with "workforce" among its subtypes can be set up on the
// work force bench (e.g. a coffee machine). It provides its "workforce" stat
// (0 if none) plus any conditional effect it has there.
const isBenchItem = card =>
  isItem(card) && isPermanent(card) && typesOf(card).has(normType(WORKFORCE_TYPE));
const canJoinBench = card => isPermanentWf(card) || isHybridWf(card) || isBenchItem(card);
const onBench = inst => states().some(st => st.wfBoard.includes(inst));
const isSingleUseWf = card => isWorkforce(card) && !isPermanent(card);
const isItem = card => normType(card.type) === normType(ITEM_TYPE);
const isPlayCard = card => !isWorkforce(card) && !isItem(card);
const improveOf = card => {
  const n = parseStat(card[IMPROVE_FIELD]);
  return Number.isNaN(n) ? 0 : n;
};
const baseRobustnessOf = card => {
  const n = parseStat(card[ROBUSTNESS_FIELD]);
  return Number.isNaN(n) ? Infinity : n; // no robustness = indestructible
};
const hasStat = (card, field) => card[field] !== undefined && String(card[field]).trim() !== "";
const affectsRobustness = item => hasStat(item, IMPROVE_FIELD);
const affectsBudget = item => hasStat(item, IMPROVE_BUDGET_FIELD);
const improveBudgetOf = card => {
  const n = parseStat(card[IMPROVE_BUDGET_FIELD]);
  return Number.isNaN(n) ? 0 : n;
};
const baseBudgetOf = card => {
  const n = parseStat(card[BUDGET_FIELD]);
  return Number.isNaN(n) ? Infinity : n; // no budget = indestructible
};
// Current budget of a work force card on its board, including attached items.
const budgetOf = inst =>
  baseBudgetOf(inst.card) + (inst.items || []).reduce((s, it) => s + improveBudgetOf(it.card), 0) +
  effectBonus(inst, "budget");

// Current robustness of a card on the board, including attached items.
const robustnessOf = inst =>
  baseRobustnessOf(inst.card) + (inst.items || []).reduce((s, it) => s + improveOf(it.card), 0) +
  effectBonus(inst, "robustness");
const typeName = type => (typeInfo[type] || {}).name || type || "Unclassified";

// ---- Conditional effects ------------------------------------------------------
// Accepted "effect" formats:
//   [["reach", "+1"], ["robustness", "-1"]]   (list of pairs)
//   ["reach", "+1"]                          (a single pair)
//   {"reach": "+1", "robustness": -1}         (object)
function effectsOf(card) {
  const e = card.effect;
  if (!e) return [];
  let pairs;
  if (Array.isArray(e)) {
    pairs = e.length && !Array.isArray(e[0]) && typeof e[0] === "string" ? [e] : e;
  } else if (typeof e === "object") {
    pairs = Object.entries(e);
  } else {
    return [];
  }
  return pairs
    .filter(p => Array.isArray(p) && p.length >= 2)
    .map(([stat, value]) => ({ stat: String(stat).trim().toLowerCase(), delta: parseStat(value) }))
    .filter(x => x.stat && !Number.isNaN(x.delta));
}

function conditionsOf(card) {
  const c = card.condition;
  const list = Array.isArray(c) ? c : c === undefined || c === null ? [] : [c];
  return list.map(x => String(x).trim().toLowerCase()).filter(Boolean);
}

// The group a board card belongs to: its stack, or the whole work force board.
function groupOf(inst) {
  for (const st of states()) {
    for (const stack of st.stacks) if (stack && stack.includes(inst)) return stack;
    if (st.wfBoard.includes(inst)) return st.wfBoard;
  }
  return null;
}

// Both players' states (just yours in solo mode).
function states() {
  return [game, opp].filter(Boolean);
}

// The player who owns a card instance (the uid starts with the player's side).
function ownerOf(inst) {
  for (const st of states()) {
    if (st.hand.includes(inst) || st.deck.includes(inst) || st.wfBoard.includes(inst) ||
        st.stacks.some(stack => stack && stack.includes(inst))) return st;
  }
  // attached items: the player who played them
  return opp && String(inst.uid)[0] === opp.side ? opp : game;
}

// Is this board card's effect currently active?
function nameMatches(other, conds) {
  const name = String((other.base || other.card).name || "").toLowerCase();
  return conds.some(text => name.includes(text));
}

// Is this board card's effect currently active? (cards in a stack or on the
// work force bench: the condition is checked within that stack / the bench)
function effectActive(inst) {
  const base = inst.base || inst.card;
  if (!effectsOf(base).length) return false;
  const group = groupOf(inst);
  if (!group) return false;
  const conds = conditionsOf(base);
  if (!conds.length) return true;
  return group.some(other => other !== inst && nameMatches(other, conds));
}

// Effect of a card that is NOT in a stack or on the bench (in the hand, or an
// item attached to a card): the condition is checked against every card on
// both boards.
function looseEffectActive(inst) {
  const base = inst.base;
  const owner = ownerOf(inst);
  if (!owner || !effectsOf(base).length) return false;
  const conds = conditionsOf(base);
  if (!conds.length) return true;
  const onBoards = [...owner.stacks.flatMap(st => st || []), ...owner.wfBoard];
  return onBoards.some(other => other !== inst && nameMatches(other, conds));
}

// The card as it currently is for a hand card / attached item: a copy of the
// base card with the active effect applied to its stats.
function effectiveCard(inst) {
  const base = inst.base;
  if (!looseEffectActive(inst)) return base;
  const view = { ...base, effectActive: true };
  for (const { stat, delta } of effectsOf(base)) {
    const key = Object.keys(base).find(k => k.trim().toLowerCase() === stat) || stat;
    const current = parseStat(view[key]);
    view[key] = (Number.isNaN(current) ? 0 : current) + delta;
  }
  return view;
}

// Card instances: `base` is the card from cards_data.json; `card` gives the
// base card while the instance is on a board (board effects are added by the
// stat functions), and the effect-adjusted card everywhere else.
function makeInst(card, uid = mySide + ++uidCounter) {
  const inst = { uid, base: card };
  Object.defineProperty(inst, "card", {
    enumerable: true,
    get() { return groupOf(inst) ? inst.base : effectiveCard(inst); }
  });
  return inst;
}

// Total change applied to `stat` of a board card by its own active effect.
function effectBonus(inst, stat) {
  if (!inst || !effectActive(inst)) return 0;
  return effectsOf(inst.card)
    .filter(e => e.stat === stat)
    .reduce((sum, e) => sum + e.delta, 0);
}

function describeEffects(card) {
  const effects = effectsOf(card);
  if (!effects.length) return "";
  const sign = n => (n >= 0 ? "+" : "") + formatStat(n);
  const what = effects.map(e => `${e.stat} ${sign(e.delta)}`).join(", ");
  const conds = conditionsOf(card);
  return conds.length
    ? `${what} when “${conds.join("” or “")}” is in play (same stack on the board; anywhere on the boards from your hand)`
    : `${what} (always)`;
}

// Effective stats of cards ON A BOARD (base value + items + active effect).
const boardReach = inst => reachOf(inst.card) + effectBonus(inst, "reach");
const boardDegree = inst => degreeOf(inst.card) + effectBonus(inst, "degree");
const boardWorkforce = inst => workforceOf(inst.card) + effectBonus(inst, "workforce");

// All types of a card: its primary "type" plus any subtypes. Accepts
// "subtypes": ["a", "b"], "subtype": "a" or "subtype": ["a", "b"].
// Type names are compared ignoring case, spaces, "-" and "_", so
// "workforce", "Workforce", "work force" and "work_force" all match.
function normType(t) {
  return String(t ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

// Accepts "subtypes" or "subtype" (any case), as a list ["a", "b"] or as
// text "a" / "a, b".
function typesOf(card) {
  const set = new Set();
  if (card.type) set.add(normType(card.type));
  for (const key of Object.keys(card)) {
    if (!/^sub[\s_-]?types?$/i.test(key.trim())) continue;
    const v = card[key];
    const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : String(v).split(/[,;]/);
    for (const t of list) {
      const name = normType(t);
      if (name) set.add(name);
    }
  }
  return set;
}

// Two cards can be stacked if they share at least one type or subtype.
function sharesType(a, b) {
  const typesB = typesOf(b);
  for (const t of typesOf(a)) if (typesB.has(t)) return true;
  return false;
}

const typeListName = card => [...typesOf(card)].map(typeName).join(" / ");

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function loadBest() {
  try {
    const n = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(n) || n === Infinity ? n : 0;
  } catch {
    return 0;
  }
}

function saveBest(n) {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* ignore */ }
}

// ---- Game state -------------------------------------------------------------
let game = null;        // your state: deck, hand, boards...
let opp = null;         // opponent's state (two-player games only)
let match = null;       // null in solo; { me, turn, round, rounds, names, over, ... } in versus
let mySide = "s";       // uid prefix of the cards you create ("s" solo, "a" host, "b" guest)
let selected = null;    // index in game.hand, or null
let best = loadBest();
let uidCounter = 0;

function newGame() {
  const chosen = deckForGame();
  const pool = chosen.ids.map(id => cardById.get(id)).filter(Boolean).map(card => makeInst(card));

  if (!pool.length) {
    game = null;
    selected = null;
    render();
    setStatus("Your collection is empty — open some boosters first!");
    return;
  }

  const deck = pool;
  match = null;
  opp = null;
  game = {
    side: mySide,
    deck,
    hand: deck.splice(0, HAND_SIZE),
    stacks: Array(BOARD_SLOTS).fill(null),
    wfBoard: [],        // permanent work force cards in play
    wfSpent: 0,         // board work force spent this turn
    wfPlaced: 0,        // permanent work force cards placed this turn
    turn: 1,
    discarded: 0,
    consumed: 0,
    destroyed: 0,
    itemsUsed: 0,
    over: false,
    lastDrawn: null
  };
  selected = null;
  render();
  setStatus((chosen.custom ? "" : "Your deck isn't complete (Deck tab): playing with a random deck from your collection. ") +
    "Place work force, then pick a card to play.");
  checkStuck();
}

// ---- Work force & payment ---------------------------------------------------
const boardWfTotal = (st = game) => Math.max(0, st.wfBoard.reduce((s, inst) => s + boardWorkforce(inst), 0));
const boardWfAvailable = () => Math.max(0, boardWfTotal() - game.wfSpent);
const handWfInsts = () => game.hand.filter(inst => isSingleUseWf(inst.card));
const handWfTotal = () => handWfInsts().reduce((s, inst) => s + workforceOf(inst.card), 0);

// Work out how to pay `cost`. Returns null if it can't be paid, otherwise
// { cost, fromBoard, consume: [hand instances], fromHand, wasted }.
function paymentPlan(cost) {
  const fromBoard = Math.min(cost, boardWfAvailable());
  const need = cost - fromBoard;
  if (need <= 0) return { cost, fromBoard, consume: [], fromHand: 0, wasted: 0 };

  const temps = handWfInsts().filter(inst => workforceOf(inst.card) > 0);
  let bestSet = null, bestSum = Infinity;

  if (temps.length <= 15) {
    // Exact search: smallest total that covers the need, then fewest cards.
    for (let mask = 1; mask < (1 << temps.length); mask++) {
      let sum = 0, count = 0;
      for (let i = 0; i < temps.length; i++) {
        if (mask & (1 << i)) { sum += workforceOf(temps[i].card); count++; }
      }
      if (sum >= need && (sum < bestSum || (sum === bestSum && count < bestSet.length))) {
        bestSum = sum;
        bestSet = temps.filter((_, i) => mask & (1 << i));
      }
    }
  } else {
    // Greedy fallback for very large hands.
    const sorted = [...temps].sort((a, b) => workforceOf(b.card) - workforceOf(a.card));
    let sum = 0;
    bestSet = [];
    for (const inst of sorted) {
      if (sum >= need) break;
      bestSet.push(inst);
      sum += workforceOf(inst.card);
    }
    bestSum = sum;
    if (sum < need) bestSet = null;
  }

  if (!bestSet) return null;
  return { cost, fromBoard, consume: bestSet, fromHand: bestSum, wasted: bestSum - need };
}

function applyPayment(plan) {
  game.wfSpent += plan.fromBoard;
  const ids = new Set(plan.consume.map(inst => inst.uid));
  game.hand = game.hand.filter(inst => !ids.has(inst.uid));
  game.consumed += plan.consume.length;
}

function describePayment(plan) {
  if (!plan || plan.cost === 0) return "free";
  const parts = [];
  if (plan.fromBoard) parts.push(`${formatStat(plan.fromBoard)} from the work force board`);
  if (plan.consume.length) {
    parts.push(
      "consumes " + plan.consume
        .map(inst => `${inst.card.name} (${formatStat(workforceOf(inst.card))})`)
        .join(", ")
    );
  }
  let text = `cost ${formatStat(plan.cost)}: ${parts.join(" + ")}`;
  if (plan.wasted > 0) text += ` — ${formatStat(plan.wasted)} wasted`;
  return text;
}

function shortfall(card) {
  return costOf(card) - boardWfAvailable() - handWfTotal();
}

// ---- Special cards (see special_cards/index.js) ------------------------------
const specialApi = {
  onBench: inst => onBench(inst),
  ownerOf: inst => ownerOf(inst),
  specialId: card => String((card && card.special) || "").toLowerCase().replace(/[\s_-]+/g, ""),
  attach(holder, itemInst) {
    holder.items = holder.items || [];
    holder.items.push(itemInst);
  },
  detach(holder, itemInst) {
    holder.items = (holder.items || []).filter(it => it !== itemInst);
  },
  discardFromBench(st, inst) {
    const i = st.wfBoard.indexOf(inst);
    if (i !== -1) { st.wfBoard.splice(i, 1); st.destroyed++; }
  },
  // The player st skips their next turn ("Skip turn" card).
  skipTurn(st, itemInst) {
    st.skip = { item: itemInst, pending: true };
  },
  discardFromBoard(st, inst) {
    for (let slot = 0; slot < st.stacks.length; slot++) {
      const stack = st.stacks[slot];
      const i = stack ? stack.indexOf(inst) : -1;
      if (i === -1) continue;
      const gone = stack.splice(i);
      if (!stack.length) st.stacks[slot] = null;
      st.destroyed += gone.length;
    }
  },
  formatStat
};

// Every special card currently attached to a card on a board.
function attachedSpecials() {
  const out = [];
  for (const st of states()) {
    const holders = [...st.stacks.flatMap(stack => stack || []), ...st.wfBoard];
    for (const holder of holders) {
      for (const item of holder.items || []) {
        const sp = specialFor(item.base || item.card);
        if (sp) out.push({ sp, item, holder, holderOwner: st });
      }
    }
  }
  return out;
}

// Run a hook ("onCardPlayed" / "onTurnEnd") of every attached special card.
function runSpecialHook(hook, extra) {
  const notes = [];
  for (const a of attachedSpecials()) {
    if (typeof a.sp[hook] !== "function") continue;
    try {
      const msg = a.sp[hook](specialApi, { ...a, ...extra });
      if (msg) notes.push(msg);
    } catch (err) {
      console.error(`special card ${a.sp.id}:`, err);
    }
  }
  return notes.length ? " " + notes.join(" ") : "";
}

const cardPlayed = played => runSpecialHook("onCardPlayed", { player: game, played });

// Special cards played on the opponent's whole area (e.g. "Skip turn").
const isAreaItem = card => !!(specialFor(card) && specialFor(card).targetsOpponentArea);
function canUseOnOpponent(card) {
  const sp = specialFor(card);
  if (!sp || !sp.targetsOpponentArea || !opp || !match || match.over) return false;
  return typeof sp.canUseOnOpponent !== "function" ||
    !!sp.canUseOnOpponent(specialApi, { item: card, opponent: opp, player: game });
}

function useOnOpponentArea() {
  if (!game || game.over || !opp || !myTurn()) return;
  const itemInst = selectedInst();
  if (!itemInst || !isAreaItem(itemInst.card)) return;
  const card = itemInst.card;
  if (!canUseOnOpponent(card)) { setStatus(`${card.name} can't be used now.`); return; }
  const plan = paymentPlan(costOf(card));
  if (!plan) {
    setStatus(`Not enough work force for ${card.name}: you are ${formatStat(shortfall(card))} short.`);
    return;
  }
  applyPayment(plan);
  game.hand = game.hand.filter(i => i.uid !== itemInst.uid);
  let msg = specialFor(card).useOnOpponent(specialApi,
    { itemInst, opponent: opp, opponentName: opponentName(), player: game }) || "";
  if (plan.cost > 0) msg += ` (${describePayment(plan)})`;
  endTurn(msg + cardPlayed(itemInst));
}

// ---- Rules ------------------------------------------------------------------
function canPlaceOn(card, stack) {
  if (!stack) return true; // empty slot
  const top = stack[stack.length - 1].card;
  return sharesType(card, top) && degreeOf(card) < boardDegree(stack[stack.length - 1]);
}

function canAfford(card) {
  return paymentPlan(costOf(card)) !== null;
}

function canPlaceWorkforce() {
  return game.wfPlaced < WF_PLACEMENTS_PER_TURN;
}

// The stat an item changes on a given board card, or null if it can't target it.
function itemStatFor(item, inst) {
  if (!inst) return null;
  if (specialFor(item)) return null;
  if (!onBench(inst) && isPlayCard(inst.card) && affectsRobustness(item)) {
    return { label: "robustness", now: robustnessOf(inst), delta: improveOf(item) };
  }
  if (onBench(inst) && affectsBudget(item)) {
    return { label: "budget", now: budgetOf(inst), delta: improveBudgetOf(item) };
  }
  return null;
}

// Can this item be used on this board card?
function canUseItemOn(item, inst) {
  const sp = specialFor(item);
  if (sp) {
    if (!inst || typeof sp.canTarget !== "function") return false;
    return !!sp.canTarget(specialApi, { item, target: inst, targetOwner: ownerOf(inst) });
  }
  const stat = itemStatFor(item, inst);
  if (!stat) return false;
  if (isPermanent(item)) return true;
  return stat.now + stat.delta <= 0; // single use: must destroy
}

function itemTargets(item) {
  const out = [];
  for (const st of states()) {
    const side = st === game ? "me" : "opp";
    st.stacks.forEach((stack, slot) => {
      (stack || []).forEach((inst, index) => {
        if (canUseItemOn(item, inst)) out.push({ side, kind: "stack", slot, index });
      });
    });
    st.wfBoard.forEach((inst, index) => {
      if (canUseItemOn(item, inst)) out.push({ side, kind: "wf", index });
    });
  }
  return out;
}

// Text describing what an item would do to a board card.
function itemEffectText(item, inst, above = 0) {
  const sp = specialFor(item);
  if (sp) return typeof sp.describeTarget === "function"
    ? sp.describeTarget(specialApi, { item, target: inst, targetOwner: ownerOf(inst) }) : "";
  const stat = itemStatFor(item, inst);
  if (!stat) return "";
  const after = stat.now + stat.delta;
  if (!isPermanent(item) || after <= 0) {
    return `destroys ${inst.card.name}${above ? ` and ${above} card(s) above it` : ""}`;
  }
  return `${stat.label} ${formatStat(stat.now)} → ${formatStat(after)}`;
}

// Can this hand card do anything right now?
function hasLegalAction(card) {
  if (isSingleUseWf(card)) return false;
  if (!canAfford(card)) return false;
  if (isPermanentWf(card)) return canPlaceWorkforce();
  if (isAreaItem(card)) return canUseOnOpponent(card);
  if (isItem(card)) return itemTargets(card).length > 0 || (isBenchItem(card) && canPlaceWorkforce());
  if (isHybridWf(card) && canPlaceWorkforce()) return true;
  return states().some(st => st.stacks.some(stack => canPlaceOn(card, stack)));
}

// Reach of a stack: its cards' reach + STACK_BONUS for each card above the first.
function stackBonus(stack) {
  return stack && stack.length > 1 ? STACK_BONUS * (stack.length - 1) : 0;
}
function stackReach(stack) {
  return stack ? stack.reduce((sum, inst) => sum + boardReach(inst), 0) + stackBonus(stack) : 0;
}

function totalScore(st = game) {
  return st ? st.stacks.reduce((sum, s) => sum + stackReach(s), 0) : 0;
}

// ---- Actions ----------------------------------------------------------------
function selectedInst() {
  return game && selected !== null ? game.hand[selected] : null;
}

// Play the selected card on a slot of your board (side "me") or of the
// opponent's board (side "opp": the card then belongs to the opponent).
function playTo(slot, side = "me") {
  if (!game || game.over) return;
  const inst = selectedInst();
  if (!inst || !isPlayCard(inst.card)) return;
  const card = inst.card;
  const st = side === "opp" && opp ? opp : game;
  const where = st === game ? "" : ` on ${opponentName()}'s board`;
  const stack = st.stacks[slot];

  const plan = paymentPlan(costOf(card));
  if (!plan) {
    setStatus(`Not enough work force for ${card.name}: you are ${formatStat(shortfall(card))} short.`);
    return;
  }
  if (!canPlaceOn(card, stack)) {
    const top = stack[stack.length - 1].card;
    setStatus(
      !sharesType(card, top)
        ? `Can't stack: ${card.name} (${typeListName(card)}) shares no type or subtype with ${top.name} (${typeListName(top)}).`
        : `Can't stack: degree ${formatStat(degreeOf(card))} must be strictly lower than ${formatStat(boardDegree(stack[stack.length - 1]))}.`
    );
    return;
  }

  applyPayment(plan);
  game.hand = game.hand.filter(i => i.uid !== inst.uid);

  let message;
  inst.items = [];
  if (stack) {
    stack.push(inst);
    message = `Stacked ${card.name}${where} — combo of ${stack.length}, reach ${formatStat(stackReach(stack))}.`;
  } else {
    st.stacks[slot] = [inst];
    message = `Played ${card.name} on a new stack${where}.`;
  }
  if (plan.cost > 0) message += ` (${describePayment(plan)})`;
  endTurn(message + cardPlayed(inst));
}

function useItemOn(slot, index, side = "me") {
  useItem({ side, kind: "stack", slot, index });
}

function useItemOnWorkforce(index, side = "me") {
  useItem({ side, kind: "wf", index });
}

function useItem(where) {
  if (!game || game.over) return;
  const itemInst = selectedInst();
  if (!itemInst || !isItem(itemInst.card)) return;
  const item = itemInst.card;
  const st = where.side === "opp" && opp ? opp : game;
  const whose = st === game ? "" : `${opponentName()}'s `;
  const stack = where.kind === "stack" ? st.stacks[where.slot] : null;
  const target = where.kind === "stack" ? stack && stack[where.index] : st.wfBoard[where.index];
  if (!target) return;

  const plan = paymentPlan(costOf(item));
  if (!plan) {
    setStatus(`Not enough work force for ${item.name}: you are ${formatStat(shortfall(item))} short.`);
    return;
  }
  const stat = itemStatFor(item, target);
  if (!canUseItemOn(item, target)) {
    setStatus(
      !stat
        ? `${item.name} can't target ${target.card.name}.`
        : `${item.name} is single use: it can only be used on a card it would destroy ` +
          `(${target.card.name} has ${stat.label} ${formatStat(stat.now)}).`
    );
    return;
  }

  applyPayment(plan);
  game.hand = game.hand.filter(i => i.uid !== itemInst.uid);

  const sp = specialFor(item);
  if (sp) {
    let msg = typeof sp.use === "function"
      ? sp.use(specialApi, { itemInst, item, target, targetOwner: st, whose, player: game }) || ""
      : "";
    if (plan.cost > 0) msg += ` (${describePayment(plan)})`;
    endTurn(msg + cardPlayed(itemInst));
    return;
  }

  let message;
  if (isPermanent(item)) {
    target.items = target.items || [];
    target.items.push(itemInst);
    message = `${item.name} attached to ${whose}${target.card.name}: ${stat.label} ` +
      `${formatStat(stat.now)} → ${formatStat(itemStatFor(item, target).now)}.`;
  } else {
    game.itemsUsed++;
    message = `Used ${item.name} on ${whose}${target.card.name}.`;
  }

  const current = itemStatFor(item, target).now;
  if (!isPermanent(item) || current <= 0) {
    const scoreBefore = totalScore(st);
    const wfBefore = boardWfTotal(st);
    if (where.kind === "stack") {
      const destroyed = stack.splice(where.index);
      if (!stack.length) st.stacks[where.slot] = null;
      st.destroyed += destroyed.length;
      const lost = scoreBefore - totalScore(st);
      message += destroyed.length > 1
        ? ` ${target.card.name} and the ${destroyed.length - 1} card(s) stacked on it were destroyed (−${formatStat(lost)} reach).`
        : ` ${target.card.name} was destroyed (−${formatStat(lost)} reach).`;
    } else {
      st.wfBoard.splice(where.index, 1);
      st.destroyed++;
      message += ` ${target.card.name} was destroyed (−${formatStat(wfBefore - boardWfTotal(st))} work force per turn).`;
    }
  }
  if (plan.cost > 0) message += ` (${describePayment(plan)})`;
  endTurn(message + cardPlayed(itemInst));
}

function placeWorkforce(side = "me") {
  if (!game || game.over) return;
  const inst = selectedInst();
  if (!inst || !canJoinBench(inst.card)) return;
  const st = side === "opp" && opp ? opp : game;

  if (!canPlaceWorkforce()) {
    setStatus("You've already placed a work force card this turn.");
    return;
  }
  const plan = paymentPlan(costOf(inst.card));
  if (!plan) {
    setStatus(`Not enough work force to recruit ${inst.card.name}.`);
    return;
  }

  applyPayment(plan);
  game.hand = game.hand.filter(i => i.uid !== inst.uid);
  inst.items = [];
  st.wfBoard.push(inst);
  game.wfPlaced++;
  selected = null;

  const wf = boardWorkforce(inst);
  const whose = st === game ? "your" : `${opponentName()}'s`;
  let message = wf
    ? `${inst.card.name} joined ${whose} work force (+${formatStat(wf)} every turn${st === game ? ", starting now" : ""}).`
    : `${inst.card.name} was set up on ${st === game ? "the" : whose} work force board.`;
  message += cardPlayed(inst);
  message += resolveDestruction();
  if (plan.cost > 0) message += ` (${describePayment(plan)})`;
  render();
  setStatus(message + " Now play a card, pass or discard.");
  if (match) sendState(message);
  checkStuck();
}

function discardSelected() {
  if (!game || game.over) return;
  const inst = selectedInst();
  if (!inst) return;
  game.hand = game.hand.filter(i => i.uid !== inst.uid);
  game.discarded++;
  endTurn(`Discarded ${inst.card.name}.`);
}

function passTurn() {
  if (!game || game.over || (!match && !game.deck.length)) return;
  if (match && !myTurn()) return;
  endTurn("You passed.");
}

function endTurn(message) {
  selected = null;
  game.lastDrawn = null;
  message += runSpecialHook("onTurnEnd", { player: game });
  message += resolveDestruction();

  if (game.deck.length) {
    const drawn = game.deck.shift();
    game.hand.push(drawn);
    game.lastDrawn = drawn.uid;
    message += ` You drew ${drawn.card.name}.`;
  }

  // New turn: the work force board refreshes.
  game.wfSpent = 0;
  game.wfPlaced = 0;
  game.turn++;

  if (match) {
    // End of my bonus turn: the "Skip turn" card on the opponent is discarded.
    if (opp.skip && !opp.skip.pending) opp.skip = null;
    if (advanceTurn()) { finishMatch(message); return; }
    // The opponent has to skip this turn: it comes straight back to me.
    if (opp.skip && opp.skip.pending) {
      opp.skip.pending = false;
      message += ` ${opponentName()} skips a turn.`;
      if (advanceTurn()) { finishMatch(message); return; }
    }
    render();
    if (myTurn()) {
      setStatus(message + ` — bonus turn for you${isLastTurn() ? " (your last turn!)" : ""}.`);
    } else {
      setStatus(message + ` — ${opponentName()}'s ${isLastTurn() ? "last turn" : "turn"}.`);
    }
    sendState(message);
    return;
  }

  render();
  setStatus(message);
  checkStuck(message);
}

// Destroy any board card whose robustness/budget is now 0 or below (e.g. after
// an effect changed). Repeats until stable, since destroying a card can switch
// other effects on or off. Returns a message ("" if nothing happened).
function resolveDestruction() {
  if (!game) return "";
  const notes = [];
  for (let guard = 0; guard < 200; guard++) {
    let hit = false;
    for (const st of states()) {
      for (let slot = 0; slot < st.stacks.length && !hit; slot++) {
        const stack = st.stacks[slot];
        if (!stack) continue;
        const index = stack.findIndex(inst => robustnessOf(inst) <= 0);
        if (index === -1) continue;
        const name = stack[index].card.name;
        const destroyed = stack.splice(index);
        if (!stack.length) st.stacks[slot] = null;
        st.destroyed += destroyed.length;
        notes.push(destroyed.length > 1
          ? `${name} and ${destroyed.length - 1} card(s) on it collapsed`
          : `${name} collapsed`);
        hit = true;
      }
      if (!hit) {
        const index = st.wfBoard.findIndex(inst => budgetOf(inst) <= 0);
        if (index !== -1) {
          notes.push(`${st.wfBoard[index].card.name} ran out of budget`);
          st.wfBoard.splice(index, 1);
          st.destroyed++;
          hit = true;
        }
      }
      if (hit) break;
    }
    if (!hit) break;
  }
  return notes.length ? ` Effects: ${notes.join("; ")}.` : "";
}

// Two-player games: pass the turn to the other player. A round ends after the
// second player. When a player starts a turn with an empty deck, the current
// round becomes the last one. Returns true when the game is over.
function advanceTurn() {
  if (match.turn === 1) match.round++;
  match.turn = 1 - match.turn;
  if (match.lastRound && match.round > match.lastRound) return true;
  const next = match.turn === match.me ? game : opp;
  if (!match.lastRound && !next.deck.length) match.lastRound = match.round;
  return false;
}
const isLastTurn = () => !!(match && match.lastRound && match.round === match.lastRound);
const roundsPlayed = () => (match ? (match.lastRound || match.round) : 0);

// End the game automatically when nothing more can happen.
function checkStuck(lastMessage = "") {
  if (!game || game.over || match) return; // two-player games end after the last round
  const prefix = lastMessage ? lastMessage + " " : "";
  if (!game.hand.length) {
    finishGame(prefix + "Your hand is empty.");
  } else if (!game.deck.length && !game.hand.some(inst => hasLegalAction(inst.card))) {
    finishGame(prefix + "The deck is empty and no card in your hand can be played.");
  }
}

function finishGame(prefix = "") {
  if (!game || game.over) return;
  game.over = true;
  selected = null;

  const score = totalScore();
  let message = `${prefix} Game over — final score ${formatStat(score)}.`.trim();
  if (score > best) {
    best = score;
    saveBest(best);
    message += " New best score!";
  }
  render();
  setStatus(message);
}

// ---- Rendering --------------------------------------------------------------
function setStatus(text) {
  $("game-status").textContent = text;
}

function badge(className, text, title) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

function makeGameCard(card) {
  const el = document.createElement("article");
  const rarityClass = String(card.rarity).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  el.className = `card game-card rarity-${rarityClass}`;
  el.dataset.type = card.type || "";
  if (isWorkforce(card)) {
    el.classList.add("wf-card", isPermanent(card) ? "wf-permanent" : "wf-single");
  }
  if (isItem(card)) {
    el.classList.add("item-card", isPermanent(card) ? "item-permanent" : "item-single");
  }

  const head = document.createElement("div");
  head.className = "gc-head";
  const name = document.createElement("span");
  name.className = "gc-name";
  name.textContent = card.name;
  head.append(name);
  if (isPlayCard(card)) {
    head.append(badge("gc-degree", formatStat(degreeOf(card)), "Degree"));
  }

  const art = document.createElement("div");
  art.className = "gc-art";
  const img = document.createElement("img");
  img.src = card.image;
  img.alt = card.name;
  img.loading = "lazy";
  art.append(img);

  const foot = document.createElement("div");
  foot.className = "gc-foot";
  const type = document.createElement("span");
  type.className = "gc-type";
  if (!isPlayCard(card)) {
    type.textContent = (isItem(card) ? "Item · " : "") + (isPermanent(card) ? "Permanent" : "Single use");
    foot.append(type);
  } else {
    const info = typeInfo[card.type] || {};
    if (info.logo) {
      const logo = document.createElement("img");
      logo.className = "gc-type-logo";
      logo.src = info.logo;
      logo.alt = "";
      logo.onerror = () => logo.remove();
      type.append(logo);
    }
    type.append(document.createTextNode(info.name || card.type || ""));
    foot.append(type, badge("gc-reach", formatStat(reachOf(card)), "Reach"));
  }

  el.append(head, art, foot);
  return el;
}

function makeActivatable(el, label, onActivate) {
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", label);
  el.addEventListener("click", onActivate);
  el.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(event);
    }
  });
}

function render() {
  if (match && !myTurn()) selected = null;
  renderHud();
  renderWorkforceBoard();
  renderBoard();
  renderOpponent();
  renderHand();
  renderSelectionBar();
  const active = game && !game.over;
  const inMatch = match && !match.over;
  $("end-game").disabled = !active || !!match;
  $("pass-turn").disabled = !active || (match ? !myTurn() : !game.deck.length);
  $("new-game").disabled = !!inMatch;
  $("new-game").textContent = active && !match ? "Restart" : "New game";
  $("host-game").disabled = !!inMatch || netBusy;
  $("join-game").disabled = !!inMatch || netBusy;
}

// "Skip turn" card shown on top of the area of the player who skips.
function renderSkip(zone, st) {
  zone.querySelectorAll(":scope > .skip-overlay").forEach(el => el.remove());
  if (!st || !st.skip) return;
  const box = document.createElement("div");
  box.className = "skip-overlay";
  const img = document.createElement("img");
  img.src = st.skip.item.card.image;
  img.alt = st.skip.item.card.name;
  img.title = `${st.skip.item.card.name} — click to inspect`;
  img.addEventListener("click", e => { e.stopPropagation(); openCardInspection(st.skip.item.card); });
  const label = document.createElement("span");
  label.textContent = st.skip.pending ? "Skips the next turn" : "Turn skipped";
  box.append(img, label);
  zone.append(box);
}

function renderOpponent() {
  renderSkip($("my-zone"), match ? game : null);
  renderSkip($("opponent-zone"), match ? opp : null);
  const sel = selectedInst();
  const areaTarget = !!(sel && isAreaItem(sel.card) && canUseOnOpponent(sel.card) && canAfford(sel.card));
  $("opponent-zone").classList.toggle("area-target", areaTarget);
  const zone = $("opponent-zone");
  zone.hidden = !match || !opp;
  $("hud-round-box").hidden = !match;
  $("hud-h-box").hidden = !match;
  $("hud-opp-h-box").hidden = !match;
  $("hud-h").textContent = String(myH());
  $("hud-opp-box").hidden = !match;
  $("hud-best-box").hidden = !!match;
  if (!match || !opp) {
    $("turn-banner").hidden = true;   // no "your turn" / result banner outside online games
    return;
  }
  renderWorkforceBoard(opp, $("opp-wf-board"), "opp");
  renderBoard(opp, $("opp-board"), "opp");
  $("opp-title").textContent = opponentName();
  $("opp-summary").textContent =
    (oppHIndex() === null ? "" : `h± ${oppHIndex()} · `) +
    `score ${formatStat(totalScore(opp))} · work force ${formatStat(boardWfTotal(opp))}` +
    ` · ${opp.hand.length} card(s) in hand · deck ${opp.deck.length}`;
  $("hud-round").textContent = match.lastRound ? `${Math.min(match.round, match.lastRound)} · last` : `${match.round}`;
  const oh = oppHIndex();
  $("hud-opp-h").textContent = oh === null ? "?" : String(oh);
  $("hud-opp").textContent = formatStat(totalScore(opp));
  $("turn-banner").hidden = false;
  $("turn-banner").className = "turn-banner " + (match.over ? "over" : myTurn() ? "mine" : "theirs");
  $("turn-banner").textContent = match.over
    ? matchResultText()
    : myTurn()
      ? (isLastTurn() ? "Your LAST turn!" : opp.skip && !opp.skip.pending ? "Your bonus turn" : "Your turn")
      : `${opponentName()}'s ${isLastTurn() ? "last turn" : "turn"} — waiting…`;
  $("turn-banner").classList.toggle("last", !match.over && isLastTurn());
}

function renderHud() {
  $("hud-score").textContent = formatStat(totalScore());
  $("hud-best").textContent = formatStat(best);
  $("hud-turn").textContent = game ? game.turn : 0;
  $("hud-deck").textContent = game ? game.deck.length : 0;
  $("hud-wf").textContent = game
    ? `${formatStat(boardWfAvailable())}/${formatStat(boardWfTotal())}`
    : "0";
  $("hud-wf-hand").textContent = game ? "+" + formatStat(handWfTotal()) : "+0";
}

function renderWorkforceBoard(st = game, zone = $("wf-board"), side = "me") {
  zone.replaceChildren();
  zone.className = "wf-board" + (side === "opp" ? " opp" : "");

  const inst = selectedInst();
  const placing = !!(game && !game.over && inst && canJoinBench(inst.card));
  const ok = placing && canPlaceWorkforce() && canAfford(inst.card);
  if (placing) zone.classList.add(ok ? "valid-target" : "invalid-target");
  const selItem = inst && isItem(inst.card) && !isAreaItem(inst.card) ? inst.card : null;
  const affordable = selItem ? canAfford(selItem) : false;

  // Label in the middle of the bench (the cards cover it as the bench fills up).
  const label = document.createElement("p");
  label.className = "wf-empty";
  label.textContent = placing
    ? "Place work force here"
    : side === "opp" ? `${opponentName()}'s work force` : match ? "Your work force" : "Work force";
  zone.append(label);
  if (st && st.wfBoard.length) {
    st.wfBoard.forEach((w, index) => {
      const el = makeGameCard(w.card);
      addBoardOverlays(el, w);
      const benchItem = selItem && isBenchItem(selItem) && canUseItemOn(selItem, w) === false;
      if (benchItem) {
        // Setting up a bench item: clicking an existing bench card just places
        // it on the board (the click goes through to the work force zone).
      } else if (selItem) {
        const valid = affordable && canUseItemOn(selItem, w);
        el.classList.add(valid ? "item-target" : "item-invalid");
        const effect = itemEffectText(selItem, w);
        el.title = valid ? `Use ${selItem.name}: ${effect}` : `${selItem.name} can't be used on ${w.card.name}`;
        makeActivatable(el, `Use ${selItem.name} on ${w.card.name}${valid ? `: ${effect}` : " (not allowed)"}`, event => {
          event.stopPropagation();
          useItemOnWorkforce(index, side);
        });
      } else {
        el.addEventListener("click", event => {
          if (selected === null) {
            event.stopPropagation();
            openCardInspection(w.card);
          }
        });
      }
      zone.append(el);
    });
  }

  // The zone itself is a button only while placing a permanent work force card
  // (its click handler is attached once, in the wiring section below).
  if (placing) {
    zone.tabIndex = 0;
    zone.setAttribute("role", "button");
    zone.setAttribute("aria-label", `Place ${inst.card.name} on ${side === "opp" ? opponentName() + "'s" : "your"} work force board`);
  } else {
    zone.removeAttribute("role");
    zone.removeAttribute("tabindex");
    zone.removeAttribute("aria-label");
  }

}

function renderBoard(st = game, board = $("board"), side = "me") {
  board.replaceChildren();
  board.classList.toggle("opp", side === "opp");

  const stacks = st ? st.stacks : Array(BOARD_SLOTS).fill(null);
  const inst = selectedInst();
  const selCard = inst && isPlayCard(inst.card) ? inst.card : null;   // placing a card (either board)
  const selItem = inst && isItem(inst.card) && !isAreaItem(inst.card) ? inst.card : null;  // targeting with an item
  const affordable = inst ? canAfford(inst.card) : false;

  stacks.forEach((stack, slot) => {
    const slotEl = document.createElement("div");
    slotEl.className = "slot";

    const valid = selCard && affordable && canPlaceOn(selCard, stack);
    if (valid) slotEl.classList.add("valid-target");
    if (selCard && !valid) slotEl.classList.add("invalid-target");

    if (!stack) {
      slotEl.classList.add("empty-slot");
      const label = document.createElement("span");
      label.textContent = valid ? "Play here" : "Empty slot";
      slotEl.append(label);
    } else {
      const pile = document.createElement("div");
      pile.className = "stack";
      stack.forEach((s, i) => {
        const cardEl = makeGameCard(s.card);
        cardEl.style.setProperty("--i", i);
        if (i === stack.length - 1) cardEl.classList.add("top");
        addBoardOverlays(cardEl, s);

        if (selItem) {
          const ok = affordable && canUseItemOn(selItem, s);
          cardEl.classList.add(ok ? "item-target" : "item-invalid");
          const effect = itemEffectText(selItem, s, stack.length - 1 - i);
          cardEl.title = ok ? `Use ${selItem.name}: ${effect}` : `${selItem.name} can't be used on ${s.card.name}`;
          makeActivatable(cardEl, `Use ${selItem.name} on ${s.card.name}${ok ? `: ${effect}` : " (not allowed)"}`, event => {
            event.stopPropagation();
            useItemOn(slot, i, side);
          });
        } else {
          cardEl.addEventListener("click", event => {
            if (selected === null) {
              event.stopPropagation();
              openCardInspection(s.card);
            }
          });
        }
        pile.append(cardEl);
      });

      const top = stack[stack.length - 1].card;
      const info = document.createElement("p");
      info.className = "stack-info";
      info.title = `${typeName(top.type)} · ${stack.length} card(s)`;
      const r = document.createElement("strong");
      r.textContent = `Reach ${formatStat(stackReach(stack))}`;
      info.append(r);
      if (stack.length > 1) {
        const t = document.createElement("span");
        t.textContent = ` ×${stack.length} (+${stackBonus(stack)})`;
        t.title = `Stack bonus: +${STACK_BONUS} reach per card above the first`;
        info.append(t);
      }
      slotEl.append(pile, info);
    }

    if (selCard) {
      makeActivatable(
        slotEl,
        `Play ${selCard.name} on ${side === "opp" ? opponentName() + "'s" : "your"} slot ${slot + 1}${valid ? "" : " (not allowed)"}`,
        () => playTo(slot, side)
      );
    }
    board.append(slotEl);
  });
}

// Attached item thumbnails and the modified robustness, drawn in the visible
// top strip of a board card.
function addBoardOverlays(cardEl, inst) {
  const items = inst.items || [];
  const active = effectActive(inst);
  if (effectsOf(inst.card).length) {
    cardEl.classList.toggle("effect-on", active);
    cardEl.title = `${active ? "Effect active" : "Effect inactive"}: ${describeEffects(inst.card)}`;
  }
  const isWfCard = onBench(inst);
  const statBase = isWfCard ? baseBudgetOf(inst.card) : baseRobustnessOf(inst.card);
  const statNow = isWfCard ? budgetOf(inst) : robustnessOf(inst);
  const reachDelta = isWfCard ? 0 : boardReach(inst) - reachOf(inst.card);
  if (!items.length && statNow === statBase && !reachDelta) return;

  const strip = document.createElement("div");
  strip.className = "gc-attached";
  for (const it of items) {
    const chip = document.createElement("img");
    chip.className = "gc-item-chip";
    chip.src = it.card.image;
    chip.alt = it.card.name;
    const d = isWfCard ? improveBudgetOf(it.card) : improveOf(it.card);
    chip.title = `${it.card.name} (${d >= 0 ? "+" : ""}${formatStat(d)} ${isWfCard ? "budget" : "robustness"})`;
    chip.addEventListener("click", event => {
      if (selected === null) {
        event.stopPropagation();
        openCardInspection(it.card);
      }
    });
    strip.append(chip);
    // Special cards can show a counter on their icon (e.g. turns left).
    const sp = specialFor(it.base || it.card);
    if (sp && typeof sp.chip === "function") {
      const info = sp.chip(specialApi, { item: it, holder: inst, holderOwner: ownerOf(inst) }) || {};
      if (info.title) chip.title = info.title;
      if (info.badge) {
        const b = document.createElement("span");
        b.className = "gc-chip-badge";
        b.textContent = info.badge;
        b.title = info.title || "";
        strip.append(b);
      }
    }
  }

  const isWf = isWfCard;
  const base = statBase;
  const now = statNow;
  const spacer = document.createElement("span");
  spacer.className = "gc-spacer";
  strip.append(spacer);
  if (reachDelta) {
    const r = document.createElement("span");
    r.className = "gc-rob reach " + (reachDelta > 0 ? "up" : "down");
    r.textContent = formatStat(boardReach(inst));
    r.title = `Reach ${formatStat(reachOf(inst.card))} → ${formatStat(boardReach(inst))}`;
    strip.append(r);
  }
  if (items.some(it => !specialFor(it.base || it.card)) || now !== base) {
    const rob = document.createElement("span");
    rob.className = "gc-rob " + (isWf ? "budget " : "") + (now > base ? "up" : now < base ? "down" : "");
    rob.textContent = formatStat(now);
    rob.title = `${isWf ? "Budget" : "Robustness"} ${formatStat(base)} → ${formatStat(now)}`;
    strip.append(rob);
  }

  cardEl.append(strip);
}

function renderHand() {
  const hand = $("hand");
  hand.replaceChildren();

  if (!game) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Open “Solo game” and press “New game”, or play against someone online.";
    hand.append(empty);
    return;
  }

  if (game.over) {
    const over = document.createElement("p");
    over.className = "empty";
    over.textContent = match
      ? `${matchResultText()} Host or join a new game, or press “New game” to play solo.`
      : `Game over — final score ${formatStat(totalScore())}. Press “New game” to play again.`;
    hand.append(over);
    return;
  }

  game.hand.forEach((inst, index) => {
    const card = inst.card;
    const el = makeGameCard(card);
    el.classList.add("in-hand");
    if (index === selected) el.classList.add("selected");
    if (isSingleUseWf(card)) el.classList.add("resource");
    else if (!hasLegalAction(card)) el.classList.add("no-move");
    if (inst.uid === game.lastDrawn) el.classList.add("reveal");
    if (effectsOf(inst.base).length) {
      el.classList.toggle("effect-on", !!card.effectActive);
      el.title = `${card.effectActive ? "Effect active" : "Effect inactive"}: ${describeEffects(inst.base)}`;
    }

    const desc = isWorkforce(card)
      ? `${card.name}, work force +${formatStat(workforceOf(card))}, ${isPermanent(card) ? "permanent" : "single use"}`
      : isItem(card)
      ? `${card.name}, item, ${isPermanent(card) ? "permanent" : "single use"}, robustness ${formatStat(improveOf(card))}, budget ${formatStat(improveBudgetOf(card))}, cost ${formatStat(costOf(card))}`
      : `${card.name}, ${typeName(card.type)}, cost ${formatStat(costOf(card))}, degree ${formatStat(degreeOf(card))}, reach ${formatStat(reachOf(card))}`;

    if (match && !myTurn()) {
      // Not your turn: cards can still be inspected.
      el.classList.add("waiting");
      makeActivatable(el, `Inspect ${card.name}`, () => openCardInspection(card));
      el.title = "Click to inspect";
      hand.append(el);
      return;
    }
    makeActivatable(el, `${desc}. ${index === selected ? "Selected." : "Select."}`, () => {
      selected = selected === index ? null : index;
      render();
      if (selected !== null) setStatus(hintFor(card));
    });
    el.setAttribute("aria-pressed", String(index === selected));
    hand.append(el);
  });
}

function hintFor(card) {
  if (isSingleUseWf(card)) {
    return "Single-use work force is spent automatically when you play a card. You can also discard it.";
  }
  if (!canAfford(card)) {
    return `Not enough work force: you are ${formatStat(shortfall(card))} short. Pass or discard to move on.`;
  }
  if (isPermanentWf(card)) {
    return canPlaceWorkforce()
      ? "Click the work force board to place it."
      : "You've already placed a work force card this turn.";
  }
  if (isHybridWf(card)) {
    const board = states().some(st => st.stacks.some(stack => canPlaceOn(card, stack)));
    const bench = canPlaceWorkforce();
    if (board && bench) return "Choose a highlighted slot on the board, or click the work force board to recruit it as work force.";
    if (bench) return "No legal place on the board, but you can click the work force board to recruit it as work force.";
    if (board) return "Choose a highlighted slot on the board (you've already placed work force this turn).";
    return "No legal place for this card right now — you can discard it.";
  }
  if (isBenchItem(card)) {
    const targets = itemTargets(card).length > 0;
    const bench = canPlaceWorkforce();
    if (targets && bench) return "Click the work force board to set it up there, or a highlighted card to use it on.";
    if (bench) return "Click the work force board to set it up there.";
    if (targets) return "Click a highlighted card to use it on (you've already placed work force this turn).";
    return "You've already placed something on the work force board this turn.";
  }
  if (isAreaItem(card)) {
    if (!match || !opp) return "This card can only be played against an opponent (online game).";
    return canUseOnOpponent(card)
      ? `Click anywhere on ${opponentName()}'s area to play it.`
      : "It can't be played right now.";
  }
  if (isItem(card)) {
    if (hasLegalAction(card)) return "Click a highlighted card on the board to use this item on it.";
    return isPermanent(card)
      ? "There is no card on the boards this item can be attached to."
      : "This single-use item can't destroy any card on the boards right now.";
  }
  return hasLegalAction(card)
    ? "Choose a highlighted slot on the board."
    : "No legal place for this card on the board — you can discard it.";
}

function renderSelectionBar() {
  const bar = $("selection-bar");
  const inst = selectedInst();
  if (!game || game.over || !inst) {
    bar.hidden = true;
    return;
  }
  const card = inst.card;
  bar.hidden = false;

  let text;
  if (isWorkforce(card)) {
    text = `${card.name} — work force +${formatStat(workforceOf(card))} · ` +
      (isPermanent(card) ? "permanent" : "single use") +
      (isPermanent(card) && baseBudgetOf(card) !== Infinity ? ` · budget ${formatStat(baseBudgetOf(card))}` : "");
    if (isPermanentWf(card) && costOf(card) > 0) {
      const plan = paymentPlan(costOf(card));
      text += plan ? ` · ${describePayment(plan)}` : ` · cost ${formatStat(costOf(card))} (can't afford)`;
    }
  } else if (isItem(card)) {
    const plan = paymentPlan(costOf(card));
    const effects = [];
    const sign = n => (n >= 0 ? "+" : "") + formatStat(n);
    if (affectsRobustness(card)) effects.push(`robustness ${sign(improveOf(card))}`);
    if (affectsBudget(card)) effects.push(`budget ${sign(improveBudgetOf(card))}`);
    const spc = specialFor(card);
    if (spc && typeof spc.describe === "function") effects.push(spc.describe(card));
    text = `${card.name} — item · ${isPermanent(card) ? "permanent" : "single use"}` +
      (effects.length ? ` · ${effects.join(" · ")}` : "") + " · " +
      (plan ? describePayment(plan) : `cost ${formatStat(costOf(card))} (can't afford)`);
  } else {
    const plan = paymentPlan(costOf(card));
    const rob = baseRobustnessOf(card);
    text = `${card.name} — ${typeName(card.type)} · degree ${formatStat(degreeOf(card))}` +
      ` · reach ${formatStat(reachOf(card))}` +
      (rob === Infinity ? "" : ` · robustness ${formatStat(rob)}`) + " · " +
      (plan ? describePayment(plan) : `cost ${formatStat(costOf(card))} (can't afford)`);
  }
  if (isBenchItem(card)) {
    text += " · can be set up on the work force board" +
      (workforceOf(card) ? ` (+${formatStat(workforceOf(card))})` : "");
  }
  if (isHybridWf(card)) {
    text += ` · can also join the work force (+${formatStat(workforceOf(card))}` +
      (baseBudgetOf(card) !== Infinity ? `, budget ${formatStat(baseBudgetOf(card))}` : "") + ")";
  }
  const eff = describeEffects(inst.base);
  if (eff) text += ` · effect${card.effectActive ? " (active)" : ""}: ${eff}`;
  $("selection-text").textContent = text;
}

// ---- Two-player games ---------------------------------------------------------
// One player hosts (side "a", plays first), the other joins (side "b"). Both
// browsers hold the full game; the player whose turn it is applies their
// actions and sends the new state to the other after each action.
let net = null;        // { send(msg), close() } once connected
let netBusy = false;   // connecting

// ---- h± index: personal ranking, saved in this browser ----
// h± = the largest number h such that you have won at least h online games by
// a margin of at least H_STEP*h points. Example (H_STEP = 10): wins by 100, 2,
// 10, 20, 20 -> h± = 2 (two wins by >= 20); to reach 3 you need three wins by
// >= 30, i.e. two more. Only games played to the end count.
const H_STEP = 10;
const HINDEX_KEY = "my-gacha-hindex-v2";
function loadHIndex() {
  try {
    const o = JSON.parse(localStorage.getItem(HINDEX_KEY) || "{}");
    return {
      wins: Array.isArray(o.wins) ? o.wins.filter(Number.isFinite) : [],   // winning margins
      games: Number.isSafeInteger(o.games) ? o.games : 0,
      // losses were not counted before: older games without a win count as losses
      losses: Number.isSafeInteger(o.losses) ? o.losses
        : Math.max(0, (Number.isSafeInteger(o.games) ? o.games : 0) - (Array.isArray(o.wins) ? o.wins.length : 0)),
      recorded: Array.isArray(o.recorded) ? o.recorded.slice(-50) : []
    };
  } catch {
    return { wins: [], games: 0, losses: 0, recorded: [] };
  }
}
let hindex = loadHIndex();
function saveHIndex() {
  try { localStorage.setItem(HINDEX_KEY, JSON.stringify(hindex)); } catch { /* ignore */ }
}

// h± of a list of winning margins.
function hOf(wins) {
  const sorted = [...wins].filter(m => m > 0).sort((a, b) => b - a);
  let h = 0;
  while (h < sorted.length && sorted[h] >= H_STEP * (h + 1)) h++;
  return h;
}
const myH = () => hOf(hindex.wins);

// What is needed to reach h+1.
function nextHText(wins) {
  const h = hOf(wins), need = H_STEP * (h + 1);
  const have = wins.filter(m => m >= need).length;
  const missing = h + 1 - have;
  return `${missing} more win${missing > 1 ? "s" : ""} by ≥ ${need} for h± = ${h + 1}`;
}

// Add the result of the finished match to your record (once per match).
// Returns a short message, or "" if nothing changed.
function recordMatch() {
  if (!match || !match.over || !opp || !match.id) return "";
  if (match.resigned !== undefined && match.resigned !== null) return ""; // abandoned games don't count
  if (hindex.recorded.includes(match.id)) return "";
  const margin = totalScore() - totalScore(opp);
  if (!Number.isFinite(margin)) return "";
  const before = myH();
  if (margin > 0) hindex.wins.push(margin);
  hindex.games++;
  if (margin < 0) hindex.losses++;
  hindex.recorded = [...hindex.recorded, match.id].slice(-50);
  saveHIndex();
  renderHIndex();
  const after = myH();
  return after !== before
    ? ` Your h± index: ${before} → ${after}!`
    : ` Your h± index: ${after} (${nextHText(hindex.wins)}).`;
}

// The opponent's h± index (updated with this game's result once it is over).
function oppHIndex() {
  if (!match || !match.hw) return null;
  const wins = [...(match.hw[1 - match.me] || [])];
  if (match.over && (match.resigned === undefined || match.resigned === null)) {
    const m = totalScore(opp) - totalScore();
    if (Number.isFinite(m) && m > 0) wins.push(m);
  }
  return hOf(wins);
}

function renderHIndex() {
  $("my-hindex").textContent = String(myH());
  $("stat-games").textContent = String(hindex.games);
  $("stat-wins").textContent = String(hindex.wins.length);
  $("stat-losses").textContent = String(hindex.losses);
  const draws = hindex.games - hindex.wins.length - hindex.losses;
  $("my-hindex-games").textContent = hindex.games
    ? (draws > 0 ? `${draws} draw${draws > 1 ? "s" : ""} · ` : "") + `next: ${nextHText(hindex.wins)}`
    : "Online games played to the end count for your h± index.";
}

const myTurn = () => !match || match.turn === match.me;
const opponentName = () => (match && match.names[1 - match.me]) || "Opponent";
const myName = () => (match && match.names[match.me]) || "You";
const cardById = new Map(cards.map(c => [String(c.id), c]));

function matchResultText() {
  if (!match || !opp) return "";
  const mine = totalScore(), theirs = totalScore(opp);
  const scores = `${formatStat(mine)} – ${formatStat(theirs)}`;
  if (match.resigned !== undefined && match.resigned !== null) {
    return match.resigned === match.me
      ? `You left the game (${scores}).`
      : `${opponentName()} left the game — you win (${scores})!`;
  }
  if (mine > theirs) return `You win ${scores}!`;
  if (mine < theirs) return `${opponentName()} wins ${scores}.`;
  return `Draw ${scores}.`;
}

function finishMatch(message = "", { send = true } = {}) {
  if (!match) return;
  match.over = true;
  game.over = true;
  if (opp) opp.over = true;
  selected = null;
  const h = recordMatch();
  render();
  setStatus(`${message} ${match.resigned != null ? "" : roundsPlayed() + " rounds played — "}${matchResultText()}${h}`.trim());
  if (send) sendState(message);
}

// Build a deck (list of card ids) from your own collection.
function deckIdsFromCollection() {
  return deckForGame().ids;
}

function newPlayerState(side, deckIds) {
  const deck = deckIds
    .map(id => cardById.get(String(id)))
    .filter(Boolean)
    .map((card, i) => makeInst(card, side + (i + 1)));
  return {
    side, deck, hand: deck.splice(0, HAND_SIZE),
    stacks: Array(BOARD_SLOTS).fill(null), wfBoard: [],
    wfSpent: 0, wfPlaced: 0, turn: 1, discarded: 0, consumed: 0,
    destroyed: 0, itemsUsed: 0, over: false, lastDrawn: null, skip: null
  };
}

// ---- (de)serialisation of the game state ----
function serInst(inst) {
  const o = { u: inst.uid, id: inst.base.id };
  if (inst.data) o.d = inst.data;
  if (inst.items && inst.items.length) o.it = inst.items.map(serInst);
  return o;
}

function deInst(o) {
  const card = cardById.get(String(o.id));
  if (!card) throw new Error(`Unknown card id ${o.id} (are both players on the same version of the site?)`);
  const inst = makeInst(card, o.u);
  inst.items = (o.it || []).map(deInst);
  if (o.d) inst.data = o.d;
  return inst;
}

function serPlayer(st) {
  return {
    side: st.side,
    deck: st.deck.map(serInst), hand: st.hand.map(serInst),
    stacks: st.stacks.map(stack => (stack ? stack.map(serInst) : null)),
    wfBoard: st.wfBoard.map(serInst),
    wfSpent: st.wfSpent, wfPlaced: st.wfPlaced, turn: st.turn, discarded: st.discarded,
    consumed: st.consumed, destroyed: st.destroyed, itemsUsed: st.itemsUsed,
    over: st.over, lastDrawn: st.lastDrawn,
    skip: st.skip ? { item: serInst(st.skip.item), pending: !!st.skip.pending } : null
  };
}

function dePlayer(o) {
  return {
    ...o,
    deck: o.deck.map(deInst), hand: o.hand.map(deInst),
    stacks: o.stacks.map(stack => (stack ? stack.map(deInst) : null)),
    wfBoard: o.wfBoard.map(deInst),
    skip: o.skip ? { item: deInst(o.skip.item), pending: !!o.skip.pending } : null
  };
}

function sendState(log = "") {
  if (!net || !match) return;
  const players = [];
  players[match.me] = serPlayer(game);
  players[1 - match.me] = serPlayer(opp);
  const { me, ...shared } = match;
  net.send({ t: "state", players, match: shared, log, from: match.me });
}

function receiveState(msg) {
  const me = match ? match.me : (mySide === "a" ? 0 : 1);
  const wasMyTurn = match && myTurn();
  match = { ...msg.match, me };
  game = dePlayer(msg.players[me]);
  opp = dePlayer(msg.players[1 - me]);
  selected = null;
  const h = match.over ? recordMatch() : "";
  render();
  const what = msg.log ? `${opponentName()}: ${opponentView(msg.log)}` : "";
  if (match.over) {
    setStatus(`${what} ${match.resigned != null ? "" : roundsPlayed() + " rounds played — "}${matchResultText()}${h}`.trim());
  } else if (myTurn() && !wasMyTurn) {
    setStatus(`${what} — ${isLastTurn() ? "your LAST turn" : "your turn"} (round ${match.round}).`.replace(/^ — /, ""));
  } else if (what) {
    setStatus(what);
  }
}

// Rewrite the active player's message for the opponent: hide what they drew
// and switch "you"/"your" to the right person.
function opponentView(log) {
  return log
    .replace(/ You drew [^.]*\./g, "")
    .replace(/^You passed\./, "passed.")
    .replace(/\byour work force\b/g, "their work force")
    .replace(/ Now play a card, pass or discard\./g, "")
    .split(`${myName()}'s `).join("your ")
    .trim();
}

// ---- messages ----
function onNetMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.t === "hello" && mySide === "a" && !match) {
      // Host: the guest sent their name and deck -> set up the game.
      match = {
        id: randomCode() + Date.now().toString(36),
        me: 0, turn: 0, round: 1, lastRound: null, over: false, resigned: null,
        names: [$("player-name").value.trim() || "Host", String(msg.name || "Guest").slice(0, 24)],
        hw: [hindex.wins, Array.isArray(msg.wins) ? msg.wins.filter(Number.isFinite).slice(-500) : []]
      };
      game = newPlayerState("a", deckIdsFromCollection());
      opp = newPlayerState("b", Array.isArray(msg.deck) ? msg.deck : []);
      selected = null;
      setNet(`Connected to ${opponentName()}.`);
      $("versus-panel").open = false;
      showView("play-view");
      render();
      setStatus("Game on! The game ends after the round in which a player runs out of cards to draw — you start.");
      sendState("");
    } else if (msg.t === "state") {
      if (!match) { setNet("Connected."); $("versus-panel").open = false; }
      showView("play-view");
      receiveState(msg);
    } else if (msg.t === "bye" && match && !match.over) {
      match.resigned = 1 - match.me;
      finishMatch("", { send: false });
    }
  } catch (err) {
    console.error(err);
    setNet("Error: " + err.message);
  }
}

function onNetClosed() {
  net = null;
  netBusy = false;
  if (match && !match.over) {
    match.resigned = 1 - match.me;
    finishMatch("Connection lost.", { send: false });
  }
  setNet("Disconnected.");
  render();
}

function setNet(text) {
  $("net-status").textContent = text;
}

// ---- transports ----
// PeerJS (browser-to-browser over the internet). Loaded only when needed.
async function loadPeerJs() {
  for (const src of PEERJS_URLS) {
    if (window.Peer) return;
    await new Promise(resolve => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = el.onerror = () => resolve();
      document.head.append(el);
    });
  }
  if (!window.Peer) throw new Error("could not load PeerJS (are you online?)");
}

function wrapPeerConnection(conn, peer) {
  conn.on("data", onNetMessage);
  conn.on("close", onNetClosed);
  conn.on("error", err => setNet("Connection error: " + err));
  return {
    send: msg => conn.open && conn.send(msg),
    close: () => { try { conn.close(); peer.destroy(); } catch { /* ignore */ } }
  };
}

// Local transport between two tabs of the same browser (for testing):
// add ?local=1 to the address of both tabs.
function localTransport(code) {
  const ch = new BroadcastChannel(PEER_PREFIX + code);
  ch.onmessage = e => onNetMessage(e.data);
  return { send: msg => ch.postMessage(msg), close: () => ch.close() };
}
const useLocalTransport = new URLSearchParams(location.search).has("local");

function randomCode() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 6 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
}

function inviteLink(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "play";
  url.searchParams.set("join", code);
  if (useLocalTransport) url.searchParams.set("local", "1");
  return url.toString();
}

async function hostGame() {
  if (!deckIdsFromCollection().length) {
    setNet("Your collection is empty — open some boosters first!");
    return;
  }
  leaveGame(false);
  mySide = "a";
  netBusy = true;
  render();
  const code = randomCode();
  $("invite").hidden = false;
  $("invite-link").value = inviteLink(code);
  $("invite-code").textContent = code;

  if (useLocalTransport) {
    net = localTransport(code);
    setNet(`Waiting for a second tab to join with code ${code}…`);
    netBusy = false;
    render();
    return;
  }
  try {
    setNet("Connecting to the matchmaking service…");
    await loadPeerJs();
    const peer = new window.Peer(PEER_PREFIX + code);
    peer.on("open", () => setNet(`Waiting for your opponent… Send them the link or the code ${code}.`));
    peer.on("error", err => { netBusy = false; setNet("Network error: " + (err.type || err)); render(); });
    peer.on("connection", conn => {
      if (net) { conn.on("open", () => conn.close()); return; } // only one opponent
      conn.on("open", () => {
        net = wrapPeerConnection(conn, peer);
        netBusy = false;
        setNet("Opponent connected, setting up the game…");
      });
    });
  } catch (err) {
    netBusy = false;
    setNet("Error: " + err.message);
    render();
  }
}

async function joinGame(code) {
  code = String(code || "").trim().toLowerCase().replace(/^.*join=/, "").replace(/[^a-z0-9]/g, "");
  if (!code) { setNet("Enter the code your opponent gave you."); return; }
  const deck = deckIdsFromCollection();
  if (!deck.length) { setNet("Your collection is empty — open some boosters first!"); return; }
  leaveGame(false);
  mySide = "b";
  netBusy = true;
  render();
  const hello = { t: "hello", name: $("player-name").value.trim() || "Guest", deck, wins: hindex.wins };

  if (useLocalTransport) {
    net = localTransport(code);
    netBusy = false;
    setNet("Joining…");
    net.send(hello);
    render();
    return;
  }
  try {
    setNet("Connecting…");
    await loadPeerJs();
    const peer = new window.Peer();
    peer.on("error", err => {
      netBusy = false;
      setNet(err.type === "peer-unavailable"
        ? "No game found with this code (the host must keep the page open)."
        : "Network error: " + (err.type || err));
      render();
    });
    peer.on("open", () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on("open", () => {
        net = wrapPeerConnection(conn, peer);
        netBusy = false;
        setNet("Connected, waiting for the host to start…");
        net.send(hello);
      });
    });
  } catch (err) {
    netBusy = false;
    setNet("Error: " + err.message);
    render();
  }
}

// Leave the current two-player game (tells the opponent).
function leaveGame(notify = true) {
  if (net) {
    if (notify && match && !match.over) net.send({ t: "bye" });
    net.close();
    net = null;
  }
  if (match && !match.over && notify) {
    match.resigned = match.me;
    finishMatch("", { send: false });
  }
  netBusy = false;
  $("invite").hidden = true;
}

// ---- Wiring -----------------------------------------------------------------
$("new-game").addEventListener("click", () => {
  if (game && !game.over && !confirm("Abandon the current game and start a new one?")) return;
  if (net) leaveGame(false);
  mySide = "s";
  $("versus-panel").open = false;
  newGame();
  $("solo-panel").open = false;
});
$("end-game").addEventListener("click", () => finishGame());
$("host-game").addEventListener("click", hostGame);
$("deck-play").addEventListener("click", () => {
  history.replaceState(null, "", "#play");
  showView("play-view");
  if (!(match && !match.over)) {
    if (game && !game.over && !confirm("Abandon the current game and start a new one with this deck?")) return;
    if (net) leaveGame(false);
    mySide = "s";
    newGame();
  }
});
$("join-game").addEventListener("click", () => joinGame($("join-code").value));
$("join-code").addEventListener("keydown", e => { if (e.key === "Enter") joinGame($("join-code").value); });
$("leave-game").addEventListener("click", () => {
  if (match && !match.over && !confirm("Leave the game? Your opponent wins.")) return;
  leaveGame(true);
  setNet("You left the game.");
  render();
});
$("copy-invite").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("invite-link").value);
    $("copy-invite").textContent = "Copied!";
  } catch {
    $("invite-link").select();
  }
  setTimeout(() => { $("copy-invite").textContent = "Copy link"; }, 1500);
});
window.addEventListener("beforeunload", () => {
  if (net && match && !match.over) net.send({ t: "bye" });
});
try {
  const saved = localStorage.getItem("my-gacha-player-name");
  if (saved) $("player-name").value = saved;
} catch { /* ignore */ }
$("player-name").addEventListener("change", () => {
  try { localStorage.setItem("my-gacha-player-name", $("player-name").value.trim()); } catch { /* ignore */ }
});
renderHIndex();
// Opened from an invitation link: prefill the code.
{
  const code = new URLSearchParams(location.search).get("join");
  if (code) {
    $("versus-panel").open = true;
    $("join-code").value = code;
    setNet("You were invited to a game: enter your name and press “Join”.");
  }
}
$("pass-turn").addEventListener("click", passTurn);
$("wf-board").addEventListener("click", () => {
  const inst = selectedInst();
  if (inst && canJoinBench(inst.card)) placeWorkforce();
});
$("opponent-zone").addEventListener("click", () => {
  const inst = selectedInst();
  if (inst && isAreaItem(inst.card)) useOnOpponentArea();
});
$("opp-wf-board").addEventListener("click", () => {
  const inst = selectedInst();
  if (inst && canJoinBench(inst.card)) placeWorkforce("opp");
});
$("wf-board").addEventListener("keydown", event => {
  const inst = selectedInst();
  if ((event.key === "Enter" || event.key === " ") && event.target === $("wf-board") &&
      inst && canJoinBench(inst.card)) {
    event.preventDefault();
    placeWorkforce();
  }
});
$("sel-cancel").addEventListener("click", () => {
  selected = null;
  render();
  setStatus("Pick a card from your hand.");
});
$("sel-discard").addEventListener("click", discardSelected);
$("sel-inspect").addEventListener("click", () => {
  const inst = selectedInst();
  if (inst) openCardInspection(inst.card);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && selected !== null && $("card-modal").hidden) {
    selected = null;
    render();
  }
});

// View tabs (Boosters & collection / Play)
const views = ["booster-view", "collection-view", "deck-view", "play-view"];
const viewHashes = { "booster-view": "#", "collection-view": "#collection", "deck-view": "#deck", "play-view": "#play" };
function showView(id) {
  if (!views.includes(id)) id = "booster-view";
  document.body.classList.toggle("playing", id === "play-view" || id === "deck-view");
  if (id === "deck-view") renderDeckBuilder();
  if (id === "play-view") $("deck-line-text").textContent = deckSummary();
  for (const v of views) $(v).hidden = v !== id;
  document.querySelectorAll(".view-tabs .tab").forEach(tab => {
    tab.setAttribute("aria-pressed", String(tab.dataset.view === id));
  });
}
document.querySelectorAll(".view-tabs .tab").forEach(tab => {
  tab.addEventListener("click", () => {
    showView(tab.dataset.view);
    history.replaceState(null, "", viewHashes[tab.dataset.view] || "#");
  });
});
const viewFromHash = () =>
  showView({ "#play": "play-view", "#deck": "deck-view", "#collection": "collection-view" }[location.hash] || "booster-view");
window.addEventListener("hashchange", viewFromHash);
viewFromHash();

render();

// Show which game version is running (helps spot an outdated cached file).
const footer = document.querySelector("footer");
if (footer) footer.append(` · Game version ${GAME_VERSION}`);