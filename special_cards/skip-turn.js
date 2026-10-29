// "Skip turn"
//
// Played by clicking anywhere on the opponent's area. The opponent skips
// their next turn, so you play a bonus turn. The card stays displayed on top
// of the opponent's area until the end of your bonus turn, then it is
// discarded. It can only be used in a game against an opponent.
//
// Card in cards_data.json, for example:
//   { "id": "085", "name": "Conference trip", "type": "item",
//     "special": "skip_turn", "permanent": "false", "cost": "2",
//     "rarity": "Rare", "weight": 2, "image": "cards/conference.png",
//     "description": "Your opponent skips their next turn." }

export default {
  id: "skip_turn",

  // Played on the opponent's whole area, not on one of their cards.
  targetsOpponentArea: true,

  describe() {
    return "click on your opponent's area: they skip their next turn and you play a bonus turn";
  },

  canUseOnOpponent(api, { opponent }) {
    return !!opponent && !opponent.skip;   // not twice at the same time
  },

  useOnOpponent(api, { itemInst, opponent, opponentName }) {
    api.skipTurn(opponent, itemInst);
    return `${itemInst.card.name}: ${opponentName} will skip their next turn.`;
  }
};