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

import { cards, typeInfo, collection, openCardInspection } from "./script.js";

const GAME_VERSION = "2026-10-25d";

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
const onBench = inst => !!game && game.wfBoard.includes(inst);
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
  if (!game) return null;
  for (const stack of game.stacks) if (stack && stack.includes(inst)) return stack;
  if (game.wfBoard.includes(inst)) return game.wfBoard;
  return null;
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
  if (!game || !effectsOf(base).length) return false;
  const conds = conditionsOf(base);
  if (!conds.length) return true;
  const onBoards = [...game.stacks.flatMap(st => st || []), ...game.wfBoard];
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
function makeInst(card) {
  const inst = { uid: ++uidCounter, base: card };
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
let game = null;
let selected = null;    // index in game.hand, or null
let best = loadBest();
let uidCounter = 0;

function newGame() {
  const pool = [];
  for (const card of cards) {
    const copies = collection[card.id] || 0;
    for (let i = 0; i < copies; i++) pool.push(makeInst(card));
  }

  if (!pool.length) {
    game = null;
    selected = null;
    render();
    setStatus("Your collection is empty — open some boosters first!");
    return;
  }

  const deck = shuffle(pool).slice(0, DECK_SIZE);
  game = {
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
  setStatus("Place work force, then pick a card to play.");
  checkStuck();
}

// ---- Work force & payment ---------------------------------------------------
const boardWfTotal = () => Math.max(0, game.wfBoard.reduce((s, inst) => s + boardWorkforce(inst), 0));
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
  const stat = itemStatFor(item, inst);
  if (!stat) return false;
  if (isPermanent(item)) return true;
  return stat.now + stat.delta <= 0; // single use: must destroy
}

function itemTargets(item) {
  const out = [];
  game.stacks.forEach((stack, slot) => {
    (stack || []).forEach((inst, index) => {
      if (canUseItemOn(item, inst)) out.push({ kind: "stack", slot, index });
    });
  });
  game.wfBoard.forEach((inst, index) => {
    if (canUseItemOn(item, inst)) out.push({ kind: "wf", index });
  });
  return out;
}

// Text describing what an item would do to a board card.
function itemEffectText(item, inst, above = 0) {
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
  if (isItem(card)) return itemTargets(card).length > 0 || (isBenchItem(card) && canPlaceWorkforce());
  if (isHybridWf(card) && canPlaceWorkforce()) return true;
  return game.stacks.some(stack => canPlaceOn(card, stack));
}

function stackReach(stack) {
  return stack ? stack.reduce((sum, inst) => sum + boardReach(inst), 0) : 0;
}

function totalScore() {
  return game ? game.stacks.reduce((sum, s) => sum + stackReach(s), 0) : 0;
}

// ---- Actions ----------------------------------------------------------------
function selectedInst() {
  return game && selected !== null ? game.hand[selected] : null;
}

function playTo(slot) {
  if (!game || game.over) return;
  const inst = selectedInst();
  if (!inst || !isPlayCard(inst.card)) return;
  const card = inst.card;
  const stack = game.stacks[slot];

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
    message = `Stacked ${card.name} — combo of ${stack.length}, reach ${formatStat(stackReach(stack))}.`;
  } else {
    game.stacks[slot] = [inst];
    message = `Played ${card.name} on a new stack.`;
  }
  if (plan.cost > 0) message += ` (${describePayment(plan)})`;
  endTurn(message);
}

function useItemOn(slot, index) {
  useItem({ kind: "stack", slot, index });
}

function useItemOnWorkforce(index) {
  useItem({ kind: "wf", index });
}

