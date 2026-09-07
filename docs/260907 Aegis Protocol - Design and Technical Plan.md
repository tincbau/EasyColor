# 260907 Aegis Protocol - Design and Technical Plan

**Status:** Revision 2, reviewed. Written 2026-09-07 for handoff to a Gemini-based coding agent.
**Audience:** The coding agent that will build the game, plus Christine as product owner.
**Scope of this document:** Product design, game rules, balance, rendering architecture, the volumetric cloud system, the Nano Banana asset pipeline, verification, and a milestone plan. No code is written here; every code-shaped block is a specification, not an implementation.

---

## 0. How to use this document (read first)

1. **Decisions vs. tunables.** Anything marked **DECISION** is fixed unless the product owner changes it. Anything in a *balance table* is a starting value and is expected to change during the tuning loop in Section 6. Tunables live in one config file (`src/config/balance.ts`), never scattered as literals.
2. **Assumptions are labeled.** Every place the original brief left a gap, or this plan departs from it, the fill-in is marked **ASSUMPTION** or **DECISION** and collected again in Section 15. The product owner should confirm or override those.
3. **Verification is part of the work.** Each milestone in Section 13 has acceptance tests. A milestone is not done until its tests run green and the "not verified" list is written down.
4. **Unverified facts are flagged.** Library versions, model IDs and prices were checked on 2026-09-07 from a container that could open the npm registry and unpack three.js 0.185.1, but could not open the Guerrilla, Google AI, DeepMind or threejs.org pages. Anything marked *(unverified)* must be re-checked by the agent before it is relied on.
5. **Reading order for the agent:** Sections 2, 5, 7, 8, 9 are the build spec. Sections 6, 10, 12 are the quality loop. Section 13 is the schedule. Appendices hold schemas, pseudocode and the review log.

---

## 1. Executive summary

Aegis Protocol is a portrait-orientation hybrid of a vertical shoot-'em-up and a real-time tower-defense game. The player flies the Aegis Cruiser along a corridor, dodging fire and collecting scrap from destroyed enemies, while boarding craft try to ram the hull and unload drones into the ship's interior. A slow-motion Tactical Mode lets the player spend scrap on turrets inside the deck.

This plan relocates the game from deep space to the **stratosphere**. The cruiser flies at roughly 20 km altitude above a sea of clouds, among storm towers whose tops punch up into the corridor. The clouds are real volumetrics rendered with a ray-marcher adapted from Guerrilla Games' Nubis system, the technique behind the skies in Horizon Zero Dawn and Horizon Forbidden West.

The technical stack is TypeScript, Vite and three.js 0.185.x using the WebGPU renderer with its WebGL 2 fallback, and three.js Shading Language (TSL) for shaders so one shader codebase runs on both backends. Textures, weather maps, decals and UI art are generated with Gemini's Nano Banana image models through a build-time script, never at runtime. Game logic runs headless in Node so the agent can balance the game by simulation instead of by hand-play.

Three scope tiers are defined (Section 2.4). **The recommended target is Basic.** The schedule in Section 13 assumes Basic and runs about five weeks of agent work from kickoff.

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
| Mobile low | 2020-era mid-range Android, iPhone 11 | 30 fps | 0.75 | Low: deck layer only, quarter-res march, every pixel every frame |
| Mobile high | 2023+ flagship phones | 60 fps | 0.85 | Medium: deck + towers, half-res march, 2×2 reprojection |
| Desktop | Any laptop with WebGPU or WebGL 2 | 60 fps | 1.0 | High: deck + towers, half-res march, 4×4 reprojection |

**DECISION:** Portrait 9:16 logical playfield on every device. On desktop the canvas fills the window and the cloudscape fills the extra width; the gameplay lane stays a centered 9:16 region. This is a benefit of going 3D: wide screens see more sky, not black bars.

Device classes above are design targets, not tested hardware. See Section 12.4 for the frame-time gates that decide the tier at runtime.

### 2.4 Scope tiers

| Tier | Contents | Use |
|---|---|---|
| **Bare** | Flight, skirmishers, scrap, one turret type (Point Defense), light boarders, deck graph, core, deck-layer clouds without towers or reprojection, HTML HUD, endless mode with a score. | Proves the loop. Playable in about twelve agent-days. |
| **Basic (recommended)** | Everything in Bare plus: Cryo Emitter, Artillery Battery, Lancer torpedo craft, heavy boarders, storm towers, temporal reprojection and depth-aware compositing, three quality tiers, audio, first-run hints, local high score, balance sim harness. | The game as described in the brief, in the stratosphere, shippable to GitHub Pages. |
| **Bonus** | Cloud-cover mechanic (Section 5.11), lightning inside storm towers, weather escalation with threat, boss boarding craft, gamepad, PWA install, ship shadow on the cloud tops, 2017-style in-scatter and out-scatter ambient. | Only after Basic is green and balanced. |

**ASSUMPTION:** Basic is the target. Section 13 is planned against it.

### 2.5 Success criteria for Basic
- A new player survives at least 90 seconds on their first run and understands why they died (death screen names the cause).
- Median survival of the scripted "competent" bot in the sim harness lands between 4 and 6 minutes (Section 6.6).
- Deaths split roughly evenly between Structural Collapse and Core Breach across bot runs, within 35/65 either way.
- Mobile-high tier holds 60 fps with clouds enabled on the owner's reference phone for 3 minutes of play; mobile-low holds 30 fps.
- First load under 4 MB transferred, excluding runtime-generated noise (Section 9.3).

---

## 3. Setting: space to stratosphere

**DECISION:** The setting moves from deep space to the stratosphere. This is the largest departure from the brief and it changes fiction and rendering only; every rule in the brief survives unchanged.

### 3.1 What changes and what does not

| Brief said | Plan says | Why |
|---|---|---|
| Scrolling starfield | Scrolling cloud deck 4 km below, storm towers rising past the corridor | The volumetric clouds are the visual identity |
| Space fighters | Jet-turbine skirmishers with contrails; boarders are armored "harpoon" craft | Contrails and exhaust read clearly against cloud tops |
| "Drift harmlessly into deep space" | Boarders that overshoot dive into the cloud deck and vanish | Same rule, better payoff shot |
| Energy projectiles | Kept, styled as hot plasma bolts | Bright bolts read well against white clouds |

### 3.2 Altitude and scale
**DECISION:** 1 flight unit (fu) = 10 m. The cruiser is 16 fu (160 m) long. The corridor is 100 fu (1 km) wide.

| Layer | Altitude | In fu | Notes |
|---|---|---|---|
| Flight camera | 21.65 km | 2165 | Above the tower tops in Flight Mode (Section 4.3) |
| Tower tops | 18.5–21.0 km | 1850–2100 | Stylized. Real overshooting tops reach about 18–20 km; we allow 21 km so towers cross the corridor. **ASSUMPTION** that the owner accepts this stylization. |
| Cruiser flight level | 20.0 km | 2000 | The "stratosphere" premise |
| Cloud deck top | 16.0 km | 1600 | 4 km below the ship |
| Cloud deck base | 12.5 km | 1250 | Sets the layer thickness for lighting; seen only through gaps |
| Cirrus veil | 24–26 km | 2400–2600 | Thin 2D textured dome, scrolls slowly |

The world is rendered in fu with a `metersPerUnit = 10` constant for physically motivated extinction values.

### 3.3 Sky and light
- The sky at 20 km is a deep blue-black overhead fading to a pale band at the horizon. Render it analytically as the scene's background node (Section 8.5): a three-stop vertical gradient (zenith, mid, horizon) above the horizon, a haze color below the horizon, plus a sun disc and a sun-glow term. No skybox texture is needed. The below-horizon branch is what shows through gaps in the deck.
- One directional sun. **DECISION:** Sun elevation 38°, azimuth 30° off the forward axis, so tower tops light from the upper left and cast long shading on the deck. Fixed for Basic; time-of-day is Bonus.
- Ships above the clouds receive no cloud shadow. Ship shadows on the cloud tops are Bonus.

### 3.4 Palette (portable to UI)
Sky zenith #0B1A3A, sky horizon #C9D8F0, sky below horizon (haze) #8FA3BF, cloud lit #FFF7EC, cloud shadow #7F8DA8, cruiser hull #3C4451 with #E7A23A accent, enemy accent #E8384F, scrap #55D6C2, cryo #7CC6FF, artillery #FFB347. These are tokens, declared once in `src/config/palette.ts`, and the HUD CSS reads the same values through CSS custom properties written from that file at build time.

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

Autocannons are never manually fired or aimed. **DECISION:** No fire button. This keeps one-thumb play honest.

### 4.3 Modes and the camera

| Mode | Time scale | Camera | Player can |
|---|---|---|---|
| Flight | 1.0 | Perspective chase camera 45 fu behind and 165 fu above the cruiser, pitched 68° down, vertical field of view 55°. | Move, toggle |
| Tactical | 0.2 | Blends over 0.35 s of real time to a near-top-down view 8 fu behind and 22 fu above the deck at 78° pitch, framing the whole deck with the bow at the top. The flight world stays visible around the edges, slowed. | Build, inspect, dismantle, toggle |

