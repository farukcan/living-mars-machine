# SPEC-04 — Rendering

Stack: React Three Fiber v9 on Three.js, plus `@react-three/postprocessing` for the
screen-space pass. No helper library beyond that — OrbitControls comes straight from
`three/examples` in about forty lines of wrapper. Everything drawn is generated in code;
the repository contains no model, texture or HDRI files.

## What Makes the Scene Read as a Planet

Four things, in descending order of impact. Recorded because each was added after a
screenshot showed the scene looking like a board game rather than a place:

1. **The world continues past the board.** A gradient sky dome, a ring of fogged hills and
   a ground plane meeting the grid at tile-top height. Without these the hexes float in a
   void, and no amount of building detail fixes it.
2. **Ambient occlusion.** Contact shadows are what seat a building on its tile. Nothing
   else in the pipeline darkens the crevice where geometry meets geometry.
3. **Scatter.** Boulders on steep tiles — cleared where a building stands — pebbles on
   the rest, and a hashed colour
   wobble per tile. A field where every tile of an elevation is one flat colour reads as a
   spreadsheet.
4. **Pipework.** Physical pipes between buildings turn a set of models parked on tiles into
   connected infrastructure.

## Sky and Horizon

A back-faced sphere with a fragment shader: a height ramp from horizon to zenith, a sun
glow term, and a haze band that thickens toward the ground line. It is a shader rather than
a texture because it is re-tinted every frame from `solTime` — swapping uniforms is free,
regenerating an image is not.

Colours are lerped between day, night and storm palettes. The fog colour tracks the dome's
horizon band; if the two drift apart, distant geometry visibly separates from the sky.

**Light colour must be chosen against the palette it lands on.** A saturated blue night
fill multiplied against rust terrain produces black — the night fill is near-neutral for
this reason, and it is the single easiest mistake to repeat here.

## Materials and the Glow Mask

Buildings are one instanced mesh per type, which means one material per type — but a
habitat needs a lit window band and an unlit hull simultaneously. Geometry therefore carries
two attributes:

| Attribute | Purpose                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `color`   | Per-vertex base colour, multiplied by the per-instance status tint           |
| `aGlow`   | 0..1 emissive mask, patched into the standard material via `onBeforeCompile` |

The glow is multiplied by the surface colour and a night factor, so lights match the panel
they sit in, come on by themselves after dark, and go out when a building is idled — the
status tint dims the emissive along with everything else, for free.

## Post-processing

| Effect   | Job                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| N8AO     | Contact shadows. Kept at low intensity: pushed harder it greys out a warm palette and reads as dirt, not depth               |
| Bloom    | Makes emissive surfaces read as light sources. Thresholded so only genuinely emissive parts bloom; strength rises after dark |
| Vignette | Pulls attention to the middle of the frame, where the colony is                                                              |
| SMAA     | Edge anti-aliasing, last in the chain so it works on the finished image                                                      |

The composer runs at `multisampling={0}`: MSAA makes every frame resolve a multisampled
buffer before N8AO can read depth and normals, and on a retina display at 120 Hz that alone
cost about a third of the frame budget — measured at ~93 fps with MSAA against a locked
120 fps with SMAA. Frames landing off the refresh cadence are what make slow motion judder,
so anti-aliasing belongs in the chain, not in the buffer.

## The Rendering Contract

**Simulation ticks must never cause a React re-render.** R3F components read simulation
state imperatively inside `useFrame`:

```ts
const { buildings, lastReport } = useSimStore.getState();
```

React re-renders only when the _structure_ changes — a building added or removed — which
is a user action, not a tick. This is what keeps 16x speed smooth: at 16x the simulation
runs 160 ticks per second and the React tree is untouched by all of them.

## Hex Orientation

`CylinderGeometry` places its first vertex on +z, which produces a **pointy-top** hex. The
axial layout in `sim/hex.ts` is flat-top, so every hex geometry is rotated by π/6 before
use. Without the rotation the tiles are correctly positioned but visibly fail to tessellate
— a gap appears between every pair of neighbours. Anything hex-shaped added later (highlight
slabs, placement ghosts) needs the same rotation.

## Instancing

| Mesh           | Instances             | Draw calls           |
| -------------- | --------------------- | -------------------- |
| Hex ground     | 331, split by deposit | 3 (rock / ice / ore) |
| Rock outcrops  | ~60                   | 1                    |
| Pebble scatter | ~450                  | 1                    |
| Distant hills  | 46                    | 1                    |
| Buildings      | up to ~200            | 1 per type in use    |
| Pipes          | one per link          | 1                    |
| Flow packets   | 3 per link            | 1                    |
| Damage badges  | one per damaged bldg  | 1 each               |

