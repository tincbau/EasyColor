# 260907 Aegis Protocol - Design and Technical Plan

**Status:** Draft for review. Written 2026-09-07 for handoff to a Gemini-based coding agent.
**Audience:** The coding agent that will build the game, plus Christine as product owner.
**Scope of this document:** Product design, game rules, balance, rendering architecture, the volumetric cloud system, the Nano Banana asset pipeline, verification, and a milestone plan. No code is written here; every code-shaped block is a specification, not an implementation.

---

## 0. How to use this document (read first)

1. **Decisions vs. tunables.** Anything marked **DECISION** is fixed unless the product owner changes it. Anything in a *balance table* is a starting value and is expected to change during the tuning loop in Section 6. Tunables live in one config file (`src/config/balance.ts`), never scattered as literals.
2. **Assumptions are labeled.** Every place the original brief left a gap, the fill-in is marked **ASSUMPTION** and collected again in Section 15. The product owner should confirm or override those.
3. **Verification is part of the work.** Each milestone in Section 13 has acceptance tests. A milestone is not done until its tests run green and the "not verified" list is written down.
4. **Unverified facts are flagged.** Library versions, model IDs and prices were checked on 2026-09-07 by web search from a container that could not open several of the primary pages. Anything marked *(unverified)* must be re-checked by the agent before it is relied on.
5. **Reading order for the agent:** Sections 2, 5, 7, 8, 9 are the build spec. Sections 6, 10, 12 are the quality loop. Section 13 is the schedule. Appendices hold schemas and pseudocode.

---

## 1. Executive summary

Aegis Protocol is a portrait-orientation hybrid of a vertical shoot-'em-up and a real-time tower-defense game. The player flies the Aegis Cruiser along a corridor, dodging fire and collecting scrap from destroyed enemies, while boarding craft try to ram the hull and unload drones into the ship's interior. A slow-motion Tactical Mode lets the player spend scrap on turrets inside the deck.

This plan relocates the game from deep space to the **stratosphere**. The cruiser flies at roughly 20 km altitude above a sea of clouds, among storm towers whose tops punch up into the corridor. The clouds are real volumetrics rendered with a ray-marcher adapted from Guerrilla Games' Nubis system, the technique behind the skies in Horizon Zero Dawn and Horizon Forbidden West.

The technical stack is TypeScript, Vite and three.js (0.185.x) using the WebGPU renderer with its WebGL 2 fallback, and three.js Shading Language (TSL) for shaders so one shader codebase runs on both backends. Textures, weather maps, decals and UI art are generated with Gemini's Nano Banana image models through a build-time script, never at runtime. Game logic runs headless in Node so the agent can balance the game by simulation instead of by hand-play.

Three scope tiers are defined (Section 2.4). **The recommended target is Basic.** The schedule in Section 13 assumes Basic and runs about four weeks of agent work from kickoff.

---

## 2. Product overview

### 2.1 One-line pitch
Fly a warship above the clouds, shoot what is in front of you, and build the defenses that stop what got inside.

### 2.2 Design pillars
1. **Two fronts, one brain.** Every decision trades hull safety against deck safety. Dodging a boarder means flying into fire. Building a turret means not dodging at all.
2. **Readable at thumb scale.** The game is played one-handed in portrait on a phone. Every threat has a silhouette, a color and a sound that can be told apart at 6 cm wide.
3. **The sky is the set.** The cloudscape is not a backdrop. Storm towers are landmarks, enemies emerge from them, and weather escalates with the threat level.
4. **Scrap is the clock.** Difficulty is driven by scrap reclaimed, not time. The player controls the pace and pays for it.

### 2.3 Target platforms and performance targets

| Target | Class | Frame rate | Resolution scale | Cloud tier |
|---|---|---|---|---|
| Mobile low | 2020-era mid-range Android, iPhone 11 | 30 fps | 0.75 | Low: single deck layer, quarter-res march, 32 steps |
| Mobile high | 2023+ flagship phones | 60 fps | 1.0 | Medium: deck + towers, half-res march, 48 steps, 2×2 reprojection |
| Desktop | Any laptop with WebGPU or WebGL 2 | 60 fps | 1.0 | High: deck + towers, half-res march, 64–96 steps, 4×4 reprojection |

**DECISION:** Portrait 9:16 logical playfield on every device. On desktop the canvas fills the window and the cloudscape fills the extra width; the gameplay lane stays a centered 9:16 region. This is a benefit of going 3D: wide screens see more sky, not black bars.

Device classes above are design targets, not tested hardware. See Section 12.4 for the frame-time gates that actually decide the tier at runtime.

### 2.4 Scope tiers

| Tier | Contents | Use |
|---|---|---|
| **Bare** | Flight, skirmishers, scrap, one turret type (Point Defense), light boarders, deck graph, core, single-layer clouds without towers, no reprojection, HTML HUD, endless mode with a score. | Proves the loop. Playable in about ten agent-days. |
| **Basic (recommended)** | Everything in Bare plus: Cryo Emitter, Artillery Battery, Lancer torpedo craft, heavy boarders, storm towers, temporal reprojection and depth-aware compositing, three quality tiers, audio, first-run hints, local high score, balance sim harness. | The game as described in the brief, in the stratosphere, shippable to GitHub Pages. |
| **Bonus** | Cloud-cover mechanic (Section 5.9), lightning inside storm towers, weather escalation with threat, boss boarding craft, gamepad, PWA install, ship shadow on the cloud tops. | Only after Basic is green and balanced. |

**ASSUMPTION:** Basic is the target. Section 13 is planned against it.

### 2.5 Success criteria for Basic
- A new player survives at least 90 seconds on their first run and understands why they died (death screen names the cause).
- Median survival of the scripted "competent" bot in the sim harness lands between 4 and 6 minutes (Section 6.6).
- Deaths split roughly evenly between Structural Collapse and Core Breach across bot runs, within 35/65 either way.
- Mobile-high tier holds 60 fps with clouds enabled on the reference device for 3 minutes of play; mobile-low holds 30 fps.
- First load under 4 MB transferred, excluding runtime-generated noise (Section 9.3).

---

## 3. Setting: space to stratosphere

### 3.1 What changes and what does not
The rules do not change. The corridor, scrap, boarders and deck are all the same. What changes is the fiction and the render:

| Brief said | Plan says | Why |
|---|---|---|
| Scrolling starfield | Scrolling cloud deck 4 km below, storm towers rising past the corridor | The volumetric clouds are the visual identity |
| Space fighters | Jet-turbine skirmishers with contrails; boarders are armored "harpoon" craft | Contrails and exhaust read clearly against cloud tops |
| "Drift harmlessly into deep space" | Boarders that overshoot dive into the cloud deck and vanish | Same rule, better payoff shot |
| Energy projectiles | Kept, styled as hot plasma bolts | Bright bolts read well against white clouds |

### 3.2 Altitude and scale
**DECISION:** 1 flight unit (fu) = 10 m. The cruiser is 16 fu (160 m) long. The corridor is 100 fu (1 km) wide.

| Layer | Altitude | Notes |
|---|---|---|
| Cruiser flight level | 20.0 km | The "stratosphere" premise |
| Storm tower tops | 18.5–21.0 km | Stylized. Real overshooting tops reach about 18–20 km; we allow 21 km so towers cross the corridor. **ASSUMPTION** that the owner accepts this stylization. |
| Cloud deck top | 16.0 km | 4 km below the ship |
| Cloud deck base | 12.5 km | Never visible directly; sets the layer thickness for lighting |
| Cirrus veil | 24–26 km | Thin 2D textured dome, scrolls slowly |