**Flight camera coverage (why these numbers):** the view spans 40.5° to 95.5° below horizontal. On the flight plane that is z from about −61 fu (behind the cruiser) to about +148 fu (ahead). At the cruiser the frame is about 100 fu wide, the full corridor width, and the cruiser sits about 62% of the way down the screen. Enemies spawn at z = 145, inside the visible top edge. A unit test must assert that the points (±42, −20) and (±50, 145) on the flight plane project inside the viewport at 9:16.

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

All units: fu = flight unit (10 m), du = deck unit (one deck grid cell, 0.5 fu), s = seconds of simulation time. Simulation time is scaled by the mode's time scale; the HUD shows real time.

### 5.1 Corridor and cruiser
- Corridor: x ∈ [−50, 50] fu, z ∈ [−35, 155] fu. Enemies spawn at z = 145. Objects are removed at z < −35 or |x| > 70.
- Cruiser rest position (0, 0). Movement bounds x ∈ [−42, 42], z ∈ [−20, 40].
- Cruiser dimensions for collision: capsule 16 fu long, 6 fu wide. Scrap magnet perimeter: 10 fu beyond the hull.
- Speed: lateral 55 fu/s, longitudinal 40 fu/s, acceleration 320 fu/s², deceleration 400 fu/s². Visual bank up to 25° proportional to lateral velocity.
- Hull integrity 100. No regeneration. **ASSUMPTION:** Hull repair is not in Basic; a repair drop is a Bonus candidate.

**DECISION:** The simulation is 2.5D. Everything moves in the y = 2000 fu plane and collision is 2D (circles against the cruiser capsule). Boarders and scrap have visual altitude offsets for drama, never gameplay ones. This keeps the rules identical to the brief and makes the sim harness cheap.

Collision radii (fu): plasma bolt 0.6, torpedo 1.0, artillery shell 0.8, skirmisher 2.5, Lancer 3.0, Grapple 3.0, Ram 4.5, scrap fragment 1.0.

### 5.2 Autocannons
Two forward barrels alternating, combined 10 rounds/s, 4 damage each, 160 fu/s, spread 1.5°, range to z = 155.

**DECISION (auto-aim):** The guns aim themselves at the nearest target inside a ±20° cone ahead of the cruiser, with priority torpedo > skirmisher > Lancer > boarder when several are in the cone; with nothing in the cone they fire straight ahead. Boarders are **armored**: autocannon rounds do 40% damage to them. Killing a boarder in flight is therefore possible only when the corridor is otherwise clear, which is the reward for clearing it.

Why: a fixed-forward gun would leave every balance number below undefined, and an unrestricted auto-aim would kill every boarder before contact (a Grapple at full damage dies in 1.2 s of fire, and it takes 3.2 s to arrive). With armor, an undisturbed Grapple needs 2.8 s of undivided fire and a Ram 6.9 s.

### 5.3 Enemies

| Enemy | HP | Speed (fu/s) | Behavior | Attack | Hull damage on collision | Scrap drop |
|---|---|---|---|---|---|---|
| Skirmisher | 12 | 30 down the corridor | Spawns in formations of 4–8 (templates below), holds formation shape; the formation center weaves with amplitude 12 fu, period 2.5 s | Plasma bolt every 1.6 s per craft, aimed at the cruiser at fire time, 70 fu/s, 6 damage | 20; skirmisher destroyed, its scrap drops at the hull and is collected at once | 3 |
| Lancer | 20 | 24 down to z ≈ 90, holds for 20 s strafing ±20 fu, then resumes descent at 24 fu/s | Spawns in pairs from threat level 2; at most 2 pairs alive; a new pair spawns only when fewer than 3 Lancers are alive | Torpedo every 4 s: 35 fu/s, weak homing (turn 20°/s), 18 damage, 6 HP so guns can kill it | 20 | 5 |
| Grapple (light boarder) | 45 | 45, straight at the cruiser, turn rate 35°/s | Spawns alone at a random x, from threat level 0 | None. On hull contact: 8 hull damage, clamps to the matching breach point, deploys 2 waves × 4 Strike drones, then detaches and is removed | Boarding | 6 if killed in flight |
| Ram (heavy boarder) | 110 | 28, turn rate 20°/s | From threat level 3 | On contact: 15 hull damage, clamps, deploys 3 waves × 5 Assault drones, then detaches and is removed | Boarding | 12 if killed in flight |

**Formation templates:** V (up to 8, two wings), line (up to 6 abreast), column (up to 8 in file). Spacing 6 fu. The formation center spawns at x uniform in [−25, 25]. The first formation spawns at t = 3 s.

**ASSUMPTION:** The brief mentions torpedoes only inside the Point Defense description. The Lancer is added so torpedoes exist. If the owner prefers, the Lancer can be removed and Point Defense loses its outward mode.

**Evasion math (why boarders are dodgeable):** turn radius r = v / ω. Grapple: 45 fu/s ÷ 0.611 rad/s = 74 fu. Ram: 28 ÷ 0.349 = 80 fu. If the cruiser sidesteps 25 fu when a Grapple is 40 fu away, the Grapple arrives in 0.89 s, can turn 31°, and shifts laterally only r(1 − cos 31°) = 10.6 fu; it misses by about 14 fu minus the two radii, so it passes. The Ram arrives in 1.43 s, turns 28.6°, shifts 9.8 fu, and also passes. Sidestepping early, at 80 fu, gives a Grapple 1.78 s and 62° of turn, a 39 fu shift, and it re-aims. The tension is the timing.

### 5.4 Scrap
- Fragments spawn at the kill position with a random spread, drift down the corridor at 20 fu/s with mild lateral jitter, and expire at z < −35 or after 8 s, whichever comes first.
- When a fragment's center enters the magnet perimeter, it accelerates toward the hull at 90 fu/s² and is collected on contact. Each fragment is worth 1 scrap.
- **DECISION:** Scrap is never lost on damage. The only loss is letting fragments fall past.

### 5.5 Deck, breaches and drones
- The deck is a hand-authored graph in `assets/deck/aegis-deck.json` (schema in Appendix A) on a 12 × 32 cell grid at 0.5 fu per cell, matching the 6 × 16 fu hull. It has 5 breach points: bow, port-fore, port-aft, starboard-fore, starboard-aft. All paths lead to the core node at the stern.
- **DECISION (no single chokepoint):** the core is fed by three distinct final edges, one from the bow route and one from each side, and no shared edge on the way to the core is longer than 3 du. No turret slot sits within 6 du of the core. One turret cannot cover every route; the deck needs at least three covered points, which is what makes the deck front cost scrap.
- Path lengths: bow → core 40 du, fore flanks → core 28 du, aft flanks → core 18 du.
- Breach matching: a boarder's impact point is the hull point nearest its center at contact, expressed as a fraction of hull length (0 = stern, 1 = bow) and a side. Bow breach: [0.85, 1.0]. Fore flanks: [0.55, 0.85]. Aft flanks: [0, 0.55]. Aft hits happen when a late sidestep lets a boarder clip the flank behind the midpoint.
- Breaches are not exclusive. At most 3 boarders may be clamped at once; a fourth deals its hull damage and is removed without boarding. Clamped boarders are invulnerable and do not collide. The first wave deploys 1.5 s after clamping; later waves follow at the craft's wave gap (Grapple 4 s, Ram 6 s). Drones in a wave spawn 0.5 du apart along the first edge from the breach. Detaching is cosmetic and does no damage.
- 30 turret slots on bulkheads flanking the paths. Each slot has a `mount` tag: `center`, `flank-port` or `flank-starboard`, used by Artillery arcs.
- Drones path along the graph by precomputed shortest path to the core (the graph is static, so Dijkstra runs once at load). They never retarget.

| Drone | HP | Speed (du/s) | Core damage on arrival |
|---|---|---|---|
| Strike | 10 | 4.0 | 10 |
| Assault | 32 | 2.2 | 25 |

- Core integrity 100. A drone that reaches the core deals its damage and is destroyed.
- Time-to-core, unopposed: Strike from bow 10 s, from fore flank 7 s, from aft flank 4.5 s. Assault from bow 18.2 s, from aft flank 8.2 s. In Tactical Mode those become 50, 35, 22.5, 91 and 41 s of real time, which is the window the player has to react.

### 5.6 Turrets

| Turret | Cost | Refund | Range | Fire | Damage | Notes |
|---|---|---|---|---|---|---|
| Point Defense Battery | 25 | 12 | 4.5 du along the graph | 10 rounds/s | 3 | Kills a Strike drone in 0.33 s, an Assault in 1.07 s. Torpedo mode below. |
| Cryo Emitter | 35 | 17 | 6 du along the graph | 1 round / 5 s | 0 | Round lands instantly and detonates into a stasis field: radius 2.5 du along the graph, lasts 4 s, slows drones by 65%. Fields do not stack; the strongest applies. |
| Artillery Battery | 60 | 30 | Flight corridor | 1 shell / 2.5 s | 24 in a 7 fu splash | Ignores the deck. Shell speed 70 fu/s. Arcs below. |