Tiles are split into three meshes rather than tinted within one because ice needs a
different _material_ — a smooth, low-roughness sheet that catches the sun. A grey tint on a
rough material cannot express "there is water there".

Per-instance colour goes through `instanceColor`, so idle desaturation and damage tinting
cost a buffer write rather than a material. Matrices are recomputed only when a building is
added, removed or changes state — never per frame. See **Animated Objects** below for the
deliberate exceptions.

## Procedural Geometry

Each building is composed from primitives in `render/geometry/buildingGeometry.ts`, merged
into one `BufferGeometry` per type at startup. The design rule is **silhouette first**:
at the default zoom a building is roughly 40 px tall, so each type must be identifiable by
outline alone, before colour. Detail below that threshold — panel cells, hull ribs, banding
— exists for when the player zooms in, and costs nothing extra at distance because it is
all one mesh.

| Building      | Silhouette                                                             |
| ------------- | ---------------------------------------------------------------------- |
| Solar Array   | Tilted cell grid on a braced mast — the only wide, flat, angled shape  |
| Battery Bank  | Corner-posted enclosure on a plinth, behind a lit status board         |
| Habitat       | Geodesic dome on a drum: window band, round airlock, comms mast        |
| Ice Extractor | Lattice drill mast over a wellhead — the tallest thing on the map      |
| Electrolyzer  | Two banded columns under a sphere on copper elbows                     |
| Greenhouse    | Glazed barrel vault between two end modules — the only horizontal drum |
| Mine          | Trussed conveyor climbing from a spoil-ringed pit to a chute           |
| Storage Depot | Three banded tanks on a pallet beside a control cabinet                |
| Landing Pad   | A lit apron on a hex deck — the only flat, ground-level shape          |

**The solar array is authored in two halves.** `solarArrayBase` is the pedestal, mast and
braces; `solarArrayHead` is everything above the pivot — motor, rail, cells, spine — built
around the mast axis so a yaw about Y turns it in place. Only the head tracks the sun, and a
pedestal that swung with the panel read as a bug. `buildingGeometry('solarArray')` still
returns the two merged, which is what the placement ghost and the reference renders want.

**Scale has a hard ceiling.** A flat-top hex is √3 ≈ 1.73 units across and the widest
building is 1.32 units, so the instance scale cannot exceed ~1.2 without neighbouring
buildings visibly overlapping — which in a dense colony reads as a rendering bug.

Two facets earn their complexity. The habitat's dome is a real geodesic: an icosphere with
each face inset toward its own centroid, leaving strut gaps. A smooth dome does not read as
a Mars habitat. The solar array's cells are individual quads on a frame, so they survive any
zoom without a texture — and the panel tilt is deliberately shallower than a real array
would use, because a steeper one presents its unlit edge to a raised camera and renders as
a black slab.

**The concept art in `docs/concept_art` sets the detail level.** What separates a machine
from a primitive there is a small, repeatable vocabulary — stepped footings, overhanging
roof caps, corner posts, banded tanks, capped vent stacks — and each of those costs a
handful of triangles rather than a texture. Segment counts stay low on purpose: the
faceting is the style. A building sits at roughly 300–700 triangles, so a 200-building
colony stays comfortably inside the triangle budget below.

Two of the concepts cannot be reproduced literally, and are approximated instead:

- **The greenhouse's glass is opaque geometry**, so its interior can only be shown from
  outside. Lit grow-light strips run along the glazing bays where the concept shows purple
  light coming through the vault.
- **The mine's pit is not a bored hole** — that would need a CSG operation on the tile. It
  is a dark disc recessed below the deck, ringed by a spoil berm, which reads as a pit at
  any zoom the game actually uses.

**Reference renders.** `npm run render:buildings` drives `BuildingStudio` through Playwright
and writes one PNG per type to `docs/buildings`, which is how a geometry change is checked
against the concept art. The studio holds the glow mask at a dusk value rather than full
night: at full night every window and status board blows out to flat white and the render
stops being a useful reference. `npm run render:trailer` records a WebM of the live colony
into `media/trailer.webm`; it is opt-in and is not part of the e2e suite. `npm run
render:crazygames` captures the CrazyGames covers and preview videos into `media/crazygames/`
from the production build, on the GPU under a frozen clock, and checks them against the portal's
requirements before writing.

