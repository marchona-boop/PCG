export const cards = await fetch("cards_data.json").then(r => r.json());

export const STORAGE_KEY = "my-gacha-collection-v1";
const $ = id => document.getElementById(id);

const typeOrder = [
  "workforce",
  "item",
  "particle",
  "astro",
  "gravity",
  "condmatt",
  "thermo",
  "electromag",
  "hydro"
];

const rarityOrder = {
  "Legendary": 3,
  "Rare": 2,
  "Common": 1
};

export const typeInfo = {
  "particle": {
    name: "Particle Physics",
    logo: "type_logos/quantumsymbol.png"
  },
  "electromag": {
    name: "Electromagnetism",
    logo: "type_logos/electromagsymbol.png"
  },
  "gravity": {
    name: "Gravitation",
    logo: "type_logos/gravitysymbol.png"
  },
  "thermo": {
    name: "Thermodynamics",
    logo: "type_logos/thermosymbol.png"
  },
  "astro": {
    name: "Astrophysics",
    logo: "type_logos/cosmologysymbol.png"
  },
  "condmatt": {
    name: "Condensed Matter",
    logo: "type_logos/condmattsymbol.png"
  },
  "workforce": {
    name: "Work Force",
    logo: "type_logos/workforcesymbol.png"
  },
  "item": {
    name: "Items & Events",
    logo: "type_logos/itemsymbol.png"
  }
};

// Logos of all the types of a card (main type first, then its subtypes).
function typeLogos(card) {
  const norm = t => String(t ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const keys = Object.keys(typeInfo);
  const wanted = [card.type];
  for (const key of Object.keys(card)) {
    if (!/^sub[\s_-]?types?$/i.test(key.trim())) continue;
    const v = card[key];
    wanted.push(...(Array.isArray(v) ? v : v == null ? [] : String(v).split(/[,;]/)));
  }
  const out = [];
  for (const t of wanted) {
    const k = keys.find(k => norm(k) === norm(t));
    const logo = k && typeInfo[k].logo;
    if (logo && !out.includes(logo)) out.push(logo);
  }
  return out;
}

function loadCollection() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const clean = {};
    for (const card of cards) {
      const n = saved[card.id];
      if (Number.isSafeInteger(n) && n > 0) clean[card.id] = n;
    }
    return clean;
  } catch {
    return {};
  }
}

export let collection = loadCollection();

function saveCollection() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    return true;
  } catch {
    $("status").textContent =
      "Your browser couldn't save the collection. Storage may be disabled or full.";
    return false;
  }
}

// Weighted random selection. Each draw is independent,
// so duplicate cards can appear in the same pack.
function pickCard() {
  const eligible = cards.filter(c =>
    Number.isFinite(c.weight) && c.weight > 0
  );

  const total = eligible.reduce((sum, c) => sum + c.weight, 0);
  if (!total) throw new Error("No cards have a positive weight.");

  let roll = Math.random() * total;

  for (const card of eligible) {
    roll -= card.weight;
    if (roll < 0) return card;
  }
  return eligible[eligible.length - 1];
}

function makeCardElement(card, count = null) {
  const article = document.createElement("article");

  const rarityClass = String(card.rarity)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

  article.className = `card rarity-${rarityClass}`;

  const img = document.createElement("img");
  img.src = card.image;
  img.alt = card.name;
  img.loading = "lazy";
  img.onerror = () => {
    img.alt = "Image not found: " + card.image;
  };

  const name = document.createElement("h3");
  name.textContent = card.name;

  const rarity = document.createElement("p");
  rarity.className = "rarity";
  rarity.textContent = card.rarity;

  article.append(img, name, rarity);

  if (card.description) {
    const description = document.createElement("p");
    description.className = "description";
    description.textContent = card.description;
    article.append(description);
  }

  if (count !== null) {
    const copies = document.createElement("p");
    copies.className = "count";
    copies.textContent = "Owned: " + count;
    article.append(copies);
  }


if (count !== null) {
  article.tabIndex = 0;
  article.setAttribute("role", "button");
  article.setAttribute(
    "aria-label",
    `Inspect ${card.name}, ${card.rarity}, owned: ${count}`
  );

  article.addEventListener("click", () => {
    openCardInspection(card);
  });

  article.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCardInspection(card);
    }
  });
}

  return article;
}