**Point Defense targeting.** In drone mode it fires at the in-range drone closest to the core, with no reset. With no drone in range it enters torpedo mode: it picks the torpedo within 40 fu of the cruiser whose projected hull impact is earliest (the brief's "predictive tracking"), destroys it instantly, then resets for 1.5 s before the next intercept. The reset is per battery. A salvo of three torpedoes therefore needs three batteries or the autocannons' help.

**Cryo targeting.** Fires at the center of the largest drone cluster in range, and only when at least 2 drones are within 3 du of each other.

**Artillery arcs and targeting. DECISION:** `center` mounts traverse ±15° around straight ahead; `flank-port` and `flank-starboard` mounts traverse from 15° to 60° outward on their side. This keeps the brief's mounting-based spread while giving each gun something to hit. Priority inside the arc: boarder > Lancer > skirmisher. Shells lead their target using shell speed and enemy velocity, damage every flight-space enemy in the splash including torpedoes, and never hit clamped boarders. A center gun kills a Skirmisher per direct hit and often clips 2–3 in a formation; flank guns are the answer to boarders and Lancers coming in wide.

**Why these numbers:** one Point Defense sees a Strike wave (4 drones, 40 HP total, at 4 du/s crossing a 9 du diameter) for 2.25 s and can deal 67.5 damage, so it handles a light wave with a 1.7× margin. An Assault wave (5 drones, 160 HP, at 2.2 du/s) is in range for 4.1 s, worth 123 damage, so it needs a second battery or a Cryo field. A Cryo field slows drones for 4 s out of every 5 across 5 du of the battery's 9 du window, which in practice stretches exposure by about 1.7×, enough for one battery plus one emitter to beat one Assault wave. With three routes into the core, that arithmetic repeats three times. Layering is required by the numbers, not by hope.

### 5.7 Tactical Mode economics
Placement is instant. Dismantle refunds 50%, rounded down. **DECISION:** the brief's "partial refund" is 50%. Turrets cannot be moved; dismantle and rebuild is the move. **DECISION:** No upgrades in Basic.

### 5.8 Escalation
Threat level L is a real number: `L = max(scrapCollected / 40, elapsedSimSeconds / 45)`. **DECISION:** the time term is a floor so that refusing scrap never freezes difficulty (L = 4 after 3 minutes with no scrap at all); the scrap term is the intended driver and outpaces the floor for anyone actually playing.

| Threat L | Formation every | Formation size | Boarder every | Heavy share | Lancer pairs every |
|---|---|---|---|---|---|
| 0 | 7.0 s | 4 | 22 s | 0% | none |
| 2 | 6.3 s | 5 | 19.6 s | 0% | 24.3 s |
| 4 | 5.6 s | 6 | 17.2 s | 30% | 19.7 s |
| 6 | 4.9 s | 7 | 14.8 s | 40% | 15.9 s |
| 8 | 4.2 s | 8 | 12.4 s | 50% | 12.9 s |
| 12 | 2.8 s | 8 | 7.6 s | 50% | 8.5 s |
| 16 | 2.5 s (floor) | 8 | 6 s (floor) | 50% | 8 s (floor) |

Formulas: formation interval `clamp(7 − 0.35 L, 2.5, 7)` (floor reached near L = 13); size `min(8, 4 + floor(L / 2))`; boarder interval `clamp(22 − 1.2 L, 6, 22)` (floor near L = 13); heavy share `clamp(0.05 L + 0.1, 0, 0.5)` applied from L ≥ 3 (25% at L = 3); Lancer pair interval `clamp(30 × 0.9^L, 8, 30)` from L ≥ 2. The unit test in Section 12.1 checks every table row against these formulas. Spawns use a seeded RNG (Section 7.4).

**Pressure check at L = 8:** 8 skirmishers × 12 HP every 4.2 s is 23 HP/s of incoming health. Autocannons deliver 40 damage/s at 100% accuracy and about 28 at a realistic 70% with auto-aim. The player is barely ahead without Artillery, which is the intended moment Artillery earns its cost.

### 5.9 Score
**ASSUMPTION:** Score = scrap collected + 25 per boarder made to overshoot. Kills do not score, so scrap has no negative marginal value once the deck is built: every fragment is both progress and pressure. Best score and best time persist in `localStorage`.

### 5.10 Defeat
Defeat when hull ≤ 0 (Structural Collapse) or core ≤ 0 (Core Breach). **ASSUMPTION:** Endless survival, no win state, no waves between which the game pauses.

### 5.11 Bonus mechanic: cloud cover (not in Basic)
Flying the cruiser inside a storm tower breaks skirmisher line of sight (they hold fire) and slows scrap magnetism by half. Icing deals 1 hull per second after 3 s inside. This turns the volumetrics into a tactical resource. It is excluded from Basic because it complicates the sim bot and the readability rules.

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
| Starve scrap to keep threat low | Escalation is scrap-driven | Time floor on L reaches 4 by 3 minutes; score is scrap, so starving scores nothing |
| Camp in Tactical Mode | Slow-mo makes dodging trivial | Cruiser cannot move in Tactical; bolts still land |
| Build only Point Defense | Cheapest, kills everything | Assault waves out-tank a single battery; torpedo reset limits intercepts; three routes need three batteries |
| One turret at the core | Every path ends there | No slot within 6 du of the core; three separate final edges |
| Sit at the bottom of the corridor | Maximum reaction time | Scrap expires before reaching the bottom; boarders get more time to re-aim |
| Dismantle-and-rebuild to reposition every wave | Free flexibility | 50% refund tax |

### 6.4 Sim harness specification
- Location: `sim/`. Imports `src/game/**` only; must not import anything from `src/render/**` or the DOM.
- Bots: `dodger` (moves perpendicular to the nearest threat's velocity; steers toward scrap within 25 fu when no bolt is within 15 fu; enters Tactical on a boarding and builds Point Defense on the boarded route, then Cryo, then Artillery on a center mount), `greedy` (chases scrap, dodges only bolts within 15 fu), `builder` (enters Tactical on every boarding and builds by a fixed priority list), `idle` (control).
- Each run: seed, bot, config hash → survival time, cause of death, scrap collected, scrap spent, threat at death, per-minute damage sources, per-turret kills, boarders overshot.
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

### 7.1 Stack (versions checked 2026-09-07 against the npm registry unless noted)

| Piece | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, `strict: true` | |
| Build | Vite 8.x (8.2.2 on the registry today) | Static output, deploys to GitHub Pages |
| Renderer | three.js 0.185.1 (`three` on npm) with `WebGPURenderer` and its WebGL 2 backend | Section 8.2 has the decision gate |
| Shaders | TSL (three.js Shading Language) node functions | One source compiles to WGSL and GLSL |
| Post-processing | three.js `PostProcessing` with `pass()` nodes | Bloom, ACES tone mapping, vignette |
| Audio | Web Audio API with the ZzFX micro-synth for SFX *(library version unverified)* | Nano Banana cannot make audio; SFX is procedural. Music is Bonus. |
| Tests | Vitest for unit and sim; Playwright for browser smoke and screenshots | |
| Lint | ESLint + Prettier | |
| Dev tools | `lil-gui` tuning panel behind `?dev=1`, `stats-gl` frame meter | Not shipped in production |
| Image generation | `@google/genai` Node SDK (2.21.x on the registry today), build-time only | Section 10 |

**DECISION:** No physics engine, no React, no state library. The game is small enough that a hand-written entity list and a fixed-step loop are simpler and faster to reason about.

### 7.2 Repository layout

```
aegis-protocol/
  index.html
  src/
    main.ts                 boot, quality probe, loading screen
    config/                 balance.ts, palette.ts, quality.ts, clouds.ts
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
      clouds/               Section 9: noise.worker.ts, noise.ts, weather.ts, cloudPass.ts, reproject.ts
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
`localStorage` keys: `aegis.best`, `aegis.settings` (quality tier, audio volume, hints seen). IndexedDB holds the generated noise textures (Section 9.3). No backend, no accounts, no analytics.

### 7.8 Security and privacy invariants (do not regress)
- No API key in the shipped bundle. Nano Banana runs only in `tools/` with a key from a local `.env` that is git-ignored.
- No network calls at runtime other than fetching the game's own static assets.
- No personal data collected. `localStorage` holds settings and scores only.
- CI gate on every pull request: typecheck, lint, unit tests, sim smoke (10 seeds per bot), Playwright smoke on the WebGL 2 backend.

---

## 8. Rendering pipeline

### 8.1 Frame order

1. **Sim interpolation** writes transforms for ships, bolts, scrap, drones.
2. **Opaque scene pass** to an offscreen target via `pass(scene, camera)`: cruiser, deck (in Tactical), enemies, scrap. The analytic sky is the scene's `backgroundNode`, so it lands in the same color target where depth is far. Depth is read later through the pass node (Section 8.5).
3. **Cloud pass** at reduced resolution (Section 9.6), reading the opaque depth so towers correctly occlude and are occluded by ships. Outputs two targets: color and total transmittance, and a data target with cloud depth, transmittance to the flight plane, and the scene depth it used (Section 9.7).
4. **Temporal reprojection** of the cloud targets (Medium and High only).
5. **Bilateral upsample** of the cloud targets to full resolution using the full-resolution scene depth against the scene depth each cloud sample used.
6. **Composite**: `scene = clouds.rgb + scene.rgb × clouds.T_total`. Ships are opaque and write depth, so a ship above the deck stops the march and keeps `T_total = 1` on its pixels.
7. **Transparent FX**: bolts, contrails, explosions, cryo fields, drawn after the composite with depth test on and depth write off, each multiplied by `T_ship` sampled from the upsampled data target. `T_ship` is the transmittance from the camera to the flight plane only, so a bolt above the deck is never darkened by the deck and a bolt inside a tower is fogged correctly.
8. **Post**: bloom (threshold 1.0, small radius), ACES tone mapping, vignette, optional film grain at low intensity.
9. **HUD** in the DOM on top.

### 8.2 WebGPU versus WebGL 2: the decision gate
**DECISION:** Build on `WebGPURenderer` with TSL. It runs on WebGPU where available and falls back to a WebGL 2 backend from the same shader source.

What the 0.185.1 source already shows (checked by unpacking the package): `Loop`, `Break` and `Continue` nodes, `texture3D` sampling that compiles to `sampler3D` on the GLSL builder, `Data3DTexture` upload, depth textures, and render-target ping-pong all exist on both backends, and the official `webgpu_volume_cloud` example uses exactly `texture3D`, `Loop`, `Break` and `Data3DTexture`. The risk is therefore small, and the gate is a half-day check, not a two-day spike.

**Gate (Milestone 0):** prove on both backends, with `forceWebGL: true` for the second, that a TSL fragment node can (a) loop a variable number of times with early exit, (b) sample a 3D texture with trilinear filtering and explicit mip level, (c) read the scene depth through `pass().getTextureNode('depth')` and `getViewZNode()`, (d) ping-pong between two float render targets, and (e) report whether `generateMipmaps` works on a `Data3DTexture`. If (a)–(d) fail on WebGL 2 and cannot be fixed in one agent-day, **Plan B** is `WebGLRenderer` with GLSL `ShaderMaterial` for the cloud pass only. Record the result and the answer to (e) in `docs/DEV_LOG.md`.

Search results on 2026-09-07 report that Safari 26 on iOS 26 ships WebGPU by default *(unverified against Apple's own notes)*; older iOS falls to the WebGL 2 backend.

### 8.3 Quality tiers

| Tier | Resolution scale | Cloud buffer | Near steps | Far steps | Light steps | Reprojection | Towers | Bloom |
|---|---|---|---|---|---|---|---|---|
| Low | 0.75 | 1/4 res | 32 | 0 | 4 | none: every pixel every frame, fixed per-pixel blue-noise offset, no temporal blend | off | off |
| Medium | 0.85 | 1/2 res | 48 | 16 | 5 | 2×2 (1/4 of pixels per frame) | on | on |
| High | 1.0 | 1/2 res | 64 | 32 | 6 | 4×4 (1/16 per frame) | on | on |

Step counts are budgets; step lengths are derived from them (Section 9.6). Each tier is a separate compiled cloud material with its counts and tower flag baked in as constants, kept in a lazily built map so switching tiers does not recompile on the render thread more than once per tier.

Tier selection: start at Medium; after 3 seconds of play, if the 95th-percentile frame time exceeds the target budget (33.3 ms at 30 fps for Low, 16.7 ms otherwise) drop one tier; if it sits under 60% of budget for 20 seconds, raise one tier, at most once per session. The first second after any tier change is excluded from the histogram, because the material swap causes a one-off hitch. Persist the result.

### 8.4 Frame budget at Medium on mobile high (target 16.7 ms)

| Pass | Budget |
|---|---|
| Sim + interpolation (CPU) | 2.0 ms |
| Opaque + FX | 3.5 ms |
| Cloud march | 6.0 ms |
| Reproject + upsample + composite | 1.5 ms |
| Post | 1.5 ms |
| Headroom | 2.2 ms |

These are budgets to design against, not measurements. The cloud budget is the optimistic one: at Medium roughly 150 k fresh rays × 48 steps × up to 8 texture fetches is at the edge of a 2023 phone's 3D-texture throughput *(estimate, unverified)*. Mitigations the agent should build in from the start: evaluate the light function every second fine step and reuse it, cap lit steps at 24 per ray, and keep the Medium resolution scale at 0.85. Section 12.4 says how to measure.

### 8.5 Renderer specifics the agent must follow
- `await renderer.init()` before the first frame. Detect the backend with `renderer.backend.isWebGPUBackend` and log it to the dev panel.
- Scene depth for the cloud pass: `scenePass = pass(scene, camera)`; depth via `scenePass.getTextureNode('depth')`, view-space Z via `scenePass.getViewZNode()`. Ray end distance is `t_scene = −viewZ / dot(rayDir, cameraForward)`. Never hand-roll depth linearization: WebGPU uses [0, 1] clip depth and WebGL [−1, 1], and the three.js helpers branch on `renderer.coordinateSystem`.
- Sky: `scene.backgroundNode` is a TSL function of `positionViewDirection` returning the gradient above the horizon and the haze token below it.
- 3D textures: `Data3DTexture` defaults to nearest filtering and clamped `wrapR`. Set `minFilter = magFilter = LinearFilter`, `wrapS = wrapT = wrapR = RepeatWrapping`, `RGBAFormat`, `UnsignedByteType`, `needsUpdate = true`. Sample inside the march with an explicit level (`texture3D(tex, uvw).level(lod)`) because derivatives are undefined after a data-dependent break in a loop.
- Float render targets on the WebGL 2 backend require `EXT_color_buffer_float`; check for it at boot and fall back to Low tier without reprojection if it is missing.

### 8.6 Ships and deck as procedural meshes
Nano Banana makes images, not meshes, so ships are built in code from primitives (boxes, cylinders, lathe and extrude geometries) by factory functions in `src/render/ships/`. Each factory takes a seed and a palette and returns a single merged `BufferGeometry` with UVs laid out so the generated hull and panel textures tile sensibly. Enemies use `InstancedMesh` per type. The deck is one mesh: floor plane, bulkhead extrusions from the graph, breach hatches, core housing, with a cutaway roof that is simply not rendered.

**Alternative, flagged:** CC0 kitbash packs (for example the Kenney space kits) would look better faster. *Not verified from this session and no URL is given for that reason.* Procedural is the default because it is deterministic and needs no downloads.

---

## 9. Volumetric clouds: the Nubis adaptation

### 9.1 What we take from the papers
The system follows the published Guerrilla work. The agent must read the primary sources (Section 16) before implementing; the table is what this plan commits to, and the pseudocode below was checked against recollection of the papers, not fresh reads, so the agent verifies each formula against the slides.

| Source | What we take |
|---|---|
| Schneider & Vos, SIGGRAPH 2015, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" | Weather map (coverage, type) driving density; low-frequency Perlin-Worley 3D noise for base shapes and high-frequency Worley for erosion; height gradients per cloud type; curl noise to distort edges; Beer's law with a cone of light samples; Henyey-Greenstein phase; the "powder" darkening as a function of light-path optical depth; adaptive step size; reprojection against the cloud layer, updating a subset of pixels per frame |
| Schneider & Vos, SIGGRAPH 2017, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" | Cloud "dimensional profile" replacing hard-coded height gradients; the multiple-scattering octave approximation (Wrenninge et al. 2013, adopted by Nubis) with attenuation, contribution and eccentricity attenuation; authoring by cloud type. The 2017 in-scatter and out-scatter ambient probabilities are Bonus, not Basic. |
| Schneider, SIGGRAPH 2022, "Nubis, Evolved" | Temporal upscaling for fast-moving clouds; internal lighting and lightning flashes (Bonus); the idea that near clouds can be modeled as explicit volumes rather than by weather map alone |
| Schneider, SIGGRAPH 2023, "Nubis³" | Voxel-based near clouds with a distance-field acceleration structure. **DECISION:** Not adopted for Basic. Our towers stay weather-map driven with a tall cumulonimbus profile, because a voxel pipeline is a second modeling system and the agent has no authoring tool. Revisit in Bonus if tower silhouettes are unsatisfying. |

Not from Guerrilla: the dual-lobe phase function below follows the Frostbite lineage (Hillaire 2016) and is used because a single forward lobe looks flat from above.

### 9.2 Cloud domains
Two domains are marched in the same pass with one code path and different parameters:

| Domain | Vertical extent (fu) | Role | Density scale |
|---|---|---|---|
| Deck | 1250 → 1600 | The sea of clouds below the ship. Stratocumulus, high coverage (0.55–0.8), rolling tops, haze visible through the gaps. | Base |
| Towers | 1250 → 2100 | Cumulonimbus columns rising through the deck and past the corridor. Placed by the weather map's type channel. Their height fraction is computed over the tower extent, so the profile gives them a flat-ish anvil near the top. | Base × 1.6 |

The slab that is marched is `[1250, slabTop]` with `slabTop = towersEnabled ? 2100 : 1600`. Where the type channel is below 0.6 the tower term is zero and only the deck contributes, so the extra height costs nothing on most rays where towers are on, and nothing at all at Low tier. Coverage near the corridor is authored so tower footprints keep at least 60% of the corridor width open (Section 4.5).

### 9.3 Data and where it comes from

| Texture | Size | Channels | Source |
|---|---|---|---|
| Low-frequency noise | 128³ RGBA8 (64³ at Low tier) | R = Perlin-Worley, G/B/A = Worley at 2×, 4×, 8× frequency | Generated on first load and cached in IndexedDB. About 8 MB uncompressed, which is why it is not downloaded. |
| High-frequency noise | 32³ RGB8 | Worley at 3 frequencies | Same generator |
| Curl noise | 128² RGB8 | Curl of a Perlin field | Same generator |
| Weather map | 512² RGBA8 | R coverage, G cloud type (0 stratus, 0.5 cumulus, 1 cumulonimbus tower), B wetness (darkens bases), A unused | **Nano Banana**: prompted as a top-down grayscale "satellite coverage map", then normalized and channel-packed by the pipeline (Section 10). One map per weather preset; Basic ships 3 presets. The map repeats every `weatherExtentFu = 8192` fu, so one texel is 16 fu. |
| Dimensional profile | 64 × 32 R8 | Density envelope by (type, height fraction) | Authored as a small function in `tools/` and baked to a texture. Stratus: dense low, cut off by 0.35. Cumulus: peak at 0.35, taper to 0.85. Cumulonimbus: full column to 0.85 then widen to an anvil, cut at 1.0. |
| Blue noise | 64² R8 | Per-pixel step offset and reprojection dither | Generated by void-and-cluster in `tools/` |

**Noise generation plan.** On WebGPU, generate with a compute shader into a `Storage3DTexture` in well under a second. On the WebGL 2 backend, generate in Web Workers: Vite's `new Worker(new URL('./noise.worker.ts', import.meta.url), { type: 'module' })`, slices split across `navigator.hardwareConcurrency` workers, each returning its `ArrayBuffer` by transfer (`postMessage(buf, [buf])`). Cache the result in IndexedDB under a key that hashes the generator source and a version number, so a changed generator never reads stale data across deploys; Safari can evict IndexedDB after 7 days of disuse, so a cache miss must silently regenerate. The generation time on a low phone is unknown and must be measured at M3; the loading screen plays the title sky, which is analytic and needs no noise. The same generator runs in `tools/gen-noise.mts` for golden tests.

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
  return d * densityScale(isTower)
```

`remap(v, l0, h0, l1, h1) = l1 + (v − l0) × (h1 − l1) / (h0 − l0)`, clamped to [l1, h1]. `weatherScale = 1 / weatherExtentFu`. Wetness does not touch density; it darkens in the light function. Wind: the deck scrolls toward −z at the apparent speed of the cruiser (a design constant of 12 fu/s, because the ship is not really moving in the sim) plus a slow lateral drift, both in simulation time. Towers scroll with the same offset so they pass the ship like landmarks; a tower footprint of 20–30 weather texels (320–480 fu) crosses the corridor in about 30 s.

### 9.5 Lighting (per sample with density > 0)

```
light(p, d, cosTheta, hf, wetness):
  // Cone of light samples toward the sun (2015). Five samples at t_i = i * lightStep
  // (i = 1..5, lightStep starts at 6 fu), each offset by blueNoiseDir_i * coneRadius * t_i
  // with coneRadius = 0.3, plus one far sample at t = 15 * lightStep with no offset.
  // All six use COARSE density. Once the running sum passes 0.3, the remaining cone
  // samples also use COARSE (the 2015 shortcut).
  dl = Σ_{i=1..5} density(p + sunDir * t_i + cone_i, COARSE) * lightStep
     + density(p + sunDir * 15 * lightStep, COARSE) * 10 * lightStep
  // Multiple-scattering octave approximation (Wrenninge 2013, as used in Nubis 2017):
  // contribution b scales each octave, attenuation a scales its optical depth,
  // eccentricity attenuation c scales its phase eccentricity. N = 3, a = b = c = 0.5.
  // The agent must confirm the a/b energy constraint from the 2017 slides before tuning.
  scatter = Σ_{i<3} b^i * exp(-dl * sigma * a^i) * phase(cosTheta, g * c^i)
  phase(cos, g) = mix(HG(cos, g), HG(cos, -0.15), 0.3)          // dual lobe (Hillaire lineage)
  powder  = 1 - exp(-2 * dl * sigma)                             // 2015 powder, on light-path depth
  sun     = sunColor * scatter * mix(1, powder, powderStrength)
  ambient = mix(ambientBottom, ambientTop, hf) * exp(-dl * ambientDepthFalloff)
  return (sun + ambient) * mix(1, 0.7, wetness * (1 - hf))       // wet bases are darker
```

`sigma` (extinction per fu of density 1) starts at 0.9 and is tuned by look. `g` starts at 0.6. Clouds are treated as albedo 1, so the in-scatter term uses the same `sigma`. All of these live in `src/config/clouds.ts` and are exposed to the dev panel.

### 9.6 Ray march
- One ray per cloud-buffer pixel. Ray bounds: `t0 = 0` if the camera is inside the slab, else the distance to the slab top plane; `t1 = min(distance to the slab base plane, t_scene)`; discard the pixel if `t1 ≤ t0`. In Flight Mode the camera (2165 fu) is above the slab, so rays start at the top plane; in Tactical Mode the camera (about 2022 fu) is inside the tower slab and rays start at the camera. Tower density is faded to zero within 10 fu of the camera to avoid a full-screen wall on the mode blend.
- Two ranges with **step budgets** from the tier table. Near range: from `t0` to `t0 + nearRangeFu` (700 fu), stepped uniformly with `nearStep = nearRangeFu / nearSteps`. Far range: from there to `farRangeFu` (2500 fu from the camera), stepped by a geometric series that reaches `farRangeFu` in `farSteps`. Beyond `farRangeFu` the color blends to the haze token. There are no other step-length literals; changing quality means changing the budgets.
- Adaptive stepping (2015): march at 3× the range's step while sampling `COARSE` density; on the first non-zero sample, step back one coarse step and switch to fine stepping with full detail; after 8 consecutive zero fine samples, return to coarse.
- Front-to-back integration, exact for constant lighting over a step at albedo 1:

```
T = 1; C = 0; depthSum = 0
for each step of length s:
  d = density(p, lod)
  if d > 0:
    L        = light(p, d, cosTheta, hf, wetness)
    Tstep    = exp(-d * sigma * s)
    C       += T * L * (1 - Tstep)
    depthSum += T * (1 - Tstep) * t          // transmittance-weighted distance
    T       *= Tstep
    if p.y crosses the flight plane (2000): T_ship = T
    if T < 0.01: break
  p += dir * s; t += s
cloudDepth = (1 - T) > 0.05 ? depthSum / (1 - T) : t1
output RT0 = (C.rgb, T_total = T); RT1 = (cloudDepth, T_ship, usedSceneDepth, 0)
```

- `T_ship` defaults to 1 and is set once when the march passes the flight plane; a ray that starts below the plane (never, in Flight) keeps 1.
- Per-pixel blue-noise jitter of the first step length. At Medium and High it changes per frame so temporal accumulation converges; at Low it is fixed per pixel so the image is stable without history.

### 9.7 Temporal reprojection and upsampling
- Render targets: RT0 is RGBA16F (color, total transmittance); RT1 is RGBA32F (cloud depth in fu, `T_ship`, the point-sampled scene depth this pixel used, unused).
- At Medium and High only a Bayer-ordered subset of cloud pixels (1/4 or 1/16) is freshly marched each frame; the rest are reprojected from the previous frame's RT0/RT1 using the previous view-projection matrix and the previous **cloud depth**, never the scene depth (scene depth is the far plane on almost every cloud pixel, so it would only ever encode rotation, and the cruiser translates at 55 fu/s over a deck 400 fu below).
- Reprojection validity: reject the history sample if it falls outside the previous frame, if the reprojected cloud depth differs from the freshly marched neighbor's by more than 5%, or during the first 4 frames of a mode camera blend. Rejected pixels fall back to the nearest freshly marched neighbor for that frame.
- On the Flight ⇄ Tactical camera blend, force a 4-frame full refresh: every cloud pixel marched at half the tier's step budgets. That costs about 1.5 frames of cloud budget across the transition and happens rarely.
- Upsampling to full resolution is bilateral: weights compare the full-resolution scene depth with the scene depth each low-res sample used (RT1's third channel), so cloud edges do not bleed onto ships.

### 9.8 Stratosphere-specific adaptations (not in the papers)
- The camera looks **down** at the deck rather than up at a sky. Slab entry is the top plane in Flight; far rays near the top of the screen are long and shallow, which the far-range geometric steps handle.
- The camera is **inside** the tower slab in Tactical Mode only (Section 9.6 bounds and the near-camera fade cover it).
- Ships **inside** towers: depth-aware compositing handles occlusion; FX read `T_ship` so bolts fade correctly and are never darkened by the deck below them.
- The deck and towers scroll with simulation time. In Tactical Mode they slow with everything else, which reads as intentional.
- Gaps in the deck show the haze color from the sky's below-horizon branch, not black.

### 9.9 Verification for the cloud system
- Golden-image test: fixed seed, fixed camera, fixed sun, compared to committed PNGs with a perceptual threshold (SSIM ≥ 0.97). CI runs the WebGL 2 backend under Playwright Chromium; the WebGPU golden is a local job on the owner's machine, because headless Chromium in a container has no GPU and its WebGPU flags are *(unverified)*.
- Energy sanity: with coverage 1 and sun overhead, `T_total` through the deck must be below 0.02, and no pixel may exceed the sun color's luminance × 1.2 before bloom. With the exact integrator in Section 9.6 this holds by construction at any step length; the test guards regressions.
- Reprojection sanity: translate the camera 2 fu per frame for 60 frames; the mean absolute difference between reprojected and freshly marched full-frame output must stay under 4/255.
- Performance: three.js exposes whole-frame GPU time (`trackTimestamp: true`, `resolveTimestampsAsync()`, `renderer.info.render.timestamp`), not per pass. Per-pass numbers come from ablation: toggle one pass and difference the frame time. Record per tier in `docs/DEV_LOG.md`.

---

## 10. Asset pipeline with Nano Banana

### 10.1 Principles
- **Build-time only.** `tools/gen-assets.mts` calls the Gemini API, post-processes, and writes to `assets/generated/` with a `manifest.json` entry per asset: prompt, model ID, seed if the API honors one *(unverified)*, date, SHA-256 of the output, and license note. Outputs are committed. The game never calls the API.
- **Reproducible in spirit, not bit-exact.** Image models are not deterministic across versions. The manifest lets the agent regenerate and compare, not reproduce.
- **Every generated image passes a check** before it is accepted: tileability seam score, size, channel packing, and a visual thumbnail sheet committed for the owner's review.

### 10.2 Model choice
Searches on 2026-09-07 returned these Nano Banana model IDs: `gemini-2.5-flash-image` (original), `gemini-3-pro-image-preview` or `gemini-3-pro-image` (pro), `gemini-3.1-flash-image-preview` or `gemini-3.1-flash-image` (Nano Banana 2), and a `gemini-3.1-flash-lite-image`. *(All from third-party pages; the official docs page could not be opened, and the `-preview` suffixes may have been dropped.)* **DECISION:** The script takes the model ID as a flag; default to the newest Flash Image model the docs list when the agent starts, with `gemini-2.5-flash-image` as the fallback; record the exact ID used in the manifest. Price figures found were third-party (roughly $0.03–0.24 per image by model and resolution) and are *unverified*; budget the whole pipeline at about 120 images, so under $30 even at the high end.

### 10.3 What to generate, and how each is post-processed

| Asset | Count | Prompt intent | Post-processing |
|---|---|---|---|
| Hull panel albedo (cruiser) | 3 variants | Seamless tileable painted steel aircraft panels, rivets, faint wear, overcast lighting, flat, no perspective | Seam check; offset-and-blend if it fails; roughness from inverted luminance; normal map from height (10.5) |
| Enemy hull albedo | 2 | Darker composite plating with red warning stripes | Same |
| Deck floor, bulkhead, core housing | 3 | Top-down industrial deck plating, grated walkways, glowing reactor housing | Same, plus an emissive mask keyed from the brightest hue |
| Weather maps | 3 presets | Top-down satellite-style grayscale cloud coverage, soft blobs, a few dense circular cells for storms | Normalize to [0,1]; coverage from luminance; type from a thresholded blur of the densest cells; wetness from a wide blur; pack RGBA |
| Cirrus veil | 1 | Very thin, streaky, high-altitude cirrus on black, seamless | Luminance to alpha; tile |
| Turret sprites for radial menu | 3 | Clean top-down icon on flat magenta background | Key out magenta (10.5); export 256² PNG |
| HUD icons (hull, core, scrap, threat, pause) | 5 | Same style as above | Same |
| Title backdrop | 1 | Cinematic key art: a warship above a sea of clouds at sunset, portrait | Downscale to 1080 × 1920; JPEG at 80 |
| Decals (numbers, hazard stripes, squadron insignia) | 6 | Flat vector-style decals on magenta | Key out |

Gemini image models output flat RGB with no alpha channel, so every cut-out asset is generated on solid magenta and keyed. Rendered text inside images is avoided; the HUD sets all text in the DOM.

### 10.4 Prompt template
```
Style: [flat texture / top-down icon / key art]. Subject: [what]. Constraints:
seamless tileable, no perspective, no vignette, no text, no watermark-like
marks, neutral overcast lighting, [palette hexes]. Output: square, [size].
Background: solid #FF00FF (only for keyed assets).
```
Every prompt is stored verbatim in the manifest. Nano Banana outputs carry an invisible SynthID watermark; this is acceptable for a game and noted in `assets/generated/LICENSE.md`.

### 10.5 Post-processing specifications
- **Keying:** the background is never exactly #FF00FF. Flood-fill from the four corners with a Lab color distance tolerance (ΔE < 12), despill fringe pixels (`r = min(r, (g + b) / 2 + 0.05)`), then erode the alpha by 1 px.
- **Seam score:** mean absolute difference between the last and first column (and row), divided by the mean absolute difference between adjacent interior columns; accept at or below 1.5.
- **Offset-and-blend:** roll the image by (w/2, h/2), send it back through the model's edit mode with the prompt "remove the visible cross-shaped seam, keep everything else", and re-score; if it still fails, fall back to a 32 px feathered blend of the rolled image with the original.
- **Normal map from height:** height is the Gaussian-blurred (1 px) luminance; the normal is the Sobel gradient of the height, `n = normalize(−∂h/∂x × k, −∂h/∂y × k, 1)` with `k = 4`, +Y up as three.js expects, stored as `n × 0.5 + 0.5` in RGB8.

### 10.6 Fallbacks
If the API is unavailable or the key is missing, `tools/gen-assets.mts --procedural` writes placeholder textures (noise-based panels, flat icons) so the build never depends on the API. The game must look acceptable with placeholders; generated art is an upgrade, not a dependency.

---

## 11. Audio
- SFX via ZzFX-style parameter presets: autocannon (short, repeating, pitched low), bolt fire, bolt hit, scrap pickup (rising blip), boarder approach (a climbing drone that scales with distance), boarding clamp (heavy metal), turret build, cryo burst, artillery shot, drone death, core hit (alarm), death.
- Mixer: master, SFX, UI. In Tactical Mode, SFX pitch drops by 20% and a low-pass filter closes to 1.2 kHz to sell the time dilation.
- Music: Bonus. A simple procedural drone (two detuned oscillators through a slow filter) is acceptable as a Basic placeholder if it costs under an agent-hour.

---

## 12. Testing and verification

### 12.1 Unit (Vitest)
- `remap`, PRNG determinism, graph shortest paths, the three-final-edge deck rule, turret targeting choices, escalation formulas at every table row in Section 5.8, scrap magnet accounting, boarder turn-radius overshoot cases from Section 5.3, and the camera coverage test from Section 4.3.

### 12.2 Simulation (Vitest + `sim/`)
- Smoke: 10 seeds × 4 bots must finish without exceptions and produce a death cause.
- Balance batch: 200 seeds × 4 bots, run on demand and by a manual CI job, report committed.

### 12.3 Browser (Playwright, Chromium, WebGL 2 backend)
- Boot to Title in under 8 s on the CI runner.
- Replay a 60-second input log from a fixed seed; assert the final HUD values against the sim's numbers for the same seed (the render must not change the game).
- Screenshots at fixed frames for the golden-image tests in Section 9.9.
- Portrait and landscape viewports at 390 × 844 and 1440 × 900.

### 12.4 Performance gates
- The dev panel writes a rolling frame-time histogram; `?bench=1` runs a 30-second scripted flight and dumps p50 / p95 whole-frame times, plus per-pass ablation numbers, to the console and to `docs/DEV_LOG.md` when run.
- The coding agent's container has no GPU, so frame times measured there mean nothing. The desktop gate (bench p95 under 12 ms at High) is run on the owner's machine; mobile numbers are recorded by the owner on real phones and fed back (Section 15). CI checks correctness only.

### 12.5 What "not verified" must always list
Every milestone report ends with the untested items, in this shape: what was tested, how, and what was left untested. Claims of "works on mobile" are not allowed until a real phone has run it.

---

## 13. Delivery plan

### 13.1 Critical path (the 7 items that gate everything else)
1. Renderer gate on both backends (Section 8.2), including the mipmap answer.
2. Simulation core with the deck graph, playable with placeholder cubes, and the camera coverage test.
3. Cloud ray-marcher with the exact integrator, cloud-depth output and depth compositing; deck layer only.
4. Towers, reprojection against cloud depth, `T_ship` for FX, and quality tiers.
5. Sim harness and first balance pass.
6. Asset pipeline and art integration.
7. Owner-run performance and mobile verification, and the final balance pass.

### 13.2 Milestones and proposed dates
Dates assume kickoff Monday 2026-09-08 and one agent working continuously with owner check-ins at each milestone. They are proposals for the owner to confirm.

| Milestone | Dates | Deliverable | Acceptance |
|---|---|---|---|
| M0 Gate | Sep 8 | Vite + TS + three.js scaffold; TSL ray march of a 3D noise sphere on WebGPU and WebGL 2; depth read through `pass()`; float target ping-pong; mipmap check | Gate items (a)–(e) answered on both backends, or Plan B chosen and logged |
| M1 Core loop | Sep 9–13 | Cruiser, auto-aiming autocannons, skirmisher formations, scrap, hull damage, HUD, death screen, seeded RNG, camera coverage test | 60-second replay test passes; `idle` bot dies in 25–45 s |
| M2 Deck | Sep 14–18 | Deck graph with the three-final-edge rule, breaches, Grapple boarders, Strike drones, Point Defense, Tactical Mode with time dilation and camera blend | Boarding → build → survive is playable with cubes |
| M3 Clouds I | Sep 19–25 | Noise generation (compute and worker paths, IndexedDB cache), weather map, deck layer, lighting, adaptive march, exact integrator, cloud depth, compositing, sky with haze | Golden image on WebGL 2 in CI; energy sanity passes; noise generation time measured on the owner's phone |
| M4 Clouds II + tiers | Sep 26–Oct 1 | Towers, reprojection, `T_ship` FX attenuation, bilateral upsample, three tiers, auto-tier | Reprojection sanity passes; owner-run desktop bench p95 under 12 ms at High |
| M5 Full roster + balance | Oct 2–7 | Cryo, Artillery with traverse arcs, Lancer, Ram, Assault drones, escalation, sim harness, first tuning loop | All Section 6.6 bands hit or the misses are documented with a proposed lever |
| M6 Art + audio | Oct 8–11 | Nano Banana pipeline, procedural ships textured, decals, icons, SFX, first-run hints, high score | Thumbnail sheet reviewed by owner; placeholders fully replaced or fallback documented |
| M7 Ship | Oct 12–15 | Mobile verification round with owner, final balance pass, GitHub Pages deploy, `README`, `DEV_LOG` | Owner plays 3 runs on a phone; deploy URL verified loading |

Bare tier corresponds to M0–M3 with a single turret. Bonus items start only after M7.

### 13.3 Owner check-in points
- After M0: confirm renderer path and the mipmap answer.
- After M2: play the cube version on desktop; confirm the feel of Tactical Mode and the auto-aim before art is spent on it.
- After M3 and M4: run the bench and the phone timing; without these numbers the tiers are guesses.
- After M5: confirm balance bands against the owner's own runs.
- After M6: approve the thumbnail sheet.

---

## 14. Risks, force-ranked

| # | Risk | Failure scenario | Mitigation | Where |
|---|---|---|---|---|
| 1 | Cloud pass too slow on mobile | Medium tier drops to 20 fps on a 2023 phone once towers are on; the game feels broken on its primary platform | Quarter-res Low tier with towers off, auto-tier, light every second step, 24 lit-step cap; owner measures on real phones at M3 and M4, not M7 | Sections 8.3, 8.4, 9.6 |
| 2 | Balance targets unreachable by sim alone | Bots survive far longer or shorter than a human, and the tuned game is wrong for people | Re-anchor bands to the owner's runs at M5 and M7; the sim finds regressions, the human sets the anchor | Section 6.6 |
| 3 | Noise generation too slow on the WebGL 2 path | 10-second black loading screen on first run on older phones | Multi-worker split, IndexedDB cache, 64³ at Low tier, compute path on WebGPU; measured at M3 | Section 9.3 |
| 4 | No GPU where the agent runs | The agent cannot see or time its own rendering; visual bugs ship unnoticed | WebGL 2 goldens in CI; owner-run bench and WebGPU goldens as milestone gates; ablation timing | Sections 9.9, 12.4 |
| 5 | Reprojection artifacts during the mode camera blend | Every Tactical toggle shows ghosting, which is the moment the player looks hardest | Forced 4-frame full refresh on blend; reprojection against cloud depth | Section 9.7 |
| 6 | Tactical camping dominates | Player sits in slow motion and the game becomes trivial | Cruiser cannot move in Tactical; cap lever ready | Section 4.3 |
| 7 | Nano Banana outputs are not tileable or not keyable | Seams on the hull; magenta halos on icons | Seam score, offset-and-blend, Lab-distance keying with despill; procedural fallback | Section 10.5 |
| 8 | 3D texture mipmaps unavailable on one backend | Far deck aliases and shimmers at coarse steps | Gate item (e); far range samples COARSE only when mips are missing | Section 8.2 |
| 9 | Model IDs or SDK shape change before the agent starts | The asset script fails on first run | ID is a flag; manifest records it; the agent re-checks the docs first | Section 10.2 |
| 10 | WebGL 2 backend cannot run the TSL march | Fallback devices get no clouds | Source check says it can; half-day gate with Plan B | Section 8.2 |

---

## 15. Assumptions, decisions and open questions for the owner

**Departures from the brief and gap fill-ins (confirm or override):**
1. The setting moves from space to the stratosphere (Section 3).
2. Target tier is Basic.
3. Autocannons auto-aim inside a ±20° cone and do 40% damage to armored boarders (Section 5.2).
4. The Lancer torpedo craft exists so Point Defense has something to intercept.
5. Escalation gets a time floor of one level per 45 s so starving scrap cannot freeze difficulty (Section 5.8).
6. Score is scrap collected plus 25 per overshoot; kills do not score (Section 5.9).
7. Dismantle refunds 50%.
8. Boarders detach and vanish after their last wave; at most 3 clamped at once (Section 5.5).
9. Artillery mounts traverse within fixed arcs rather than firing at one fixed bearing (Section 5.6).
10. The deck has three separate final approaches to the core and no slot within 6 du of it (Section 5.5).
11. Tower tops at 21 km are acceptable stylization.
12. No hull repair in Basic.
13. No time cap on Tactical Mode unless the sim shows camping is dominant.
14. Endless survival with no win state.
15. Procedural ship meshes, not downloaded kits.
16. The game ships to GitHub Pages as a public static site with no backend.
17. Dates in Section 13.2 start Monday 2026-09-08.

**Open questions:**
1. Which phones and which desktop can the owner test on? The tiers in Section 2.3 and the gates in Section 12.4 depend on real hardware the agent does not have.
2. Does the owner want a gamepad in Basic? It is cheap but adds a test surface.
3. Is the SynthID watermark in generated art acceptable for this project's intended distribution?
4. Should the deck layout be a single authored map for Basic, or two (a second one unlocked by score)? The plan assumes one.

---

## 16. References
Links below were returned by web search on 2026-09-07. The container running this session could not open the Guerrilla, Google AI, DeepMind, threejs.org or advances.realtimerendering.com pages, so their contents are summarized from prior knowledge and search snippets; the agent must read them directly. The three.js package itself was unpacked from the npm registry and checked.

- Guerrilla Games, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015): https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn *(not opened here)*
- Guerrilla Games, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" (SIGGRAPH 2017): https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine *(not opened here)*
- Slides for the 2017 talk (Advances in Real-Time Rendering course archive): https://advances.realtimerendering.com/s2017/Nubis%20-%20Authoring%20Realtime%20Volumetric%20Cloudscapes%20with%20the%20Decima%20Engine%20-%20Final%20.pdf *(not opened here)*
- Guerrilla Games, "Nubis, Evolved" (SIGGRAPH 2022): https://www.guerrilla-games.com/read/nubis-evolved *(not opened here)*
- Guerrilla Games, "Nubis³" (SIGGRAPH 2023): https://www.guerrilla-games.com/read/nubis-cubed *(not opened here)*
- Andrew Schneider, Nubis Evolved talk pages on ArtStation: https://www.artstation.com/artwork/LeOOyv and https://www.artstation.com/artwork/ZeXyPZ *(not opened here)*
- three.js on npm (version 0.185.1 confirmed via the registry): https://www.npmjs.com/package/three
- three.js WebGPU volumetric cloud example: https://threejs.org/examples/webgpu_volume_cloud.html *(page not opened; the example source was read from the r185 repository tag)*
- Gemini API image generation docs (Nano Banana): https://ai.google.dev/gemini-api/docs/image-generation *(not opened here)*
- Google AI Studio model page for Gemini 3.1 Flash Image (Nano Banana 2): https://aistudio.google.com/models/gemini-3-1-flash-image *(not opened here)*
- Meteoros, an open Vulkan implementation of the Decima cloud method, useful as a code reference: https://github.com/AmanSachan1/Meteoros *(not opened here)*

Named without links, because no verified URL was available from this session: Wrenninge, Kulla and Lundqvist, "Oz: The Great and Volumetric" (SIGGRAPH 2013 talk), the source of the multiple-scattering octave approximation; Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite" (SIGGRAPH 2016 course), the source of the dual-lobe phase function.

---

## Appendix A. Deck graph schema

```json
{
  "version": 1,
  "grid": { "width": 12, "height": 32, "cellFu": 0.5 },
  "nodes": [
    { "id": "breach-bow", "x": 6, "y": 31, "kind": "breach", "side": "center", "hullRange": [0.85, 1.0] },
    { "id": "breach-port-fore", "x": 0, "y": 22, "kind": "breach", "side": "port", "hullRange": [0.55, 0.85] },
    { "id": "breach-port-aft", "x": 0, "y": 10, "kind": "breach", "side": "port", "hullRange": [0.0, 0.55] },
    { "id": "n12", "x": 6, "y": 26, "kind": "junction" },
    { "id": "core-approach-bow", "x": 6, "y": 4, "kind": "junction" },
    { "id": "core-approach-port", "x": 3, "y": 2, "kind": "junction" },
    { "id": "core-approach-stbd", "x": 9, "y": 2, "kind": "junction" },
    { "id": "core", "x": 6, "y": 1, "kind": "core" }
  ],
  "edges": [
    { "id": "e01", "from": "breach-bow", "to": "n12", "lengthDu": 5 },
    { "id": "e40", "from": "core-approach-bow", "to": "core", "lengthDu": 3 },
    { "id": "e41", "from": "core-approach-port", "to": "core", "lengthDu": 3 },
    { "id": "e42", "from": "core-approach-stbd", "to": "core", "lengthDu": 3 }
  ],
  "slots": [
    { "id": "s01", "x": 4, "y": 26, "mount": "flank-port", "adjacentEdges": ["e01"] }
  ]
}
```

- `hullRange` is the fraction of hull length (0 = stern, 1 = bow); `side` disambiguates port and starboard breaches. A boarder's impact point maps to the breach whose range and side match.
- `adjacentEdges` defines which corridors a slot's turret can see; range is measured along the graph, not as a straight line, so bulkheads block fire.
- Validation at load: every breach has a path to the core; the core has exactly three incoming edges from three distinct approach nodes; no edge shared by two breach routes is longer than 3 du; no slot lies within 6 du of the core along the graph; every slot touches at least one edge; no two slots share a cell.

## Appendix B. Balance config shape

```ts
export const balance = {
  corridor: { xMin: -50, xMax: 50, zMin: -35, zMax: 155, spawnZ: 145, cullZ: -35, cullX: 70 },
  camera: {
    flight: { behind: 45, above: 165, pitchDeg: 68, fovDeg: 55 },
    tactical: { behind: 8, above: 22, pitchDeg: 78, fovDeg: 55, blendS: 0.35 },
  },
  cruiser: { hull: 100, speedX: 55, speedZ: 40, accel: 320, decel: 400, magnetFu: 10,
             boundsX: 42, boundsZMin: -20, boundsZMax: 40, lengthFu: 16, widthFu: 6 },
  autocannon: { rps: 10, damage: 4, speed: 160, spreadDeg: 1.5, aimConeDeg: 20, boarderDamageMul: 0.4,
                priority: ['torpedo', 'skirmisher', 'lancer', 'boarder'] },
  radii: { bolt: 0.6, torpedo: 1.0, shell: 0.8, skirmisher: 2.5, lancer: 3, grapple: 3, ram: 4.5, scrap: 1.0 },
  skirmisher: { hp: 12, speed: 30, weaveAmp: 12, weavePeriod: 2.5, boltEvery: 1.6, boltSpeed: 70,
                boltDamage: 6, ramDamage: 20, scrap: 3 },
  formations: { spacingFu: 6, spawnXRange: 25, firstAtS: 3,
                templates: { v: { max: 8 }, line: { max: 6 }, column: { max: 8 } } },
  lancer: { hp: 20, speed: 24, holdZ: 90, holdS: 20, strafeFu: 20, torpEvery: 4, torpSpeed: 35,
            torpTurnDeg: 20, torpDamage: 18, torpHp: 6, ramDamage: 20, scrap: 5, fromThreat: 2,
            maxAlive: 4, spawnBelowAlive: 3 },
  grapple: { hp: 45, speed: 45, turnDeg: 35, hullDamage: 8, waves: 2, perWave: 4, firstWaveDelayS: 1.5,
             waveGapS: 4, scrap: 6, fromThreat: 0 },
  ram: { hp: 110, speed: 28, turnDeg: 20, hullDamage: 15, waves: 3, perWave: 5, firstWaveDelayS: 1.5,
         waveGapS: 6, scrap: 12, fromThreat: 3 },
  boarding: { maxClamped: 3, droneSpacingDu: 0.5,
              hullRanges: { bow: [0.85, 1.0], fore: [0.55, 0.85], aft: [0.0, 0.55] } },
  drones: { strike: { hp: 10, speed: 4.0, coreDamage: 10 }, assault: { hp: 32, speed: 2.2, coreDamage: 25 } },
  turrets: {
    pd: { cost: 25, rangeDu: 4.5, rps: 10, damage: 3, torpRangeFu: 40, torpResetS: 1.5 },
    cryo: { cost: 35, rangeDu: 6, everyS: 5, fieldRadiusDu: 2.5, fieldS: 4, slow: 0.65, clusterDu: 3 },
    artillery: { cost: 60, everyS: 2.5, damage: 24, splashFu: 7, shellSpeed: 70,
                 centerArcDeg: 15, flankArcMinDeg: 15, flankArcMaxDeg: 60,
                 priority: ['boarder', 'lancer', 'skirmisher'] },
    refund: 0.5, minDistanceToCoreDu: 6,
  },
  escalation: {
    scrapPerLevel: 40, secondsPerLevel: 45,
    formation: { base: 7, perLevel: 0.35, floor: 2.5, sizeBase: 4, sizePerTwoLevels: 1, sizeMax: 8 },
    boarder: { base: 22, perLevel: 1.2, floor: 6 },
    heavy: { base: 0.1, perLevel: 0.05, max: 0.5, fromThreat: 3 },
    lancer: { base: 30, decay: 0.9, floor: 8, fromThreat: 2 },
  },
  tactical: { timeScale: 0.2 },
  core: { hp: 100 },
  scrap: { driftSpeed: 20, lifeS: 8, magnetAccel: 90 },
  score: { perScrap: 1, perOvershoot: 25 },
} as const;
```

## Appendix C. Agent working agreement
- Read Sections 5, 7, 8 and 9 before writing code. Read the Section 16 primary sources before Section 9's code, and verify every formula in 9.4–9.6 against them.
- Keep every tunable in `src/config/`. A literal number in game or render code is a review failure.
- Every milestone ends with: tests green, `docs/DEV_LOG.md` entry (what, why, new env or secrets, verified how, not verified), and a draft pull request. Never merge without the owner's go.
- Never put an API key anywhere but the git-ignored `.env` read by `tools/`.
- Prefer the smallest change that makes the failing test pass. Do not add libraries beyond Section 7.1 without noting the reason in the DEV_LOG.
- When a fact in this document turns out to be wrong (a version, a model ID, an API shape), fix the fact in this document in the same pull request as the code.

## Appendix D. Review log
Revision 2 (2026-09-07) applied two independent review passes over revision 1, one on the game design and one on the rendering spec. The changes that alter the design, rather than tidy it:
- Flight camera moved to 45 fu behind, 165 fu above, 68° pitch, 55° field of view. Revision 1's camera framed about a third of the corridor and never showed the spawn line.
- Autocannon auto-aim defined, with boarder armor, because every balance number depended on an aiming rule that was never stated.
- Lancers now hold for 20 s and then descend, with a cap on how many are alive; revision 1 let them accumulate without limit.
- The deck now requires three separate approaches to the core and bans slots near it, because a single convergence point let one turret cover every route.
- Escalation table and formulas reconciled; the time floor tightened from 75 s to 45 s per level; score no longer rewards kills.
- Cloud integrator replaced with the exact per-step form; multi-scatter octave labels corrected; powder term moved onto light-path optical depth; reprojection now uses a marched cloud depth instead of scene depth; FX attenuate by transmittance to the flight plane instead of total transmittance; step lengths derived from per-tier budgets; Low tier no longer blends history without motion compensation.
- Vite version corrected to 8.x; the WebGL 2 fallback risk downgraded after a source check of three.js 0.185.1; performance gates moved to the owner's hardware.
