// "Publish or perish"
//
// Item placed on a work force card of a bench (normally your opponent's).
// The owner of that work force card then has TURNS of their own turns to put
// into play a card whose name contains one of RELEASE_NAMES. If they do, the
// "Publish or perish" card is removed. If they don't, the work force card is
// discarded at the end of their last turn.
//
// Card in cards_data.json, for example:
//   { "id": "080", "name": "Publish or perish", "type": "item",
//     "special": "publish-or-perish", "permanent": "true", "cost": "1",
//     "rarity": "Rare", "weight": 2, "image": "cards/publish.png",
//     "description": "Publish within 3 turns or the targeted work force perishes." }
// Optional fields to tune one card without editing this file:
//   "release names": ["paper", "article"]   (overrides RELEASE_NAMES)
//   "turns": 3                               (overrides TURNS)

// ---- Tunable settings -------------------------------------------------------
// Text that, found in the name of a card put into play, counts as publishing
// (case-insensitive: "paper" matches "Nature paper" or "White Paper").
const RELEASE_NAMES = ["paper", "article", "preprint", "publication", "physical review", "Physical Review", "journal"];
const TURNS = 3;
// -----------------------------------------------------------------------------

function releaseNames(card) {
  const own = card["release names"];
  const list = Array.isArray(own) ? own : own ? String(own).split(/[,;]/) : RELEASE_NAMES;
  return list.map(s => String(s).trim().toLowerCase()).filter(Boolean);
}

function turnsOf(card) {
  const n = Number(card.turns);
  return Number.isInteger(n) && n > 0 ? n : TURNS;
}

const quoted = list => {
  const q = list.map(s => `“${s}”`);
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}` : q[0] || "";
};

export default {
  id: "publish-or-perish",

  describe(card) {
    return `place it on a work force card: its owner has ${turnsOf(card)} turns to ` +
      `play a card named ${quoted(releaseNames(card))}, or that work force card is discarded`;
  },

  // Only work force cards on a bench, and not twice on the same card.
  canTarget(api, { item, target }) {
    if (!api.onBench(target)) return false;
    return !(target.items || []).some(it => api.specialId(it.card) === "publishorperish");
  },

  describeTarget(api, { item, target }) {
    return `${target.card.name} must publish within ${turnsOf(item)} turns or perish`;
  },

  use(api, { itemInst, target, targetOwner, whose, player }) {
    const card = itemInst.card;
    api.attach(target, itemInst);
    itemInst.data = {
      turnsLeft: turnsOf(card),
      victim: targetOwner.side,
      placedBy: player.side,
      placedOnTurn: player.turn
    };
    return `${card.name} on ${whose}${target.card.name}: ${turnsOf(card)} turns to play a card ` +
      `named ${quoted(releaseNames(card))}, or ${target.card.name} perishes.`;
  },

  chip(api, { item, holder }) {
    const left = item.data ? item.data.turnsLeft : turnsOf(item.card);
    return {
      badge: String(left),
      title: `${item.card.name}: ${left} turn(s) left to play a card named ` +
        `${quoted(releaseNames(item.card))}, or ${holder.card.name} perishes`
    };
  },

  // The victim put a matching card into play: the threat is lifted.
  onCardPlayed(api, { item, holder, player, played }) {
    if (!item.data || player.side !== item.data.victim || played === item) return "";
    const name = String(played.card.name || "").toLowerCase();
    if (!releaseNames(item.card).some(r => name.includes(r))) return "";
    api.detach(holder, item);
    return `“${played.card.name}” was published: ${item.card.name} on ${holder.card.name} is lifted.`;
  },

  // Count down the victim's turns; discard the work force card at the end.
  onTurnEnd(api, { item, holder, holderOwner, player }) {
    const d = item.data;
    if (!d || player.side !== d.victim) return "";
    if (player.side === d.placedBy && player.turn === d.placedOnTurn) return ""; // placed this turn
    d.turnsLeft--;
    if (d.turnsLeft > 0) return "";
    api.discardFromBench(holderOwner, holder);
    return `${holder.card.name} perished: nothing was published in time.`;
  }
};