const modal = $("card-modal");
let lastFocusedCard = null;

export function openCardInspection(card) {
  lastFocusedCard = document.activeElement;

  $("modal-image").src = card.image;
  $("modal-image").alt = card.name;
  $("modal-title").textContent = card.name;
  $("modal-rarity").textContent = card.rarity;
  $("modal-description").textContent =
    card.description || "No description available yet.";
  $("modal-count").textContent =
    `Owned: ${collection[card.id] || 0}`;

  const typeName = (typeInfo[card.type] || {}).name || card.type || "Unclassified";
  const stats = [typeName];
  if (card.degree !== undefined && card.degree !== "") stats.push(`Degree ${card.degree}`);
  if (card.reach !== undefined && card.reach !== "") stats.push(`Reach ${card.reach}`);
  if (card.cost !== undefined && card.cost !== "") stats.push(`Cost ${card.cost}`);
  if (card.robustness !== undefined && card.robustness !== "") stats.push(`Robustness ${card.robustness}`);
  if (card["improve robustness"] !== undefined && card["improve robustness"] !== "") {
    const permanent = String(card.permanent).toLowerCase() === "true";
    const v = String(card["improve robustness"]).trim();
    stats.push(`Robustness ${v.startsWith("-") ? v : "+" + v} (${permanent ? "permanent" : "single use"})`);
  }
  if (card.budget !== undefined && card.budget !== "") stats.push(`Budget ${card.budget}`);
  if (card["improve budget"] !== undefined && card["improve budget"] !== "") {
    const permanent = String(card.permanent).toLowerCase() === "true";
    const v = String(card["improve budget"]).trim();
    stats.push(`Budget ${v.startsWith("-") ? v : "+" + v} (${permanent ? "permanent" : "single use"})`);
  }
  if (card.workforce !== undefined && card.workforce !== "") {
    const permanent = String(card.permanent).toLowerCase() === "true";
    stats.push(`Work force +${card.workforce} (${permanent ? "permanent" : "single use"})`);
  }
  if (card.effect) {
    const pairs = Array.isArray(card.effect)
      ? (Array.isArray(card.effect[0]) ? card.effect : [card.effect])
      : Object.entries(card.effect);
    const what = pairs.map(([stat, v]) => {
      const t = String(v).trim();
      return `${stat} ${t.startsWith("-") || t.startsWith("+") ? t : "+" + t}`;
    }).join(", ");
    const conds = [].concat(card.condition ?? []).filter(Boolean);
    stats.push(conds.length
      ? `Effect: ${what} when “${conds.join("” or “")}” is in play`
      : `Effect: ${what} (always)`);
  }
  $("modal-stats").textContent = stats.join(" · ");

  modal.hidden = false;
  $("modal-close").focus();
}

function closeCardInspection() {
  modal.hidden = true;

  if (lastFocusedCard?.isConnected) {
    lastFocusedCard.focus();
  }
}

$("modal-close").addEventListener(
  "click",
  closeCardInspection
);

modal.addEventListener("click", event => {
  if (event.target === modal) {
    closeCardInspection();
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !modal.hidden) {
    closeCardInspection();
  }
});



// Folded type sections of the collection (remembered in this browser).
const FOLD_KEY = "my-gacha-collection-folded-v1";
const folded = new Set((() => {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "[]"); } catch { return []; }
})());
function saveFolded() {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* ignore */ }
}