The world is rendered in fu. Cloud altitudes above convert to 2000 fu for flight level, 1600 fu deck top, and so on. The ray-marcher works in fu with a `metersPerUnit = 10` constant for physically motivated extinction values.

### 3.3 Sky and light
- The sky at 20 km is a deep blue-black overhead fading to a pale band at the horizon. Render it analytically: a three-stop vertical gradient (zenith, mid, horizon) plus a sun disc and a sun-glow term. No skybox texture is needed.
- One directional sun. **DECISION:** Sun elevation 38°, azimuth 30° off the forward axis, so tower tops light from the upper left and cast long shading on the deck. Fixed for Basic; time-of-day is Bonus.
- Ships above the clouds receive no cloud shadow. Ship shadows on the cloud tops are Bonus.

### 3.4 Palette (portable to UI)
Sky zenith #0B1A3A, sky horizon #C9D8F0, cloud lit #FFF7EC, cloud shadow #7F8DA8, cruiser hull #3C4451 with #E7A23A accent, enemy accent #E8384F, scrap #55D6C2, cryo #7CC6FF, artillery #FFB347. These are tokens, declared once in `src/config/palette.ts`, and the HUD CSS reads the same values through CSS custom properties written from that file at build time.

---

## 4. Player experience

### 4.1 Core loop (30-second cycle)
1. A formation appears at the top of the corridor. Autocannons fire on their own.
2. The player weaves to dodge bolts and to put the hull under falling scrap.
3. A boarder appears. The player sidesteps late to make it overshoot, or fails and takes a boarding.
4. If boarded, the player toggles Tactical Mode, spends scrap on a turret at the right chokepoint, and toggles back.
5. Threat level rises with scrap collected. Repeat, faster.

### 4.2 Controls

| Action | Touch | Desktop |
|---|---|---|
| Move cruiser | Drag anywhere on the lower 70% of the screen. Movement is relative: the ship moves by the finger's delta times a gain of 1.4, not to the finger's position, so the thumb never covers the ship. | WASD or arrow keys. Mouse movement also steers when the pointer is over the canvas. |
| Toggle Tactical Mode | Button bottom-right, 64 px hit area, or two-finger tap | Space or Tab |
| Place turret | Tap an empty slot, tap a turret in the radial menu, tap again to confirm | Click slot, click type, click to confirm. Keys 1–3 select type. |
| Inspect or dismantle | Tap an existing turret: shows range ring and a Dismantle button | Click turret; Delete key dismantles |
| Pause | Button top-left | Escape |

Autocannons are never manually fired. **DECISION:** No fire button. This keeps one-thumb play honest.

### 4.3 Modes and the camera

| Mode | Time scale | Camera | Player can |
|---|---|---|---|
| Flight | 1.0 | Perspective chase camera 38 fu behind and 46 fu above the cruiser, pitched 58° down, field of view 50° vertical. The corridor reads as a vertical lane. | Move, toggle |
| Tactical | 0.2 | Blends over 0.35 s of real time to a near-top-down view of the deck at 78° pitch, framing the whole deck with the bow at the top. The flight world stays visible around the edges, slowed. | Build, inspect, dismantle, toggle |

**DECISION:** In Tactical Mode the cruiser holds position and autocannons keep firing. The player cannot dodge. This is the intended cost of building.

**ASSUMPTION:** No time limit on Tactical Mode. The slowed flight world remains dangerous enough (bolts still arrive at one-fifth speed) that camping is self-punishing. If sim results show tactical camping is dominant, add a 6-second cap with a 3-second cooldown as the first lever.

### 4.4 HUD (HTML overlay, not WebGL)
- Top: hull bar (left) and core bar (right), scrap count in the middle.
- Threat level as a small stepped meter under the scrap count.
- Boarding alert: a red edge flash on the side the craft is approaching from, plus a chevron icon on the hull silhouette.
- In Tactical: slot highlights, radial menu, range rings, dismantle refund preview.
- Death screen: cause, survival time, scrap collected, threat level reached, best run.
- First run only: three timed hints ("Drag to move", "Stand under scrap", "Tap to enter Tactical when boarded"). Stored in `localStorage` once dismissed.

Rendering the HUD in the DOM keeps text crisp on any pixel density, keeps layout responsive with CSS, and keeps accessibility features (font scaling, high contrast) free.

### 4.5 Readability rules (design constraints the agent must keep)
- Enemy bolts are the only bright red-orange things in the flight view.
- Scrap is the only teal thing.
- Boarders are the only enemies with a white-hot nose glow, and they get louder as they close.
- Storm towers never occupy more than 40% of the corridor width at the player's altitude; clouds are cover, not walls.

---

## 5. Game rules specification

All units: fu = flight unit (10 m), du = deck unit (one deck grid cell), s = seconds of simulation time. Simulation time is scaled by the mode's time scale; the HUD shows real time.

### 5.1 Corridor and cruiser
- Corridor: x ∈ [−50, 50] fu, z ∈ [−35, 175] fu. Enemies spawn at z = 170. Objects are removed at z < −35 or |x| > 70.
- Cruiser rest position (0, 0). Movement bounds x ∈ [−42, 42], z ∈ [−20, 40].
- Cruiser dimensions for collision: capsule 16 fu long, 6 fu wide. Scrap magnet perimeter: 10 fu beyond the hull.
- Speed: lateral 55 fu/s, longitudinal 40 fu/s, acceleration 320 fu/s², deceleration 400 fu/s². Visual bank up to 25° proportional to lateral velocity.
- Hull integrity 100. No regeneration. **ASSUMPTION:** Hull repair is not in Basic; a repair drop is a Bonus candidate.

### 5.2 Autocannons
Two forward barrels alternating, combined 10 rounds/s, 4 damage each, 160 fu/s, spread 1.5°, range to z = 170. Hits are sphere-vs-capsule in the simulation plane.

**DECISION:** The simulation is 2.5D. Everything moves in the y = 2000 fu plane and collision is 2D. Boarders and scrap have visual altitude offsets for drama, never gameplay ones. This keeps the rules identical to the brief and makes the sim harness cheap.

### 5.3 Enemies

| Enemy | HP | Speed (fu/s) | Behavior | Attack | Hull damage on collision | Scrap drop |
|---|---|---|---|---|---|---|
| Skirmisher | 12 | 30 down the corridor with a sine weave (amplitude 12 fu, period 2.5 s) | Spawns in formations of 4–8, holds formation shape | Plasma bolt every 1.6 s per craft, aimed at the cruiser at fire time, 70 fu/s, 6 damage | 20; skirmisher destroyed | 3 |
| Lancer | 20 | 24 down to z ≈ 90, then holds and strafes ±20 fu | Spawns in pairs from threat level 2 | Torpedo every 4 s: 35 fu/s, weak homing (turn 20°/s), 18 damage, 6 HP so autocannons can kill it | 20 | 5 |
| Grapple (light boarder) | 45 | 45, straight at the cruiser, turn rate 35°/s | Spawns alone at a random x, from threat level 1 | None. On hull contact: 8 hull damage, clamps to nearest breach point, deploys 2 waves × 4 Strike drones 4 s apart, then self-destructs | Boarding | 6 if killed in flight |
| Ram (heavy boarder) | 110 | 28, turn rate 20°/s | From threat level 3 | On contact: 15 hull damage, clamps, deploys 3 waves × 5 Assault drones 6 s apart, then self-destructs | Boarding | 12 if killed in flight |

**ASSUMPTION:** The brief mentions torpedoes only inside the Point Defense description. The Lancer is added so torpedoes exist. If the owner prefers, the Lancer can be removed and Point Defense loses its outward mode.

