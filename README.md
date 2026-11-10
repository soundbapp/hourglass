# Hourglass — The Eye: Containment Bay

A deliberately tiny first-person level built to carry a large rendering budget:
one flooded concrete bay, a hole punched through the ceiling, and a shaft of
afternoon sun falling across an artifact on a plinth.

Three.js `0.180.0`, WebGL2, TypeScript in strict mode. No art assets — every
texture in the level is synthesised from noise at load time, which is why the
whole thing ships as a single HTML file.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173
```

```sh
npm run build              # dist/           — normal static build
npm run build:standalone   # dist-standalone/hourglass.html — one file, open it directly
npm run typecheck
```

`hourglass.html` has no sibling files and no server requirement. Double-click it.

**Controls** — WASD move, Shift sprint, Ctrl crouch, Space jump, LMB fire,
RMB aim, R reload, Esc release the cursor.

## What is actually in the frame

The render path is the point of the demo, so it is worth saying what each piece
is doing and why it sits where it does.

**Materials** are generated, not loaded. `SurfaceRecipes` describes each surface
as a function of position — concrete with aggregate and pooled water, rusted
steel, chipped industrial paint, bead-blasted anodised gunmetal — and
`TextureFactory` evaluates it into albedo, normal and a packed ORM map on a
wrapped lattice so every result tiles. Albedo stays inside the 0.03–0.8 range
real dielectrics occupy, roughness is never constant, and metalness is binary.

**Lighting** is image-based, from a PMREM probe of a purpose-built *interior*
scene rather than of the sky. A probe of the sky would light the room as if the
ceiling were not there; a probe of a box with emitters where light genuinely
enters puts a bright slot along the top edge of every horizontal surface and
leaves the corners dim, which is what makes metal read as metal indoors.

**The shaft** is raymarched. For each pixel the volumetric pass walks the ray
from the eye to the first surface, asks a sun-space depth map whether each point
*in mid-air* is lit, and accumulates scattering weighted by a Henyey–Greenstein
phase function. It therefore narrows correctly through the breach, is cut by the
gantry crossing it, and brightens when you look toward the sun. The dust motes
sample the same depth map in their vertex shader, so a mote drifting into the
beam agrees exactly with the beam it is drifting into.

**Post** runs in this order, and the order is not a preference:

1. Render to a floating-point target — the sun is far brighter than white.
2. GTAO, while depth and normals still describe real geometry.
3. Volumetric shafts, in linear HDR, after AO and before bloom.
4. Bloom, which must see linear values to know what is genuinely over-bright.
5. Tone map and sRGB encode. Everything above is physical; below is photographic.
6. Grade, vignette, grain, aberration — display space, where a colourist works.
7. SMAA last, on the image the viewer actually sees.

Two decisions in there were measured rather than assumed, and both are
documented at the code:

- The HDR buffer format is chosen by **probing** whether the driver can filter
  half float, because the extension strings are unreliable in both directions
  (`src/render/Capabilities.ts`).
- Additive sprite effects are excluded from every depth-only capture by layer.
  A depth capture draws with an opaque override material, which turns a `Points`
  field into a few thousand solid squares in the depth buffer and cuts both the
  light shaft and the ambient occlusion into hard rectangles
  (`src/render/RenderLayers.ts`).

## Layout

```
src/core      noise, input
src/render    capabilities, environment, depth capture, post chain, passes
src/world     procedural surfaces, texture synthesis, geometry, the level
src/player    movement and collision, weapon and viewmodel
src/fx        dust motes, impact decals and sparks
src/ui        HUD
```