function renderCollection() {
  const area = $("collection");
  area.replaceChildren();

  const owned = cards
    .filter(c => (collection[c.id] || 0) > 0)
    .sort((a, b) => {
      // Sort by type first.
      const typeA = typeOrder.indexOf(a.type);
      const typeB = typeOrder.indexOf(b.type);

      const orderA = typeA === -1 ? Infinity : typeA;
      const orderB = typeB === -1 ? Infinity : typeB;

      if (orderA !== orderB) {
        return orderA - orderB;
      }

      // Then sort by rarity, highest first.
      const rarityA = rarityOrder[a.rarity] || 0;
      const rarityB = rarityOrder[b.rarity] || 0;

      if (rarityA !== rarityB) {
        return rarityB - rarityA;
      }

      return a.name.localeCompare(b.name);
    });

  const totalCopies = Object.values(collection)
    .reduce((a, b) => a + b, 0);

  $("summary").textContent =
    `${owned.length} / ${cards.length} unique cards discovered · ` +
    `${totalCopies} total cards`;

  if (!owned.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "Your collection is empty. Draw some cards to begin!";
    area.append(empty);
    return;
  }

  // Group owned cards by type.
  const groups = new Map();

  for (const card of owned) {
    const type = card.type || "Unclassified";

    if (!groups.has(type)) {
      groups.set(type, []);
    }

    groups.get(type).push(card);
  }

  // Display a heading and a separate grid for each type.
  for (const [type, typeCards] of groups) {
    // Each type is a foldable section: click its heading to fold / unfold it.
    const section = document.createElement("details");
    section.className = "collection-type";
    section.dataset.type = type;
    section.open = !folded.has(type);
    section.addEventListener("toggle", () => {
      if (section.open) folded.delete(type); else folded.add(type);
      saveFolded();
    });

    const heading = document.createElement("summary");
    heading.className = "collection-type-heading";

    const info = typeInfo[type] || {
    name: type,
    logo: ""
    };

    if (info.logo) {
    const logo = document.createElement("img");
    logo.className = "type-logo";
    logo.src = info.logo;
    logo.alt = "";
    logo.onerror = () => logo.remove();
    heading.append(logo);
    }

    const label = document.createElement("span");
    label.textContent = info.name;
    const n = document.createElement("small");
    n.className = "type-count";
    n.textContent = `${typeCards.length} card${typeCards.length > 1 ? "s" : ""}`;
    heading.append(label, n);

    const grid = document.createElement("div");
    grid.className = "collection-type-grid";

    for (const card of typeCards) {
      grid.append(
        makeCardElement(card, collection[card.id])
      );
    }

    section.append(heading, grid);
    area.append(section);
  }
}



let selectionStep = 0;
let selectionSession = 0;
let chosenCards = [];


function startBoosterSelection() {
  const session = ++selectionSession;

  selectionStep = 1;
  chosenCards = [];

  $("chosen-cards").replaceChildren();
  $("chosen-title").hidden = true;
  $("choices-title").hidden = false;

  $("draw").disabled = true;

  showMysteryChoices(session);
}


function showMysteryChoices(session) {
  if (session !== selectionSession) return;

  const results = $("results");
  results.replaceChildren();

  $("status").textContent =
    `Choose a card — ${selectionStep} of 3`;

  const choices = Array.from(
    { length: 3 },
    () => pickCard()
  );

  for (const card of choices) {
    const element = makeCardElement(card);

    element.classList.add("mystery");

    // Show the type logo(s) on top of the blurred card.
    const logos = typeLogos(card);
    if (logos.length) {
      element.classList.add("has-logos");
      const box = document.createElement("div");
      box.className = "mystery-logos";
      for (const src of logos) {
        const logo = document.createElement("img");
        logo.src = src;
        logo.alt = "";
        logo.onerror = () => {
          logo.remove();
          if (!box.children.length) element.classList.remove("has-logos");
        };
        box.append(logo);
      }
      element.append(box);
    }
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute(
      "aria-label",
      `Mystery card, ${card.rarity}. Select this card.`
    );

    element.addEventListener("click", () => {
      chooseMysteryCard(card, session);
    });

    element.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        chooseMysteryCard(card, session);
      }
    });

    results.append(element);
  }
}


function chooseMysteryCard(card, session) {
  if (session !== selectionSession) return;

  const results = $("results");
  results.replaceChildren();

  // Record and reveal the chosen card.
  chosenCards.push(card);

  collection[card.id] = (collection[card.id] || 0) + 1;
  saveCollection();
  renderCollection();

  const chosenArea = $("chosen-cards");
  const chosenTitle = $("chosen-title");

  chosenTitle.hidden = false;

  const revealed = makeCardElement(
    card,
    collection[card.id]
  );

  revealed.classList.add("reveal");
  chosenArea.append(revealed);

  const chosenStep = selectionStep;
  selectionStep++;

  if (chosenStep < 3) {
    $("choices-title").hidden = false;

    $("status").textContent =
      `Card ${chosenStep} of 3 selected!`;

    setTimeout(() => {
      if (session !== selectionSession) return;
      showMysteryChoices(session);
    }, 700);
  } else {
    $("choices-title").hidden = true;
    $("draw").disabled = false;

    $("status").textContent =
      "Booster opened.";
  }
}