function useItem(where) {
  if (!game || game.over) return;
  const itemInst = selectedInst();
  if (!itemInst || !isItem(itemInst.card)) return;
  const item = itemInst.card;
  const stack = where.kind === "stack" ? game.stacks[where.slot] : null;
  const target = where.kind === "stack" ? stack && stack[where.index] : game.wfBoard[where.index];
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

  let message;
  if (isPermanent(item)) {
    target.items = target.items || [];
    target.items.push(itemInst);
    message = `${item.name} attached to ${target.card.name}: ${stat.label} ` +
      `${formatStat(stat.now)} → ${formatStat(itemStatFor(item, target).now)}.`;
  } else {
    game.itemsUsed++;
    message = `Used ${item.name} on ${target.card.name}.`;
  }

  const current = itemStatFor(item, target).now;
  if (!isPermanent(item) || current <= 0) {
    const scoreBefore = totalScore();
    const wfBefore = boardWfTotal();
    if (where.kind === "stack") {
      const destroyed = stack.splice(where.index);
      if (!stack.length) game.stacks[where.slot] = null;
      game.destroyed += destroyed.length;
      const lost = scoreBefore - totalScore();
      message += destroyed.length > 1
        ? ` ${target.card.name} and the ${destroyed.length - 1} card(s) stacked on it were destroyed (−${formatStat(lost)} reach).`
        : ` ${target.card.name} was destroyed (−${formatStat(lost)} reach).`;
    } else {
      game.wfBoard.splice(where.index, 1);
      game.destroyed++;
      message += ` ${target.card.name} was destroyed (−${formatStat(wfBefore - boardWfTotal())} work force per turn).`;
    }
  }
  if (plan.cost > 0) message += ` (${describePayment(plan)})`;
  endTurn(message);
}

function placeWorkforce() {
  if (!game || game.over) return;
  const inst = selectedInst();
  if (!inst || !canJoinBench(inst.card)) return;

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
  game.wfBoard.push(inst);
  game.wfPlaced++;
  selected = null;

  const wf = boardWorkforce(inst);
  let message = wf
    ? `${inst.card.name} joined your work force (+${formatStat(wf)} every turn, starting now).`
    : `${inst.card.name} was set up on the work force board.`;
  message += resolveDestruction();
  if (plan.cost > 0) message += ` (${describePayment(plan)})`;
  render();
  setStatus(message + " Now play a card, pass or discard.");
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
  if (!game || game.over || !game.deck.length) return;
  endTurn("You passed.");
}

function endTurn(message) {
  selected = null;
  game.lastDrawn = null;
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
    for (let slot = 0; slot < game.stacks.length && !hit; slot++) {
      const stack = game.stacks[slot];
      if (!stack) continue;
      const index = stack.findIndex(inst => robustnessOf(inst) <= 0);
      if (index === -1) continue;
      const name = stack[index].card.name;
      const destroyed = stack.splice(index);
      if (!stack.length) game.stacks[slot] = null;
      game.destroyed += destroyed.length;
      notes.push(destroyed.length > 1
        ? `${name} and ${destroyed.length - 1} card(s) on it collapsed`
        : `${name} collapsed`);
      hit = true;
    }
    if (!hit) {
      const index = game.wfBoard.findIndex(inst => budgetOf(inst) <= 0);
      if (index !== -1) {
        notes.push(`${game.wfBoard[index].card.name} ran out of budget`);
        game.wfBoard.splice(index, 1);
        game.destroyed++;
        hit = true;
      }
    }
    if (!hit) break;
  }
  return notes.length ? ` Effects: ${notes.join("; ")}.` : "";
}