**Evasion math (why boarders are dodgeable):** turn radius r = v / ω. Grapple: 45 fu/s ÷ 0.611 rad/s = 74 fu. Ram: 28 ÷ 0.349 = 80 fu. A cruiser sidestep of 25 fu executed when the boarder is 40 fu away cannot be matched by either craft, so the boarder passes and is removed when it leaves the corridor. Sidestepping early (80+ fu away) lets the craft re-aim. The tension is the timing.

### 5.4 Scrap
- Fragments spawn at the kill position with a random spread, drift down the corridor at 20 fu/s with mild lateral jitter, and expire at z < −35 or after 8 s, whichever comes first.
- When a fragment's center enters the magnet perimeter, it accelerates toward the hull at 90 fu/s² and is collected on contact. Each fragment is worth 1 scrap.
- **DECISION:** Scrap is never lost on damage. The only loss is letting fragments fall past.

### 5.5 Deck, breaches and drones
- The deck is a hand-authored graph in `assets/deck/aegis-deck.json` (schema in Appendix A). It has 5 breach points: bow, port-fore, port-aft, starboard-fore, starboard-aft. All paths converge on the core node at the stern.
- Path lengths: bow → core 40 du, fore flanks → core 28 du, aft flanks → core 18 du. Aft breaches are the most dangerous and are reachable only by boarders that hit the rear third of the hull.
- 30 turret slots on bulkheads flanking the paths. Each slot has a `mount` tag: `center` or `flank-port` or `flank-starboard`, used by Artillery arcs.
- A clamped boarder chooses the breach point nearest its impact point along the hull.
- Drones path along the graph by precomputed shortest path to the core (the graph is static, so Dijkstra runs once at load). They never retarget.

| Drone | HP | Speed (du/s) | Core damage on arrival |
|---|---|---|---|
| Strike | 10 | 4.0 | 10 |
| Assault | 32 | 2.2 | 25 |

- Core integrity 100. A drone that reaches the core deals its damage and is destroyed.
- Time-to-core, unopposed: Strike from bow 10 s, from fore flank 7 s, from aft flank 4.5 s. Assault from bow 18 s. In Tactical Mode those become 50, 35, 22.5 and 90 s of real time, which is the window the player has to react.

### 5.6 Turrets

| Turret | Cost | Refund | Range | Fire | Damage | Notes |
|---|---|---|---|---|---|---|
| Point Defense Battery | 25 | 12 | 4.5 du (deck) | 10 rounds/s | 3 | Kills a Strike drone in 0.33 s, an Assault in 1.07 s. With no drone in range, targets torpedoes within 40 fu of the cruiser; one intercept per 1.5 s reset. |
| Cryo Emitter | 35 | 17 | 6 du | 1 round / 5 s | 0 | Round detonates into a stasis field: radius 2.5 du, lasts 4 s, slows drones by 65%. Fields do not stack; the strongest applies. |
| Artillery Battery | 60 | 30 | Flight corridor | 1 shell / 2.5 s | 24 in a 7 fu splash | Ignores the deck. Shell speed 70 fu/s. `center` mounts fire straight ahead; `flank-*` mounts fire at ±30° outward. Kills a Skirmisher per direct hit and often clips 2–3 in a formation. |

Targeting: Point Defense picks the drone closest to the core in range. Cryo fires at the center of the largest drone cluster in range, and only when at least 2 drones are within 3 du of each other. Artillery leads its target using shell speed and enemy velocity.

**Why these numbers:** one Point Defense sees a Strike wave (4 drones at 4 du/s crossing a 9 du diameter) for 2.25 s and can kill about 6 drones' worth of HP, so it barely handles a light wave alone. An Assault wave (5 drones at 2.2 du/s) is in range for 4.1 s, worth about 3.8 kills, so it needs a second battery or a Cryo field. Cryo multiplies exposure time by 1 / (1 − 0.65) = 2.86, which makes one battery plus one emitter beat one wave comfortably. Layering is required by arithmetic, not by hope.

### 5.7 Tactical Mode economics
Placement is instant. Dismantle refunds 50%, rounded down. Turrets cannot be moved; dismantle and rebuild is the move. **DECISION:** No upgrades in Basic.

### 5.8 Escalation
Threat level L is a real number: `L = max(scrapCollected / 40, elapsedSimSeconds / 75)`. The time term is a floor so that refusing scrap never freezes difficulty; the scrap term is the intended driver and outpaces the floor for anyone actually playing.

| Threat L | Formation every | Formation size | Boarder every | Heavy share | Lancer pairs |
|---|---|---|---|---|---|
| 0 | 7.0 s | 4 | 22 s | 0% | none |
| 2 | 6.3 s | 5 | 19.6 s | 0% | every 25 s |
| 4 | 5.6 s | 6 | 17.2 s | 30% | every 20 s |
| 6 | 4.9 s | 7 | 14.8 s | 40% | every 16 s |
| 8 | 4.2 s | 8 | 12.4 s | 50% | every 13 s |
| 12 | 2.8 s | 8 | 7.6 s | 50% | every 10 s |
| 16+ | 2.5 s (floor) | 8 | 6 s (floor) | 50% | every 8 s (floor) |

Formulas: formation interval `clamp(7 − 0.35 L, 2.5, 7)`; size `min(8, 4 + floor(L / 2))`; boarder interval `clamp(22 − 1.2 L, 6, 22)`; heavy share `clamp(0.1 L − 0.1, 0, 0.5)` from L ≥ 3; Lancer interval `clamp(30 − 1.25 L, 8, 30)` from L ≥ 2. Spawns use a seeded RNG (Section 7.4).

**Pressure check at L = 8:** 8 skirmishers × 12 HP every 4.2 s is 23 HP/s of incoming health. Autocannons deliver 40 damage/s at 100% accuracy and about 24 at a realistic 60%. The player is at parity without Artillery, which is the intended moment Artillery earns its cost.

### 5.9 Bonus mechanic: cloud cover (not in Basic)
Flying the cruiser inside a storm tower breaks skirmisher line of sight (they hold fire) and slows scrap magnetism by half. Icing deals 1 hull per second after 3 s inside. This turns the volumetrics into a tactical resource. It is excluded from Basic because it complicates the sim bot and the readability rules.

### 5.10 Defeat and score
Defeat when hull ≤ 0 (Structural Collapse) or core ≤ 0 (Core Breach). Score = scrap collected + 2 per kill + 25 per boarder made to overshoot. Best score and best time persist in `localStorage`. **ASSUMPTION:** Endless survival, no win state, no waves between which the game pauses.

---

## 6. Balance: method, levers and the simulation loop

### 6.1 Principle
The agent has no hands to playtest with. Balance therefore runs as a **headless simulation** of the exact game logic with scripted players, in Node, in seconds, with seeds. Every balance change is a config diff plus a sim report.

### 6.2 Levers, force-ranked by impact
1. Formation interval and size (incoming HP per second).
2. Boarder interval and turn rate (boardings per minute and how dodgeable they are).
3. Point Defense damage and range (deck lethality).
4. Scrap per skirmisher (economy speed and therefore escalation speed).
5. Tactical time scale (reaction window).
6. Drone speeds (time-to-core).
7. Artillery cost (when the flight front gets help).

### 6.3 Degenerate strategies and their counters

| Strategy | Why it is tempting | Counter built in |
|---|---|---|
| Starve scrap to keep threat low | Escalation is scrap-driven | Time floor on L; unspent scrap does nothing |
| Camp in Tactical Mode | Slow-mo makes dodging trivial | Cruiser cannot move in Tactical; bolts still land |
| Build only Point Defense | Cheapest, kills everything | Assault waves out-tank a single battery; torpedo reset limits intercepts |
| Sit at the bottom of the corridor | Maximum reaction time | Scrap expires before reaching the bottom; boarders arrive with more speed to re-aim |
| Dismantle-and-rebuild to reposition every wave | Free flexibility | 50% refund tax |