**Merging requires identical attribute sets.** The hand-built geodesic shell has no UVs, so
`assemble` strips UVs from every part before merging. Nothing here is textured; this is both
the fix and a smaller vertex buffer.

## Materials and Palette

`MeshStandardMaterial` with flat shading. Low-poly plus flat shading gives faceted
highlights that read as stylized rather than unfinished, and it costs nothing.

| Role                          | Colour                     |
| ----------------------------- | -------------------------- |
| Terrain low / high            | `#8C4A32` → `#C98F63`      |
| Ground beyond the grid        | `#A8623F`                  |
| Ice sheet                     | `#C6D8E2` (roughness 0.12) |
| Ore                           | `#4C4038` (roughness 0.85) |
| Building shell                | `#D8D4CC`                  |
| Solar cell / panel frame      | `#3465AE` / `#B4B8BE`      |
| Spoil and worn plate          | `#5A4A3E` / `#B25E30`      |
| Pipework                      | `#8A9096`                  |
| Accent (active)               | `#4FC3F7`                  |
| Warning (throttled)           | `#FFB74D`                  |
| Critical (damaged / shortage) | `#EF5350`                  |
| Sky zenith day → night        | `#C97F58` → `#141020`      |
| Sky horizon day → night       | `#F6CDA6` → `#2A2036`      |

The terrain is warm-neutral so that the status colours — cyan, amber, red — and the resource
colours are the only saturated things on screen. Status is readable at a glance without a
legend.

**Ore and ice must not converge.** Both started as greys and became indistinguishable; ore
is now warm and matte, ice cool and smooth. Two deposits the player must tell apart cannot
be separated by lightness alone.

**Metalness needs something to reflect.** There is no environment map, so a high-metalness
surface renders as a black hole in the map. Ore sat at 0.55 and looked like a void; it is
0.1 now.

## Resource Colours

Shared by the HUD icons, the stock bars and the 3D flow packets, so a colour means the same
thing in both places:

| Resource | Colour    |
| -------- | --------- |
| Power    | `#FFB74D` |
| Oxygen   | `#59D4F0` |
| Water    | `#6FB0F0` |
| Food     | `#8BC34A` |
| Minerals | `#C9A227` |

## Iconography

Hand-drawn inline SVG on a 24×24 grid, in `src/ui/icons.tsx` — no icon package, for the same
reason the 3D is procedural. The building icons are miniatures of their own silhouettes, so
the build bar reads as a catalogue of what is on the map rather than as abstract symbols.

### Damage badges

A meteor's damage tint and the lean in `writeMatrices` only read once the player is already
looking at that building, so `render/DamageMarkers.tsx` floats a warning triangle over every
damaged one. It is a `Sprite`, which faces the camera at any orbit angle, with
`sizeAttenuation` off so it holds one size on screen — a wrecked mine at the grid's edge is
as legible as one under the cursor — and `depthTest` off, because a fault hidden behind a
ridge is a fault that never gets repaired. The badge is drawn into a canvas at load rather
than imported, matching the rest of the art in the project, and anchored off the building
geometry's own bounding box: a habitat dome and a solar mast are nowhere near the same
height, and a fixed offset would clip one and float the other.

One sprite per damaged building rather than an instanced billboard. Meteors hit one building
at a time and repairs clear them, so the list is usually empty and never long enough to earn
the shader.

## Day / Night

```mermaid
flowchart LR
    SOL[solTime 0..1] --> ELEV[sun elevation<br/>sin 2π solTime−0.25]
    ELEV --> INT[intensity max 0 elev]
    INT --> SIM[solar output · SPEC-01]
    ELEV --> DIR[light direction]
    INT --> SKY[sky and fog colour lerp]
    INT --> EMIS[emissive strength 1−intensity]
    DUST[dust storm] --> INT
    DUST --> SKY
```

- One `directionalLight` arcing across the sky, casting shadows; a dim hemisphere light
  fills the shadows so the night side never goes fully black.
- Shadow map 4096², ortho frustum ±30 (scaled with the radius-10 board). The light's
  position still advances every frame (`renderSolTime()`), so lighting stays smooth, but
  `shadow.autoUpdate` is off and the depth map is redrawn only after the light has
  travelled ~0.21 world units — seven frames of 1x motion at 120 Hz, the same simulated
  cadence on any refresh rate. A one-texel Euclidean gate (~0.015) is smaller than a
  single 1x frame (~0.030), so it would never hold. Updating every frame rasterises the
  depth pass onto a slightly different grid each time, which reads as flicker; holding
  then jumping is policy. The map is also dirtied when the building list changes, so a
  placement while paused still casts a shadow.
