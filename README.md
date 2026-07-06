![Foundry v12](https://img.shields.io/badge/Foundry-v12-informational)
![System: Cyberpunk RED CORE](https://img.shields.io/badge/system-cyberpunk--red--core-red)

# Cyberpunk RED — Weapon Additions

A module for **FoundryVTT v12** that extends the
[Cyberpunk RED - CORE](https://gitlab.com/cyberpunk-red-team/fvtt-cyberpunk-red-core)
system with advanced weapon handling. It patches the system at runtime (no core
files are modified) and stores all its configuration in item flags, so it is safe
to enable/disable at any time.

## Features

### 1. Configurable autofire ammo cost
Weapons with an **Autofire Maximum Multiplier > 0** gain an *Autofire / Suppressive
Ammo Cost* field in their settings. Autofire and suppressive bursts consume that
many rounds instead of the hardcoded 10. A world default (also 10) applies to any
weapon that doesn't override it.

### 2. Burst Fire mode
Give a weapon a **Burst Multiplier** (the number of bullets fired in one burst).
A *Burst* toggle then appears in the weapon's fire-mode list on the character
sheet, alongside Aimed / Autofire / Suppressive. Firing in burst mode:
- makes a single attack roll and consumes *Burst Multiplier* rounds,
- rolls a single **Burst Damage Formula** (e.g. `3d6`) in place of the weapon +
  ammo damage,
- optionally substitutes a chosen **ammo type** (dropdown) on the damage card when
  the loaded round is a basic round — affecting armour ablation and lethality
  without changing which physical round is consumed.

### 3. Mixed-type magazines
Toggle **Mixed-type Magazine** on a ranged weapon. Reloading then opens a themed
loading interface showing the magazine as a grid of slots. Drag ammo from your
inventory (or a compendium) into slots, rearrange them freely, and confirm to
load — inventory stacks are debited on confirm and untouched on cancel. Rounds
fire in LIFO order (slot 1 first). Each shot stamps the fired round's type onto
the damage card, so ammo effects are applied per-round. Remaining rounds persist
across reloads.

### 4. Area-of-effect targeting for grenades & rockets
When you initiate an attack with a grenade launcher, rocket launcher, thrown
grenade, or a weapon loaded with grenade/rocket ammo, a **square blast template**
attaches to your cursor (the native Foundry placement flow — it follows the mouse
and can be placed even over a token, rotated with the wheel, cancelled with
right-click). The area is a square measured in grid tiles (default **3×3**,
configurable). On placement, every token inside is set as your target and the
normal attack/damage flow runs against them all.

### 5. Automatic critical-injury linking
Critical-injury names found in item descriptions are turned into clickable
`@UUID` links to the system's critical-injury compendia (case-insensitive,
whole-word) — this also applies to pre-existing items the first time their sheet
is opened. After a damage roll, any critical injuries the firing item references
are shown on the chat card as **draggable chips**: drag a chip onto a token to
apply that injury to its actor, or click it to open the injury.

### Bonus — diwako integration (area DV check)
If [`diwako-cpred-additions`](https://github.com/diwako/diwako-cpred-additions)
is installed, firing an area weapon resolves the ranged **DV at the distance from
the attacker to the blast centre** and posts a hit/miss result to chat. Toggle in
settings.

### 6. Three tiers of Burning
Adds **Mild / Strong / Deadly Burning** status effects to Foundry's token
condition palette (the built-in status-effect toggle on a token). They are
mutually exclusive (a higher tier replaces a lower one) and, at the **end of a
combatant's turn**, deal flat damage (2 / 4 / 6 by default) directly to HP,
ignoring armour. All three amounts are configurable in module settings.

## Settings
- Default autofire ammo cost
- Blast size (tiles)
- Auto-target tokens in blast (on/off)
- Area DV check via diwako (on/off)
- Auto-link critical injuries (on/off)
- Mild / Strong / Deadly Burning damage

## Optional integrations
- **diwako-cpred-additions** — area DV check (see bonus feature above). The
  module works fully without it; the DV check simply stays inactive.

## Requirements
- FoundryVTT **v12**
- **Cyberpunk RED - CORE** system, active in the world

## Notes for maintainers / releasing
`module.json` ships with a concrete `version` so the module installs and displays
correctly when dropped into `Data/modules`. The included GitHub Actions workflow
(`.github/workflows/main.yml`) fills in the `url` / `manifest` / `download` tokens
on release; if you publish via CI, change `version` to the `#{VERSION}#` token so
the release tag is injected. The workflow packages `module.json`, `README.md`,
`LICENSE`, `templates/`, `scripts/`, `styles/`, and `languages/`.

## License
See [LICENSE](LICENSE).