### 6.4 Sim harness specification
- Location: `sim/`. Imports `src/game/**` only; must not import anything from `src/render/**` or the DOM.
- Bots: `dodger` (moves perpendicular to the nearest threat's velocity, builds Point Defense at the shortest path to the core when a boarding happens), `greedy` (chases scrap, dodges only bolts within 15 fu), `builder` (enters Tactical on every boarding and builds by a fixed priority list), `idle` (control).
- Each run: seed, bot, config hash → survival time, cause of death, scrap collected, scrap spent, threat at death, per-minute damage sources, per-turret kills.
- Batch: 200 seeds per bot per config. Output JSON plus a Markdown summary table committed under `sim/reports/YYMMDD-<label>.md`.
- Speed target: a 10-minute simulated run in under 0.5 s of wall time.

### 6.5 Tuning protocol (the loop the agent runs)
1. Run the batch on the current config. Record medians and the death-cause split.
2. Compare with the targets in 6.6. Identify the single largest miss.
3. Change one lever from 6.2 by at most 15%.
4. Re-run. Keep the change only if the target miss shrinks without another target crossing its band.
5. Commit config and report together. Stop after 12 iterations or when all targets are inside bands.

### 6.6 Targets

| Metric | Band | Rationale |
|---|---|---|
| `dodger` median survival | 240–360 s | The competent-player proxy |
| `greedy` median survival | 120–200 s | Greed should be punished, not fatal instantly |
| `idle` median survival | 25–45 s | Doing nothing dies fast, but not before the first hint shows |
| Death-cause split for `dodger` | 35–65% hull | Both fronts matter |
| Scrap collected per minute for `dodger` at L 0–4 | 60–110 | One turret every 15–25 s early |
| Boarders overshot per boarder for `dodger` | 55–75% | Dodging should be learnable but not free |

These bands are hypotheses. After the first human playtest by the owner, re-anchor the `dodger` band to the owner's own median.

---

## 7. Technical architecture

### 7.1 Stack (versions checked 2026-09-07)

| Piece | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, `strict: true` | |
| Build | Vite 6.x *(version unverified)* | Static output, deploys to GitHub Pages |
| Renderer | three.js 0.185.1 (`three` on npm, published mid-2026) with `WebGPURenderer` and its WebGL 2 fallback | Section 8.2 has the decision gate |
| Shaders | TSL (three.js Shading Language) node functions | One source compiles to WGSL and GLSL |
| Post-processing | three.js WebGPU `PostProcessing` node pipeline | Bloom, ACES tone mapping, vignette |
| Audio | Web Audio API with the ZzFX micro-synth for SFX *(library version unverified)* | Nano Banana cannot make audio; SFX is procedural. Music is Bonus. |
| Tests | Vitest for unit and sim; Playwright for browser smoke and screenshots | |
| Lint | ESLint + Prettier | |
| Dev tools | `lil-gui` tuning panel behind `?dev=1`, `stats-gl` frame meter | Not shipped in production |
| Image generation | `@google/genai` Node SDK, build-time only | Section 10 |

**DECISION:** No physics engine, no React, no state library. The game is small enough that a hand-written entity list and a fixed-step loop are simpler and faster to reason about.

### 7.2 Repository layout

```
aegis-protocol/
  index.html
  src/
    main.ts                 boot, quality probe, loading screen
    config/                 balance.ts, palette.ts, quality.ts
    game/                   pure simulation, no DOM, no three.js
      world.ts              entity arrays, fixed-step tick
      cruiser.ts  enemies.ts  scrap.ts  spawner.ts  escalation.ts
      deck/  graph.ts  drones.ts  turrets.ts  pathing.ts
      rng.ts                seeded PRNG
      events.ts             typed event bus (kill, boarding, build, damage)
    input/                  touch.ts, keyboard.ts, mapping to intents
    render/
      renderer.ts           WebGPURenderer setup, backend detection
      scene.ts              camera rig, mode blending
      ships/                procedural mesh factories
      fx/                   bolts, contrails, explosions (instanced)
      clouds/               Section 9: noise.ts, weather.ts, cloudPass.ts, reproject.ts
      sky.ts  post.ts
    ui/                     HUD DOM components, menus, hints
    audio/
  sim/                      headless harness, bots, reports/
  tools/
    gen-assets.mts          Nano Banana pipeline (Section 10)
    gen-noise.mts           offline noise generator for golden tests
  assets/
    deck/aegis-deck.json
    generated/              committed outputs from tools/, with manifest.json
  test/                     vitest unit tests
  e2e/                      Playwright smoke and screenshots
```

### 7.3 Loop and timing
- Fixed simulation step of 1/60 s. The render loop accumulates real time × mode time scale and ticks the simulation zero or more times per frame. Render interpolates positions between the last two sim states.
- Mode time scale changes are applied at tick boundaries, never mid-tick.
- The cloud animation (wind) advances with **simulation** time so it slows in Tactical Mode along with everything else.

### 7.4 Determinism
- One seeded PRNG (`mulberry32` or `xoshiro128**`) per world. Spawns, drops, spreads and bot decisions all draw from it. Visual-only randomness (particle jitter) uses a separate stream so it never affects gameplay.
- A run is fully described by `(seed, configHash, inputLog)`. The e2e tests replay input logs.

### 7.5 Entity model
Plain arrays of typed structs per entity kind, dense, with swap-remove on death. No generic ECS library. Each kind has `tick(world, dt)` and the render side reads positions through an interpolation view. Collision is a uniform grid of 20 fu cells over the corridor; the deck uses the graph directly.

### 7.6 State machine
`Boot → Loading → Title → Flight ⇄ Tactical → Death → Title`. Pause overlays Flight or Tactical without leaving the state.

### 7.7 Persistence
`localStorage` keys: `aegis.best`, `aegis.settings` (quality tier, audio volume, hints seen). No backend, no accounts, no analytics.

### 7.8 Security and privacy invariants (do not regress)
- No API key in the shipped bundle. Nano Banana runs only in `tools/` with a key from a local `.env` that is git-ignored.
- No network calls at runtime other than fetching the game's own static assets.
- No personal data collected. `localStorage` holds settings and scores only.
- CI gate on every pull request: typecheck, lint, unit tests, sim smoke (10 seeds per bot), Playwright smoke.

---

## 8. Rendering pipeline

### 8.1 Frame order

1. **Sim interpolation** writes transforms for ships, bolts, scrap, drones.
2. **Opaque pass** at full resolution scale: cruiser, deck (in Tactical), enemies, scrap. Writes depth.
3. **Sky** as a full-screen quad behind everything (analytic gradient, Section 3.3), written where depth is far.
4. **Cloud pass** at reduced resolution (Section 9.6), reading the opaque depth buffer so towers correctly occlude and are occluded by ships. Outputs cloud color and transmittance.
5. **Temporal reprojection and upsample** of the cloud buffer to full resolution using depth-aware (bilateral) upsampling.
6. **Composite**: `scene = clouds.rgb + scene.rgb × clouds.transmittance`.
7. **Transparent FX**: bolts, contrails, explosions, cryo fields, drawn after clouds and attenuated by the cloud transmittance at their depth (sample the upsampled transmittance buffer).
8. **Post**: bloom (threshold 1.0, small radius), ACES tone mapping, vignette, optional film grain at low intensity.
9. **HUD** in the DOM on top.

### 8.2 WebGPU versus WebGL 2: the decision gate
**DECISION:** Build on `WebGPURenderer` with TSL. It runs on WebGPU where available and falls back to a WebGL 2 backend from the same shader source. This is the direction three.js is taking and it gives compute shaders on WebGPU for free.

**Gate (Milestone 0):** the agent must prove, on both backends, that a TSL fragment node can (a) loop a variable number of times with early exit, (b) sample a 3D texture with trilinear filtering, (c) read the scene depth texture in a post pass, and (d) ping-pong between two render targets for reprojection. If any of these fails on the WebGL 2 backend and cannot be fixed within two agent-days, **Plan B** is `WebGLRenderer` with GLSL `ShaderMaterial` for the cloud pass only, keeping everything else in TSL where possible. Record the result in `docs/DEV_LOG.md`.

*Unverified:* whether Safari on iOS in 2026 exposes WebGPU by default. The fallback path exists for exactly this reason, so it is a risk to check, not a blocker.

### 8.3 Quality tiers

| Tier | Resolution scale | Cloud buffer | March steps | Light steps | Reprojection | Towers | Bloom |
|---|---|---|---|---|---|---|---|
| Low | 0.75 | 1/4 res | 32 | 4 | none (temporal blend 0.85) | off | off |
| Medium | 1.0 | 1/2 res | 48 | 5 | 2×2 (1/4 of pixels per frame) | on | on |
| High | 1.0 | 1/2 res | 64 near + 32 far | 6 | 4×4 (1/16 per frame) | on | on |

Tier selection: start at Medium; after 3 seconds of play, if the 95th-percentile frame time exceeds the target budget (33.3 ms at 30 fps for Low, 16.7 ms otherwise) drop one tier; if it sits under 60% of budget for 20 seconds, raise one tier, at most once per session. Persist the result.

### 8.4 Frame budget at Medium on mobile high (target 16.7 ms)

| Pass | Budget |
|---|---|
| Sim + interpolation (CPU) | 2.0 ms |
| Opaque + FX | 3.5 ms |
| Cloud march | 6.0 ms |
| Reproject + upsample + composite | 1.5 ms |
| Post | 1.5 ms |
| Headroom | 2.2 ms |

These are budgets to design against, not measurements. Section 12.4 says how to measure.

### 8.5 Ships and deck as procedural meshes
Nano Banana makes images, not meshes, so ships are built in code from primitives (boxes, cylinders, lathe and extrude geometries) by factory functions in `src/render/ships/`. Each factory takes a seed and a palette and returns a single merged `BufferGeometry` with UVs laid out so the generated hull and panel textures tile sensibly. Enemies use `InstancedMesh` per type. The deck is one mesh: floor plane, bulkhead extrusions from the graph, breach hatches, core housing, with a cutaway roof that is simply not rendered.

**Alternative, flagged:** CC0 kitbash packs (for example the Kenney space kits) would look better faster. *Not verified from this session and no URL is given for that reason.* Procedural is the default because it is deterministic and needs no downloads.

---

## 9. Volumetric clouds: the Nubis adaptation

### 9.1 What we take from the papers
The system follows the published Guerrilla work in four layers. The agent should read the primary sources (Section 16) before implementing; the summary here is what this plan commits to.

| Source | What we take |
|---|---|
| Schneider & Vos, SIGGRAPH 2015, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" | Weather map (coverage, type) driving density; low-frequency Perlin-Worley 3D noise for base shapes and high-frequency Worley for erosion; height gradients per cloud type; curl noise to distort edges; Beer's law with a cone of light samples; Henyey-Greenstein phase; the "powder" darkening at cloud edges; adaptive step size; updating 1 of every 16 pixels per frame with reprojection |
| Schneider & Vos, SIGGRAPH 2017, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" | Cloud "dimensional profile" replacing hard-coded height gradients; the multiple-scattering approximation with attenuation, contribution and eccentricity octaves; in-scatter and out-scatter ambient probability terms; authoring by cloud type |
| Schneider, SIGGRAPH 2022, "Nubis, Evolved" | Temporal upscaling for fast-moving clouds; internal lighting and lightning flashes (Bonus); the idea that near clouds can be modeled as explicit volumes rather than by weather map alone |
| Schneider, SIGGRAPH 2023, "Nubis³" | Voxel-based near clouds with a distance-field acceleration structure. **DECISION:** Not adopted for Basic. Our towers stay weather-map driven with a tall cumulonimbus profile, because a voxel pipeline is a second modeling system and the agent has no authoring tool. Revisit in Bonus if tower silhouettes are unsatisfying. |

### 9.2 Cloud domains
Two domains are marched in the same pass with one code path and different parameters:

| Domain | Vertical extent (fu) | Role | Density scale |
|---|---|---|---|
| Deck | 1250 → 1600 | The sea of clouds below the ship. Stratocumulus, high coverage (0.55–0.8), rolling tops. | Base |
| Towers | 1250 → 2100 | Cumulonimbus columns rising through the deck and past the corridor. Placed by the weather map's type channel. Their height fraction is computed over the tower extent, so the profile gives them a flat-ish anvil near the top. | Base × 1.6 |

The ray is marched through the union slab 1250 → 2100 fu. Where the type channel is below 0.6 the tower term is zero and only the deck contributes, so the extra height costs nothing on most rays. Coverage near the corridor is authored so tower footprints keep at least 60% of the corridor width open (Section 4.5).

### 9.3 Data and where it comes from

| Texture | Size | Channels | Source |
|---|---|---|---|
| Low-frequency noise | 128³, RGBA8 | R = Perlin-Worley, G/B/A = Worley at 2×, 4×, 8× frequency | Generated at runtime in a Web Worker on first load (about 2 M voxels), cached in IndexedDB. About 8 MB uncompressed, which is why it is not downloaded. The same generator runs in `tools/gen-noise.mts` for golden tests. |
| High-frequency noise | 32³, RGB8 | Worley at 3 frequencies | Same generator |
| Curl noise | 128², RGB8 | Curl of a Perlin field | Same generator |
| Weather map | 512², RGBA8 | R coverage, G cloud type (0 stratus, 0.5 cumulus, 1 cumulonimbus tower), B wetness (darkens bases), A unused | **Nano Banana**: prompted as a top-down grayscale "satellite coverage map", then normalized and channel-packed by the pipeline (Section 10). One map per weather preset; Basic ships 3 presets. |
| Dimensional profile | 64 × 32, R8 | Density envelope by (type, height fraction) | Authored as a small function in `tools/` and baked to a texture. Stratus: dense low, cut off by 0.35. Cumulus: peak at 0.35, taper to 0.85. Cumulonimbus: full column to 0.85 then widen to an anvil, cut at 1.0. |
| Blue noise | 64², R8 | Per-pixel step offset and reprojection dither | Generated by void-and-cluster in `tools/` |

Runtime noise generation needs a loading screen of 2–5 s on a phone *(estimate, unverified)*. The loading screen plays the title sky, which is analytic and needs no noise.

### 9.4 Density modeling (per sample)

```
density(p, lod):
  w        = weather(p.xz * weatherScale + windOffset)      // coverage, type, wetness
  hfDeck   = saturate((p.y - deckBase) / (deckTop - deckBase))
  hfTower  = saturate((p.y - deckBase) / (towerTop - deckBase))
  isTower  = smoothstep(0.6, 0.8, w.type)
  hf       = mix(hfDeck, hfTower, isTower)
  profile  = profileLUT(w.type, hf)
  n        = lowFreq(p * baseScale + windOffset3)          // RGBA
  fbm      = n.g * 0.625 + n.b * 0.25 + n.a * 0.125
  base     = remap(n.r, -(1 - fbm), 1, 0, 1)
  base     = remap(base * profile, 1 - w.coverage, 1, 0, 1) * w.coverage
  if base <= 0 or lod == COARSE: return base * densityScale(isTower)
  c        = curl(p.xz * curlScale)
  p2       = p + vec3(c.x, 0, c.y) * (1 - hf) * curlStrength
  h        = highFreq(p2 * detailScale)
  hfbm     = h.r * 0.625 + h.g * 0.25 + h.b * 0.125
  hmod     = mix(hfbm, 1 - hfbm, saturate(hf * 10))          // wispy bases, billowy tops
  d        = remap(base, hmod * 0.2, 1, 0, 1)
  return d * densityScale(isTower) * mix(1, 0.7, w.wetness * (1 - hf))
```

`remap(v, l0, h0, l1, h1) = l1 + (v − l0) × (h1 − l1) / (h0 − l0)`, clamped. Wind: the deck scrolls toward −z at the apparent speed of the cruiser (a design constant of 12 fu/s of scroll, because the ship is not really moving in the sim) plus a slow lateral drift, both in simulation time. Towers scroll with the same offset so they pass the ship like landmarks; a tower takes about 30 s to cross the corridor at the authored spacing.

### 9.5 Lighting (per sample with density > 0)

```
light(p, d, cosTheta, hf):
  // Cone of light samples toward the sun (2015): 5 samples along the sun
  // direction with a widening kernel, plus one far sample at 3x the cone
  // length to catch tower self-shadowing.
  dl = Σ density(p + sunDir * t_i + cone_i, COARSE) * Δt_i      // optical depth
  // Multiple-scattering approximation (2017), N = 3 octaves,
  // attenuation a = 0.5, contribution b = 0.5, eccentricity c = 0.5
  scatter = Σ_{i<3} a^i * exp(-dl * sigma * b^i) * phase(cosTheta, g * c^i)
  phase(cos, g) = mix(HG(cos, g), HG(cos, -0.15), 0.3)          // dual lobe, forward + weak back
  powder  = 1 - exp(-2 * d * sigma * stepLen)                     // optional edge darkening (2015)
  sun     = sunColor * scatter * mix(1, powder, powderStrength)
  // Ambient (2017 spirit): brighter at the top of the layer, darker inside.
  ambient = mix(ambientBottom, ambientTop, hf) * exp(-d * ambientDepthFalloff)
  return sun + ambient
```

`sigma` (extinction per fu of density 1) starts at 0.9 and is tuned by look. `g` starts at 0.6. All of these live in `src/config/clouds.ts` and are exposed to the dev panel.

### 9.6 Ray march
- One ray per cloud-buffer pixel. Ray start is the camera if it is inside the slab, else the slab entry; ray end is the slab exit or the scene depth, whichever is nearer. Rays that hit opaque geometry before the slab skip entirely.
- Two ranges: near (0–300 fu from camera) with base step 4 fu, and far (300 fu to 5000 fu) with step growing linearly to 60 fu. The near range covers everything at the ship's altitude; the far range covers the deck out to the horizon.
- Adaptive stepping (2015): march at 3× the base step while sampling `COARSE` density; on the first non-zero sample, step back one coarse step and switch to fine stepping with full detail; after 8 consecutive zero fine samples, return to coarse.
- Front-to-back integration:

```
T = 1; C = 0
for each step:
  d = density(p, lod)
  if d > 0:
    L  = light(p, d, cosTheta, hf)
    C += T * L * d * stepLen
    T *= exp(-d * sigma * stepLen)
    if T < 0.01: break
  p += dir * stepLen
output rgb = C, a = 1 - T
```

- Per-pixel blue-noise jitter of the first step length, changing per frame, so temporal accumulation converges.
- Horizon fade: multiply `C` by an exponential height fog toward the sky horizon color beyond 3000 fu so the deck meets the sky softly.

### 9.7 Temporal reprojection and upsampling
- The cloud buffer is rendered at 1/2 or 1/4 resolution. At Medium and High only a Bayer-ordered subset of its pixels (1/4 or 1/16) is freshly marched each frame; the rest are reprojected from the previous frame using the previous view-projection matrix and the previous depth.
- Reprojection validity: reject the history sample if it falls outside the previous frame, if the depth difference exceeds 5%, or if the mode camera blend is in its first 4 frames. Rejected pixels fall back to the nearest freshly marched neighbor for that frame.
- On the Flight ⇄ Tactical camera blend, force a 4-frame full refresh (march every pixel at 24 steps) rather than accepting 16 frames of smear. This costs about one Medium frame of budget per transition and happens rarely.
- Upsampling to full resolution is bilateral: weights by depth similarity so cloud edges do not bleed onto ships.

### 9.8 Stratosphere-specific adaptations (not in the papers)
- The camera looks **down** at the deck rather than up at a sky. Slab entry is therefore the top plane at 1600–2100 fu and the ray leaves through the base or terminates on transmittance. Far rays are long and nearly parallel to the deck top near the horizon; the far-range step growth handles that.
- The camera can be **inside** the tower slab. The ray must start at the camera and the near range must handle density at distance zero without artifacts: the first step is jittered and the tower density is faded to zero within 10 fu of the camera to avoid a full-screen wall on tower entry.
- Ships **inside** clouds: depth-aware compositing handles occlusion; FX inside clouds read the transmittance buffer so bolts fade correctly.
- The deck and towers scroll with simulation time. In Tactical Mode they slow with everything else, which reads as intentional.

### 9.9 Verification for the cloud system
- Golden-image test: fixed seed, fixed camera, fixed sun, both backends, compared to committed PNGs with a perceptual threshold (SSIM ≥ 0.97).
- Energy sanity: with coverage 1 and sun overhead, transmittance through the deck must be below 0.02, and no pixel may exceed the sun color's luminance × 1.2 before bloom.
- Reprojection sanity: pan the camera 2 fu per frame for 60 frames; the mean absolute difference between reprojected and freshly marched full-frame output must stay under 4/255.
- Performance: cloud pass GPU time measured with timestamp queries on WebGPU and `EXT_disjoint_timer_query_webgl2` where available, else wall-clock proxy; recorded per tier in `docs/DEV_LOG.md`.

---

## 10. Asset pipeline with Nano Banana

### 10.1 Principles
- **Build-time only.** `tools/gen-assets.mts` calls the Gemini API, post-processes, and writes to `assets/generated/` with a `manifest.json` entry per asset: prompt, model ID, seed if supported, date, SHA-256 of the output, and license note. Outputs are committed. The game never calls the API.
- **Reproducible in spirit, not bit-exact.** Image models are not deterministic across versions. The manifest lets the agent regenerate and compare, not reproduce.
- **Every generated image passes a check** before it is accepted: tileability seam score, size, channel packing, and a visual thumbnail sheet committed for the owner's review.

### 10.2 Model choice
Search on 2026-09-07 returned three Nano Banana model IDs: `gemini-2.5-flash-image` (original), `gemini-3-pro-image-preview` (pro), and `gemini-3.1-flash-image-preview` (Nano Banana 2). *(All unverified against the official docs page, which this container could not open.)* **DECISION:** Default to the newest Flash Image model available when the agent starts, with the 2.5 Flash Image ID as the fallback; record the exact ID used in the manifest. Price figures found were third-party (roughly $0.04–0.15 per image) and are *unverified*; budget the whole pipeline at about 120 images, so under $20 even at the high end.

### 10.3 What to generate, and how each is post-processed

| Asset | Count | Prompt intent | Post-processing |
|---|---|---|---|
| Hull panel albedo (cruiser) | 3 variants | Seamless tileable painted steel aircraft panels, rivets, faint wear, overcast lighting, flat, no perspective | Tile check; make seamless by offset-and-blend if the seam score fails; derive roughness from inverted luminance; derive normal map from a Sobel height estimate |
| Enemy hull albedo | 2 | Darker composite plating with red warning stripes | Same |
| Deck floor, bulkhead, core housing | 3 | Top-down industrial deck plating, grated walkways, glowing reactor housing | Same, plus an emissive mask keyed from the brightest hue |
| Weather maps | 3 presets | Top-down satellite-style grayscale cloud coverage, soft blobs, a few dense circular cells for storms | Normalize to [0,1]; coverage from luminance; type from a thresholded blur of the densest cells; wetness from a wide blur; pack RGBA |
| Cirrus veil | 1 | Very thin, streaky, high-altitude cirrus on black, seamless | Luminance to alpha; tile |
| Turret sprites for radial menu | 3 | Clean top-down icon on flat magenta background | Key out magenta; erode 1 px; export 256² PNG |
| HUD icons (hull, core, scrap, threat, pause) | 5 | Same style as above | Same |
| Title backdrop | 1 | Cinematic key art: a warship above a sea of clouds at sunset, portrait | Downscale to 1080 × 1920; JPEG at 80 |
| Decals (numbers, hazard stripes, squadron insignia) | 6 | Flat vector-style decals on magenta | Key out |

Transparent output is *unverified* for these models, so the pipeline assumes a solid magenta background and keys it out. Rendered text inside images is avoided; the HUD sets all text in the DOM.

### 10.4 Prompt template
```
Style: [flat texture / top-down icon / key art]. Subject: [what]. Constraints:
seamless tileable, no perspective, no vignette, no text, no watermark-like
marks, neutral overcast lighting, [palette hexes]. Output: square, [size].
Background: solid #FF00FF (only for keyed assets).
```
Every prompt is stored verbatim in the manifest. Nano Banana outputs carry an invisible SynthID watermark; this is acceptable for a game and noted in `assets/generated/LICENSE.md`.

### 10.5 Fallbacks
If the API is unavailable or the key is missing, `tools/gen-assets.mts --procedural` writes placeholder textures (noise-based panels, flat icons) so the build never depends on the API. The game must look acceptable with placeholders; generated art is an upgrade, not a dependency.

---

## 11. Audio
- SFX via ZzFX-style parameter presets: autocannon (short, repeating, pitched low), bolt fire, bolt hit, scrap pickup (rising blip), boarder approach (a climbing drone that scales with distance), boarding clamp (heavy metal), turret build, cryo burst, artillery shot, drone death, core hit (alarm), death.
- Mixer: master, SFX, UI. In Tactical Mode, SFX pitch drops by 20% and a low-pass filter closes to 1.2 kHz to sell the time dilation.
- Music: Bonus. A simple procedural drone (two detuned oscillators through a slow filter) is acceptable as a Basic placeholder if it costs under an agent-hour.

---

## 12. Testing and verification

### 12.1 Unit (Vitest)
- `remap`, PRNG determinism, graph shortest paths, turret targeting choices, escalation formulas at table values, scrap magnet accounting, boarder turn-radius overshoot cases from Section 5.3.

### 12.2 Simulation (Vitest + `sim/`)
- Smoke: 10 seeds × 4 bots must finish without exceptions and produce a death cause.
- Balance batch: 200 seeds × 4 bots, run on demand and by a manual CI job, report committed.

### 12.3 Browser (Playwright, Chromium)
- Boot to Title in under 8 s on the CI runner.
- Replay a 60-second input log from a fixed seed; assert the final HUD values against the sim's numbers for the same seed (the render must not change the game).
- Screenshots at fixed frames for the golden-image tests in Section 9.9.
- Portrait and landscape viewports at 390 × 844 and 1440 × 900.

### 12.4 Performance gates
- The dev panel writes a rolling frame-time histogram; `?bench=1` runs a 30-second scripted flight and dumps p50 / p95 per pass to the console and to `docs/DEV_LOG.md` when run by the agent.
- CI cannot measure GPU time meaningfully, so the gate is: bench p95 on the agent's desktop under 12 ms at High. Mobile numbers are recorded by the owner on real phones and fed back (Section 15).

### 12.5 What "not verified" must always list
Every milestone report ends with the untested items, in this shape: what was tested, how, and what was left untested. Claims of "works on mobile" are not allowed until a real phone has run it.

---

## 13. Delivery plan

### 13.1 Critical path (the 7 items that gate everything else)
1. Renderer decision gate on both backends (Section 8.2).
2. Simulation core with the deck graph, playable with placeholder cubes.
3. Cloud ray-marcher with depth compositing, one layer, no reprojection.
4. Reprojection and quality tiers.
5. Sim harness and first balance pass.
6. Asset pipeline and art integration.
7. Mobile verification on real devices and the final balance pass.

### 13.2 Milestones and proposed dates
Dates assume kickoff Monday 2026-09-08 and one agent working continuously with owner check-ins at each milestone. They are proposals for the owner to confirm.

| Milestone | Dates | Deliverable | Acceptance |
|---|---|---|---|
| M0 Spike | Sep 8–9 | Vite + TS + three.js scaffold; TSL raymarch of a 3D noise sphere on WebGPU and WebGL 2; depth read in a post pass | Gate items (a)–(d) pass on both backends, or Plan B chosen and logged |
| M1 Core loop | Sep 10–14 | Cruiser, autocannons, skirmishers, scrap, hull damage, HUD, death screen, seeded RNG | 60-second replay test passes; `idle` bot dies in 25–45 s |
| M2 Deck | Sep 15–18 | Deck graph, breaches, Grapple boarders, Strike drones, Point Defense, Tactical Mode with time dilation and camera blend | Boarding → build → survive is playable with cubes |
| M3 Clouds I | Sep 19–24 | Noise worker, weather map, deck layer, lighting, adaptive march, compositing, sky | Golden images on both backends; energy sanity passes |
| M4 Clouds II + tiers | Sep 25–29 | Towers, reprojection, bilateral upsample, three tiers, auto-tier | Reprojection sanity passes; desktop p95 under 12 ms at High |
| M5 Full roster + balance | Sep 30–Oct 4 | Cryo, Artillery, Lancer, Ram, Assault drones, escalation, sim harness, first tuning loop | All Section 6.6 bands hit or the misses are documented with a proposed lever |
| M6 Art + audio | Oct 5–8 | Nano Banana pipeline, procedural ships textured, decals, icons, SFX, first-run hints, high score | Thumbnail sheet reviewed by owner; placeholders fully replaced or fallback documented |
| M7 Ship | Oct 9–12 | Mobile verification round with owner, final balance pass, GitHub Pages deploy, `README`, `DEV_LOG` | Owner plays 3 runs on a phone; deploy URL verified loading |

Bare tier corresponds to M0–M3 with a single turret. Bonus items start only after M7.

### 13.3 Owner check-in points
- After M0: confirm renderer path.
- After M2: play the cube version on desktop; confirm the feel of Tactical Mode before art is spent on it.
- After M5: confirm balance bands against the owner's own runs.
- After M6: approve the thumbnail sheet.

---

## 14. Risks, force-ranked

| # | Risk | Failure scenario | Mitigation | Where |
|---|---|---|---|---|
| 1 | Cloud pass too slow on mobile | Medium tier drops to 20 fps on a 2023 phone once towers are on; the game feels broken on its primary platform | Quarter-res Low tier with towers off, auto-tier, 32-step cap; measure on real phones at M4, not M7 | Sections 8.3, 9.6 |
| 2 | WebGL 2 backend of the WebGPU renderer cannot run the TSL raymarch loop | Fallback devices get no clouds at all | M0 gate with Plan B decided in two days | Section 8.2 |
| 3 | Reprojection smears during the mode camera blend | Every Tactical toggle shows 16 frames of ghosting, which is the moment the player looks hardest | Forced 4-frame full refresh on blend | Section 9.7 |
| 4 | Balance targets unreachable by sim alone | Bots survive far longer or shorter than a human, and the tuned game is wrong for people | Re-anchor bands to the owner's runs at M5 and M7; the sim finds regressions, the human sets the anchor | Section 6.6 |
| 5 | Tactical camping dominates | Player sits in slow motion and the game becomes trivial | Cruiser cannot move in Tactical; cap lever ready | Section 4.3 |
| 6 | Nano Banana outputs are not tileable or not keyable | Seams on the hull; magenta halos on icons | Seam score check, offset-and-blend, erode; procedural fallback | Section 10 |
| 7 | Runtime noise generation takes too long on low phones | 10-second black loading screen on first run | Cache in IndexedDB; 64³ low-frequency texture at Low tier; title sky needs no noise | Section 9.3 |
| 8 | Model IDs or SDK shape change before the agent starts | The asset script fails on first run | Manifest records the ID; script takes the ID as a flag; the agent re-checks the docs first | Section 10.2 |

---

## 15. Assumptions and open questions for the owner

**Assumptions made in this plan (confirm or override):**
1. Target tier is Basic.
2. The Lancer torpedo craft exists so Point Defense has something to intercept.
3. Tower tops at 21 km are acceptable stylization.
4. No hull repair in Basic.
5. No time cap on Tactical Mode unless the sim shows camping is dominant.
6. Endless survival with no win state.
7. Procedural ship meshes, not downloaded kits.
8. The game ships to GitHub Pages as a public static site with no backend.
9. Dates in Section 13.2 start Monday 2026-09-08.

**Open questions:**
1. Which phones can the owner test on? The tiers in Section 2.3 should be mapped to real devices.
2. Does the owner want a gamepad in Basic? It is cheap but adds a test surface.
3. Is the SynthID watermark in generated art acceptable for this project's intended distribution?
4. Should the deck layout be a single authored map for Basic, or two (a second one unlocked by score)? The plan assumes one.

---

## 16. References
Links below were returned by web search on 2026-09-07. The container running this session could not open the Guerrilla, Google AI, DeepMind or advances.realtimerendering.com pages, so their contents are summarized from prior knowledge and the search snippets; the agent must read them directly.

- Guerrilla Games, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015): https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn *(not opened here)*
- Guerrilla Games, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" (SIGGRAPH 2017): https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine *(not opened here)*
- Slides for the 2017 talk (Advances in Real-Time Rendering course archive): https://advances.realtimerendering.com/s2017/Nubis%20-%20Authoring%20Realtime%20Volumetric%20Cloudscapes%20with%20the%20Decima%20Engine%20-%20Final%20.pdf *(not opened here)*
- Guerrilla Games, "Nubis, Evolved" (SIGGRAPH 2022): https://www.guerrilla-games.com/read/nubis-evolved *(not opened here)*
- Guerrilla Games, "Nubis³" (SIGGRAPH 2023): https://www.guerrilla-games.com/read/nubis-cubed *(not opened here)*
- Andrew Schneider, Nubis Evolved talk pages on ArtStation: https://www.artstation.com/artwork/LeOOyv and https://www.artstation.com/artwork/ZeXyPZ *(not opened here)*
- three.js on npm (version 0.185.1 confirmed via the registry): https://www.npmjs.com/package/three
- three.js WebGPU volumetric cloud example: https://threejs.org/examples/webgpu_volume_cloud.html *(not opened here)*
- Gemini API image generation docs (Nano Banana): https://ai.google.dev/gemini-api/docs/image-generation *(not opened here)*
- Google AI Studio model page for Gemini 3.1 Flash Image (Nano Banana 2): https://aistudio.google.com/models/gemini-3-1-flash-image *(not opened here)*
- Meteoros, an open Vulkan implementation of the Decima cloud method, useful as a code reference: https://github.com/AmanSachan1/Meteoros *(not opened here)*