$("draw").addEventListener("click", startBoosterSelection);

function foldAll(fold) {
  document.querySelectorAll("#collection .collection-type").forEach(d => { d.open = !fold; });
}
$("fold-all").addEventListener("click", () => foldAll(true));
$("unfold-all").addEventListener("click", () => foldAll(false));

$("reset").addEventListener("click", () => {
  if (!confirm("Delete your saved collection from this browser?")) return;

  selectionSession++;
  selectionStep = 0;
  $("draw").disabled = false;

  collection = {};
  saveCollection();
  $("results").replaceChildren();
  renderCollection();
  $("status").textContent = "Your collection has been reset.";

  $("chosen-cards").replaceChildren();
  $("chosen-title").hidden = true;
  $("choices-title").hidden = true;
  $("results").replaceChildren(); 
});

renderCollection();

// ---- Physics logos orbiting the title ------------------------------------------
// The logos of the physics types (not items / work force) move along an
// ellipse around the page title: behind it on the upper half, in front of it
// (and a bit larger) on the lower half. Still for visitors who asked their
// system for reduced motion.
const ORBIT_SECONDS = 28;   // time for one full turn

function setupTitleOrbit() {
  const header = document.querySelector("header");
  const title = header && header.querySelector("h1");
  if (!title) return;
  const sources = Object.entries(typeInfo)
    .filter(([key, info]) => key !== "item" && key !== "workforce" && info.logo)
    .map(([, info]) => info.logo);
  if (!sources.length) return;

  const layer = document.createElement("div");
  layer.className = "title-orbit";
  layer.setAttribute("aria-hidden", "true");
  let logos = sources.map(src => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.onerror = () => { img.remove(); logos = logos.filter(l => l !== img); };
    layer.append(img);
    return img;
  });
  header.append(layer);
  header.classList.add("has-orbit");

  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  let start = performance.now();

  function frame(now) {
    const h = header.getBoundingClientRect();
    // size of the title text itself (the h1 element spans the whole width)
    const range = document.createRange();
    range.selectNodeContents(title);
    const t = range.getBoundingClientRect();
    if (t.width && logos.length) {
      const cx = t.left - h.left + t.width / 2;
      const cy = t.top - h.top + t.height / 2;
      const size = Math.max(18, Math.min(48, t.height * 0.75));
      const a = Math.min(t.width / 2 + size * 0.9,         // horizontal radius,
        Math.min(cx, h.width - cx) - size * 0.6);          // kept inside the screen
      const b = Math.min(t.height / 2 + size * 0.55,       // vertical radius, kept
        Math.max(cy, h.height - cy) - size * 0.2);         // inside the header
      const turn = still.matches ? 0 : ((now - start) / 1000) / ORBIT_SECONDS;
      logos.forEach((img, i) => {
        const angle = 2 * Math.PI * (turn + i / logos.length);
        const depth = Math.sin(angle);                     // -1 back ... +1 front
        const scale = 0.78 + 0.22 * (depth + 1) / 2;
        const x = cx + a * Math.cos(angle) - size / 2;
        const y = cy + b * depth - size / 2;
        img.style.width = img.style.height = `${size}px`;
        img.style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(-90deg)`;
        img.style.zIndex = depth > 0 ? "3" : "1";
        img.style.opacity = String(0.55 + 0.45 * (depth + 1) / 2);
      });
    }
    if (!still.matches) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  still.addEventListener?.("change", () => { start = performance.now(); requestAnimationFrame(frame); });
  window.addEventListener("resize", () => { if (still.matches) requestAnimationFrame(frame); });
  // The header changes size when switching tabs (compact header on Deck / Play).
  new ResizeObserver(() => { if (still.matches) requestAnimationFrame(frame); }).observe(header);
}

setupTitleOrbit();