// "Spy"
//
// A permanent work force card that you place on your OPPONENT's bench. As
// long as it stays there, you can see your opponent's hand (shown face up above
// their board). Like any card played on the opponent's side, it belongs to
// them (its work force counts for them). If it is destroyed (e.g. its budget
// drops to 0), you stop seeing their hand.
//
// Card in cards_data.json, for example:
//   { "id": "087", "name": "Industrial spy", "type": "workforce",
//     "special": "spy", "permanent": "true", "workforce": "0", "budget": "20",
//     "cost": "2", "rarity": "Rare", "weight": 2, "image": "cards/spy.png",
//     "description": "Place it on your opponent's bench: you see their hand." }

export default {
  id: "spy",

  describe() {
    return "place it on your opponent's bench: while it stays there, you see their hand";
  },

  // Remember who planted the spy when it is put into play.
  onPlay(api, { inst, player }) {
    inst.data = { ...(inst.data || {}), spyFor: player.side };
  },

  // Does this card let `viewer` see the hand of the player it sits with?
  revealsHandTo(api, { inst, viewer }) {
    return !!inst.data && inst.data.spyFor === viewer.side;
  }
};