---

## Appendix A. Deck graph schema

```json
{
  "version": 1,
  "grid": { "width": 14, "height": 30, "cellFu": 0.5 },
  "nodes": [
    { "id": "breach-bow", "x": 7, "y": 29, "kind": "breach", "hullRange": [0.85, 1.0] },
    { "id": "breach-port-fore", "x": 0, "y": 20, "kind": "breach", "hullRange": [0.55, 0.85] },
    { "id": "n12", "x": 7, "y": 24, "kind": "junction" },
    { "id": "core", "x": 7, "y": 1, "kind": "core" }
  ],
  "edges": [
    { "from": "breach-bow", "to": "n12", "lengthDu": 5 }
  ],
  "slots": [
    { "id": "s01", "x": 5, "y": 24, "mount": "flank-port", "adjacentEdges": ["e03"] }
  ]
}
```

- `hullRange` is the fraction of hull length (0 = stern, 1 = bow) and side implied by the node's x; a boarder's impact point maps to the breach whose range and side match.
- `adjacentEdges` defines which corridors a slot's turret can see; range is measured along the graph, not as a straight line, so bulkheads block fire.
- Validation at load: every breach has a path to the core; every slot touches at least one edge; no two slots share a cell.

## Appendix B. Balance config shape

```ts
export const balance = {
  cruiser: { hull: 100, speedX: 55, speedZ: 40, accel: 320, decel: 400, magnetFu: 10 },
  autocannon: { rps: 10, damage: 4, speed: 160, spreadDeg: 1.5 },
  skirmisher: { hp: 12, speed: 30, weaveAmp: 12, weavePeriod: 2.5, boltEvery: 1.6, boltSpeed: 70, boltDamage: 6, ramDamage: 20, scrap: 3 },
  lancer: { hp: 20, speed: 24, holdZ: 90, torpEvery: 4, torpSpeed: 35, torpTurnDeg: 20, torpDamage: 18, torpHp: 6, scrap: 5, fromThreat: 2 },
  grapple: { hp: 45, speed: 45, turnDeg: 35, hullDamage: 8, waves: 2, perWave: 4, waveGap: 4, scrap: 6, fromThreat: 1 },
  ram: { hp: 110, speed: 28, turnDeg: 20, hullDamage: 15, waves: 3, perWave: 5, waveGap: 6, scrap: 12, fromThreat: 3 },
  drones: { strike: { hp: 10, speed: 4.0, coreDamage: 10 }, assault: { hp: 32, speed: 2.2, coreDamage: 25 } },
  turrets: {
    pd: { cost: 25, rangeDu: 4.5, rps: 10, damage: 3, torpRangeFu: 40, resetS: 1.5 },
    cryo: { cost: 35, rangeDu: 6, everyS: 5, fieldRadiusDu: 2.5, fieldS: 4, slow: 0.65 },
    artillery: { cost: 60, everyS: 2.5, damage: 24, splashFu: 7, shellSpeed: 70, flankAngleDeg: 30 },
    refund: 0.5,
  },
  escalation: { scrapPerLevel: 40, secondsPerLevel: 75 },
  tactical: { timeScale: 0.2, blendS: 0.35 },
  core: { hp: 100 },
  scrap: { driftSpeed: 20, lifeS: 8, magnetAccel: 90 },
} as const;
```

## Appendix C. Agent working agreement
- Read Sections 5, 7, 8 and 9 before writing code. Read the Section 16 primary sources before Section 9's code.
- Keep every tunable in `src/config/`. A literal number in game or render code is a review failure.
- Every milestone ends with: tests green, `docs/DEV_LOG.md` entry (what, why, new env or secrets, verified how, not verified), and a draft pull request. Never merge without the owner's go.
- Never put an API key anywhere but the git-ignored `.env` read by `tools/`.
- Prefer the smallest change that makes the failing test pass. Do not add libraries beyond Section 7.1 without noting the reason in the DEV_LOG.
- When a fact in this document turns out to be wrong (a version, a model ID, an API shape), fix the fact in this document in the same pull request as the code.