- Sky and fog colours lerp on sun intensity. During a dust storm both shift toward
  `#C1553A` and fog density roughly doubles — the storm is sold by the atmosphere, not by
  particles.
- Window emissive strength rises as `1 − sunIntensity`, so the colony lights up on its own
  as the sun goes down.

## Pipes and Flow Packets (F-19)

Steel pipes run between each producer and its nearest consumer, with glowing packets
sliding along them. The pipes are one stretched cylinder per link, oriented by a quaternion
between endpoints; the packets are a second instanced mesh, `toneMapped={false}` so they
stay saturated and trip the bloom threshold.

- Colour by resource: power amber, water blue, oxygen cyan, food green.
- A line either flows at full rate or is empty. Production is all-or-nothing
  ([SPEC-01](./SPEC-01-simulation.md)), so there is no partial speed to draw and a stopped
  producer collapses its packets to zero scale. The line is a readout of the allocator, not
  decoration.
- The HUD toggle controls the **packets**, not the pipes. Infrastructure always stands;
  what the player is switching off is the animated readout on top of it. There is no
  automatic cutoff at a building count — silently removing an overlay the player asked for
  would look like a bug rather than a courtesy.

Pairing is by nearest consumer per resource, not by a real network — [SPEC-01](./SPEC-01-simulation.md)
is explicit that there is no transmission topology. The lines visualize the allocation, and
the code comment must say so, so nobody later mistakes them for a graph solver.

## Animated Objects

Exactly three things in the scene move every frame, and they are the stated exception to
"matrices are recomputed only on a structural change":

| Object                                | File            | What moves                             |
| ------------------------------------- | --------------- | -------------------------------------- |
| `FlowPackets`                         | `Pipelines.tsx` | packets sliding along cable curves     |
| `Rocket`                              | `Rocket.tsx`    | one rocket descending and lifting off  |
| Solar array heads (`BuildingCluster`) | `Buildings.tsx` | panel yaw tracking the sun's direction |

All three follow the same three rules, and anything added here must too:

1. Read state imperatively inside `useFrame` via `useStore.getState()`. None of them ever
   touch React, so a simulation tick still cannot re-render the tree.
2. Allocate no geometry, vectors, matrices or arrays per frame. Write into module-level
   scratch objects, or straight onto a ref's `position` / `scale`. (`Rocket` returns a small
   phase record and the solar arrays a yaw scalar each frame; that is a deliberate exception,
   taken because keeping the arithmetic pure is what makes it testable without a renderer.)
3. Drive the phase from the **simulation** clock — `sol + solTime` for a cycle that spans
   several sols (the rocket), `solTime` alone for anything that simply repeats every sol (the
   sun, and the arrays that track it). Pausing then freezes the animation and 16× speeds it
   up, both for free. Take `solTime` from `renderSolTime()` (docs/SPEC-05-state.md), never
   from `sim.solTime`: the simulation ticks at 10 Hz, so the raw value holds still for a
   dozen render frames and then jumps. `FlowPackets` is the one exception, and a deliberate
   one — it rides `state.clock.elapsedTime`, a wall clock, because a packet is a "this link
   is running" indicator rather than a scheduled event, and freezing the whole colony's
   plumbing on pause would read as a stall rather than as a pause.

### The rocket

One landing cycle is `(sol + solTime) % LANDING_INTERVAL_SOLS`, split into rest on the pad,
lift-off, an empty sky, and descent. A single modulo drives the whole sequence, which is why
the visual and the simulation can never disagree about when a crew arrives.

That phase table lives in `render/rocketPhase.ts` rather than in the component, so it can be
tested without pulling react-three-fiber into a unit test (test).

Sol 1 is the one exception, and it borrows the same phase table rather than adding a second
one. `sol` starts at 1 and `LANDING_INTERVAL_SOLS` is 7, so the real cycle's rest-and-lift-off
window — the first `ASCENT_END` sols after a touchdown — can never fall within a fresh
colony's opening sol, and the player would otherwise only ever find an empty pad until the
first real landing, sols away. `rocketCycle` (also in `render/rocketPhase.ts`, and tested
alongside it) papers over that by returning `solTime` alone while `sol === 1`: the founding
rocket that dropped off the starting crew is still parked, then lifts off and leaves once
`solTime` passes `REST_SOLS`. It settles back into the regular
`(sol + solTime) % LANDING_INTERVAL_SOLS` cycle — and the empty pad it leaves behind — the
moment `sol` ticks to 2. Nothing about crew arrival reads this branch: `crewArriving` counts
only real `sol` boundaries, so the opening lift-off can't invent a landing.

