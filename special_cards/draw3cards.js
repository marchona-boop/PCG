// "Draw 3 cards"
//
// Select the card and press "Play": you draw 3 cards from your deck (fewer if
// there are fewer left) and the card is discarded. It does not use your play
// for the turn. It is paid for like any card (its "cost").
//
// Card in cards_data.json, for example:
//   { "id": "086", "name": "Literature review", "type": "item",
//     "special": "draw3cards", "permanent": "false", "cost": "1",
//     "rarity": "Common", "weight": 4, "image": "cards/review.png",
//     "description": "Draw 3 cards." }
// Optional: "draw": 2 to draw another number of cards with the same file.

const CARDS_TO_DRAW = 3;

const countOf = card => {
  const n = Number(card.draw);
  return Number.isInteger(n) && n > 0 ? n : CARDS_TO_DRAW;
};

export default {
  id: "draw3cards",

  // Played on its own with the "Play" button (no target), without ending the turn.
  playAlone: true,

  describe(card) {
    return `press “Play” to draw ${countOf(card)} cards (your turn goes on)`;
  },

  canPlay(api, { player }) {
    return player.deck.length > 0;
  },

  play(api, { itemInst, player }) {
    const drawn = api.draw(player, countOf(itemInst.card));
    return drawn.length
      ? `${itemInst.card.name}: you drew ${drawn.map(d => d.card.name).join(", ")}.`
      : `${itemInst.card.name}: your deck is empty.`;
  }
};