// End the game automatically when nothing more can happen.
function checkStuck(lastMessage = "") {
  if (!game || game.over) return;
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
  renderHud();
  renderWorkforceBoard();
  renderBoard();
  renderHand();
  renderSelectionBar();
  const active = game && !game.over;
  $("end-game").disabled = !active;
  $("pass-turn").disabled = !active || !game.deck.length;
  $("new-game").textContent = active ? "Restart" : "New game";
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

function renderWorkforceBoard() {
  const zone = $("wf-board");
  zone.replaceChildren();
  zone.className = "wf-board";

  const inst = selectedInst();
  const placing = inst && canJoinBench(inst.card);
  const ok = placing && canPlaceWorkforce() && canAfford(inst.card);
  if (placing) zone.classList.add(ok ? "valid-target" : "invalid-target");
  const selItem = inst && isItem(inst.card) ? inst.card : null;
  const affordable = selItem ? canAfford(selItem) : false;

  if (!game || !game.wfBoard.length) {
    const empty = document.createElement("p");
    empty.className = "wf-empty";
    empty.textContent = placing ? "Place work force here" : "No permanent work force yet";
    zone.append(empty);
  } else {
    game.wfBoard.forEach((w, index) => {
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
          useItemOnWorkforce(index);
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
    zone.setAttribute("aria-label", `Place ${inst.card.name} on the work force board`);
  } else {
    zone.removeAttribute("role");
    zone.removeAttribute("tabindex");
    zone.removeAttribute("aria-label");
  }

  $("wf-summary").textContent = game
    ? `available this turn ${formatStat(boardWfAvailable())} / ${formatStat(boardWfTotal())}` +
      ` · single-use in hand +${formatStat(handWfTotal())}`
    : "";
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren();

  const stacks = game ? game.stacks : Array(BOARD_SLOTS).fill(null);
  const inst = selectedInst();
  const selCard = inst && isPlayCard(inst.card) ? inst.card : null;   // placing a card
  const selItem = inst && isItem(inst.card) ? inst.card : null;       // targeting with an item
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
            useItemOn(slot, i);
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
      const t = document.createElement("span");
      t.textContent = `${typeName(top.type)} · ×${stack.length}`;
      const r = document.createElement("strong");
      r.textContent = `Reach ${formatStat(stackReach(stack))}`;
      info.append(t, r);
      slotEl.append(pile, info);
    }

    if (selCard) {
      makeActivatable(
        slotEl,
        `Play ${selCard.name} on slot ${slot + 1}${valid ? "" : " (not allowed)"}`,
        () => playTo(slot)
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
  if (items.length || now !== base) {
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
    empty.textContent = "Press “New game” to deal a hand from your collection.";
    hand.append(empty);
    return;
  }

  if (game.over) {
    const over = document.createElement("p");
    over.className = "empty";
    over.textContent = `Game over — final score ${formatStat(totalScore())}. Press “New game” to play again.`;
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
    const board = game.stacks.some(stack => canPlaceOn(card, stack));
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

// ---- Wiring -----------------------------------------------------------------
$("new-game").addEventListener("click", () => {
  if (game && !game.over && !confirm("Abandon the current game and start a new one?")) return;
  newGame();
});
$("end-game").addEventListener("click", () => finishGame());
$("pass-turn").addEventListener("click", passTurn);
$("wf-board").addEventListener("click", () => {
  const inst = selectedInst();
  if (inst && canJoinBench(inst.card)) placeWorkforce();
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
const views = ["collection-view", "play-view"];
function showView(id) {
  if (!views.includes(id)) id = "collection-view";
  for (const v of views) $(v).hidden = v !== id;
  document.querySelectorAll(".view-tabs .tab").forEach(tab => {
    tab.setAttribute("aria-pressed", String(tab.dataset.view === id));
  });
}
document.querySelectorAll(".view-tabs .tab").forEach(tab => {
  tab.addEventListener("click", () => {
    showView(tab.dataset.view);
    history.replaceState(null, "", tab.dataset.view === "play-view" ? "#play" : "#");
  });
});
const viewFromHash = () => showView(location.hash === "#play" ? "play-view" : "collection-view");
window.addEventListener("hashchange", viewFromHash);
viewFromHash();

render();

// Show which game version is running (helps spot an outdated cached file).
const footer = document.querySelector("footer");
if (footer) footer.append(` · Game version ${GAME_VERSION}`);