Two constraints come from the sun rig:

- `ENTRY_ALTITUDE` is 12 units, held well under the directional light's ±30 shadow ortho. A
  higher spawn leaves the shadow frustum at low sun angles and its shadow silently stops
  rendering.
- The rocket casts a shadow only while it is on the pad. A hard shadow thrown from twelve
  units up sprawls across the whole colony; the contact shadow on the pad is the one that
  stops it reading as pasted on.

The plume is a separate mesh with `meshBasicMaterial` and `toneMapped={false}`, the same
recipe as the flow packets, so it clears the bloom threshold without a second light rig. The
body reuses `createBuildingMaterial`, which lights its window band at night through the
existing `aGlow` path.

### Solar arrays

Every solar array's **head** yaws in place to face wherever `SunLight.tsx` currently renders
the sun, using the same `sweep = 2π(solTime − 0.25)` angle as the light rig. The pedestal it
stands on is a second instanced mesh that keeps the matrices written on the last structural
change, so the ground half never turns. Only yaw moves: the panel's own tilt in
`buildingGeometry.ts` is deliberately shallow so it doesn't present its unlit edge to the
camera, and steepening it to track elevation as well would reintroduce exactly that problem
at low sun angles.

Both meshes carry the same click and hover handlers, and their instance indices line up, so
clicking a panel selects the array it belongs to.

The yaw math lives in `render/solarTracking.ts` rather than in `Buildings.tsx`, the same
split as `rocketPhase.ts`, so it is tested (`solarTracking.test.ts`) without a renderer.
Because only rotation changes frame to frame, `BuildingCluster`'s per-frame pass rewrites
just the instance matrix — colour and the bounding sphere, both invariant under rotation,
stay with the structural `useLayoutEffect` that runs on building-list changes.

## Camera (F-20)

`OrbitControls` with:

| Constraint  | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Polar angle | 0.15π .. 0.49π (never below the horizon, never straight down)          |
| Distance    | 5 .. 45                                                                |
| Default     | `[18.2, 11.2, 18.2]` — 40% further than the original framing           |
| Target      | clamped to the grid bounds so the colony cannot be lost off-screen     |
| Damping     | 0.08                                                                   |
| Keyboard    | WASD and the arrow keys pan, at 0.5 world units/s per unit of distance |

Pan on right-drag or two-finger drag, orbit on left-drag, zoom on wheel or pinch. Left
click without drag is a selection or placement action, so the click/drag threshold is
explicit rather than inherited.

Keyboard pan moves the target and the camera by the same vector, along the camera's own
heading flattened onto the ground plane, so W is always "further into the view" whatever
the orbit angle. Speed scales with distance: at full zoom-out the same key press has to
cover far more ground to feel like the same motion. Held keys are read by the frame loop
rather than stepped per event, which is what makes the motion frame-rate independent; a
`blur` listener clears them, since a key held while the tab loses focus never reports its
keyup.

## Performance Budget

| Item                                | Budget                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| Draw calls                          | < 20                                                         |
| Post-processing                     | AO at half resolution, bloom with mipmap blur                |
| Triangles                           | < 150k                                                       |
| Per-frame allocations in `useFrame` | zero — vectors and matrices are module-level scratch objects |
| Shadow map updates                  | only on meaningful sun movement                              |
| Target                              | 60 fps at 200 buildings, mid-range laptop integrated GPU     |

### Measuring It

**F3** opens the profiler overlay: 30 s graphs of fps, draw calls and — on Chromium — JS
heap, plus the worst frame of the last 250 ms and the triangle count as plain readouts. Only
the fps track carries a dashed reference line, at the 60 fps target. Sampling lives in
`src/state/profiler.ts` (docs/SPEC-05-state.md). FPS is counted by `FrameSampler` from the
Canvas `useFrame` loop — the simulation rAF is a separate chain and is not what is on
screen. `RenderStatsProbe` reads draw calls and triangles out of `WebGLRenderer.info` and
mounts only while the overlay is open.

The draw-call figure is the **whole frame**: the shadow pass and every post-processing pass
count alongside the scene, which is why the number sits nearer 70 than the < 20 in the table
above, and why it gets no budget line. The table budgets the scene itself — the part that
grows with colony size — so what the graph is read for is flatness: a jump when a building is
placed is a regression in instancing, while the composer's constant overhead is not.
