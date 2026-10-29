// Special cards: cards whose effect is too specific for the generic rules
// (improve robustness / budget, conditions, effects...). Each one lives in its
// own file in this folder and is linked to cards_data.json by a "special"
// field, e.g.
//
//   { "id": "080", "name": "Publish or perish", "type": "item",
//     "special": "publish-or-perish", "permanent": "true", "cost": "1", ... }
//
// To add a new special card:
//   1. copy publish-or-perish.js to a new file (e.g. my-card.js) and edit it;
//   2. import it below and add it to the list;
//   3. put "special": "<its id>" on the card in cards_data.json.
//
// What a special card file can define (all optional; see publish-or-perish.js):
//   id                  name used in the "special" field of cards_data.json
//   describe(card)      one line shown when the card is selected in the hand
//   canTarget(api, t)   can this item be used on board card t.target?
//   describeTarget(api, t)  hover text on a possible target
//   use(api, t)         the item is used on t.target (after it was paid for);
//                       returns the message to show
//   chip(api, a)        { badge, title } shown on the item's round icon when it
//                       is attached to a card
//   onCardPlayed(api, a)  any card was just put into play by a.player
//   onTurnEnd(api, a)     a.player is ending their turn
//   targetsOpponentArea   true: the card is played by clicking anywhere on the
//                         opponent's area instead of on one card (see skip-turn.js)
//   canUseOnOpponent(api, o) / useOnOpponent(api, o)
//                         o = { itemInst, opponent, opponentName, player }
// "a" (attached) = { item, holder, holderOwner, player, played? } where item is
// the attached special card, holder the card it is attached to, holderOwner
// the player owning that card and player the player acting now.
// item.data is a small object saved with the card (also sent to the
// opponent in online games): use it for counters and the like.

import publishOrPerish from "./publish-or-perish.js";
import skipTurn from "./skip-turn.js";

const ALL = [
  publishOrPerish,
  skipTurn,
];

const byId = new Map(ALL.map(s => [norm(s.id), s]));

function norm(t) {
  return String(t ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

// The special-card module of a card, or null.
export function specialFor(card) {
  if (!card || !card.special) return null;
  return byId.get(norm(card.special)) || null;
}