# Shadow mapping for fill-extrusions

This document describes how `light.shadow-intensity` lets fill-extrusion layers cast shadows onto
each other and onto the ground. It covers the first version: a single shadow map rendered from the
root `light`, with no cascades.

## Style specification

The only new property is `light.shadow-intensity`: a number from 0 to 1, default 0, transitionable
and zoom-interpolated, like `light.intensity`. At 0 no shadows are drawn. The shadow direction comes
from the existing `light.position` and `light.anchor`, so shadows always agree with the shading
fill-extrusions already receive. No other options exist: there is no shadow color, resolution,
distance or bias in the style.

The property lives in `maplibre-style-spec` (`src/reference/v8.json`, with validation fixtures and
a changelog entry). Until a spec release carries it, the built spec is copied into this repository's
`node_modules/@maplibre/maplibre-gl-style-spec`; `package.json` is unchanged.

Other proposals exist in the style-spec tracker. They put `fill-extrusion-shadow-opacity` and
`fill-extrusion-shadow-color` on the layer
([maplibre-style-spec#1797](https://github.com/maplibre/maplibre-style-spec/issues/1797),
[maplibre-style-spec#1870](https://github.com/maplibre/maplibre-style-spec/pull/1870)), and the
`sdk-support` entry of the new property currently points to the tracking issues of that proposal
([maplibre-gl-js#8830](https://github.com/maplibre/maplibre-gl-js/issues/8830),
[maplibre-native#4802](https://github.com/maplibre/maplibre-native/issues/4802)). A light property
fits a shadow map better than a layer property: there is one light and one shadow map per frame,
and every fill-extrusion layer both casts into it and receives from it. Maintainers need to settle
which property name lands, and replace the `sdk-support` links with the GL JS version or PR before
merging.

## Rendering pipeline

Each frame with a non-zero `shadow-intensity`:

1. **Caster pass** (`drawShadowMap` in `src/webgl/draw/draw_shadow.ts`), after the offscreen pass
   and before the main framebuffer is bound. Every visible fill-extrusion tile is drawn into a
   2048×2048 `DEPTH_COMPONENT16` texture from the light, with color writes disabled. It uses the
   existing `fillExtrusion` program, unchanged, and the bucket's existing vertex, index and paint
   buffers, under its own vertex array key (`<layer id>/shadow`) so that the caster and receiver
   passes do not rebind each other's vertex arrays.
2. **Ground pass** (`drawGroundShadow`). Just before the first 3D layer, one quad covering the
   shadow map's footprint on the ground is alpha-blended over what has been drawn so far: black,
   with the shadow darkening as alpha. Everything below the lowest fill-extrusion layer is darkened;
   labels and other layers above it are not.
3. **Receivers.** `fill-extrusion` and `fill-extrusion-pattern` programs are compiled with
   `#define SHADOWS` and multiply their color by `1 - shadow_darkening()`.

Shadow uniforms (`u_shadow_matrix`, `u_shadow_intensity`) live in a new uniform block, `ShadowUBO`,
at binding 3, next to the existing projection and frame blocks.

### Light projection

The light is orthographic. Its frustum is fitted analytically to a square on the ground, aligned
with the light's azimuth, that covers the viewport and moves ahead of the map center as the camera
pitches (`radius = hypot(width, height) / 2 * (1 + sin(pitch))`). The near plane leaves room for
extrusions up to 1000 m tall; the polar angle is clamped at 80° so that shadows keep a finite length.

The azimuth follows the shading convention: clockwise from north for `anchor: map`, from the top of
the viewport for `anchor: viewport`. The light direction in world pixels is therefore
`(sin a, -cos a)`. The matrix is written out in closed form instead of composing `lookAt`, `ortho`
and a scale; the two agree to within 5e-12.

### Filtering and bias

| Problem | Technique | Reference |
|---|---|---|
| Hard, aliased edges | Hardware depth comparison (`sampler2DShadow`, `LINEAR`), four taps half a texel apart, which filters 3×3 texels | Bunnell and Pellacini, "Shadow Map Antialiasing", *GPU Gems*, chapter 11 |
| Self-shadowing ("acne") on surfaces facing the light | Slope-scaled depth bias in the caster pass, `polygonOffset(2, 4)` | Microsoft, "Common Techniques to Improve Shadow Depth Maps" |
| Sawtooth bands on walls the light grazes | Receivers look up the map two texels out along the wall normal (normal offset shadows) | Holbert, GDC 2011 |
| Walls facing away from the light | Shadow weight fades out with `smoothstep(0, 0.2, directional)`; the shading already darkens them | — |
| Hard cut at the edge of the shadow map | Darkening fades out over the outer 5% of the map | — |

The caster pass culls back faces. Because the light matrix mirrors winding, that is
`CullFaceMode.frontCCW`. Back faces never decide what is nearest to the light, and skipping them
cut the caster pass from about 1.0 ms to about 0.75 ms of GPU time (see [Performance](#performance)).

Two facts about the existing code are easy to trip over:

- **Wall normals point into the extrusion** in tile coordinates. The shading compensates by
  dotting them with the negated light direction, so the normal offset subtracts the normal.
- **`Context.bindTexture` caches one texture regardless of the active unit.** Binding the shadow
  map to unit 4 through it can be skipped when the same texture was last bound to another unit, so
  `bindShadowMap` calls `gl.bindTexture` directly, as `Texture.bind` does.

## Constraints

### Zero cost when disabled

With `shadow-intensity` at 0, the default:

- `drawShadowMap` returns before issuing any GL call; there is no caster pass and no ground quad.
- Receivers pass no extra defines, so the program cache keys are the same as before and no shadow
  program variant is compiled.
- No texture, framebuffer or uniform buffer exists. They are created on the first frame that needs
  them and deleted as soon as the intensity returns to 0.

`src/ui/map_tests/map_shadows.test.ts` proves this. It compares draw calls, compiled programs,
textures and framebuffers against a map with no light at all, and checks that no `#define SHADOWS`
source is compiled, no framebuffer is created and no depth texture is allocated.

### No per-frame allocations

All matrices, uniform values and vertex array keys are allocated once with the shadow map. The
light matrix and the ground quad matrices are only recomputed when the camera matrix, azimuth,
polar angle or anchor changed; otherwise `updateLightMatrix` returns after one `mat4.exactEquals`.
Per tile, only the 16 floats of the tile's shadow matrix are written, in place. The one exception
is a layer with a non-zero `fill-extrusion-translate`: `translatePosition` returns a new array per
tile, exactly as in the existing fill-extrusion pass.

### Mobile and compatibility

- WebGL 2 core only: depth textures, `texStorage2D` and comparison samplers are all core features.
  No extension is used and no float render target is created.
- `DEPTH_COMPONENT16` keeps memory at 8 MB.
- Fragment shaders stay `mediump`, except for the shadow coordinate and the sampler, which are
  declared `highp` like the existing depth sampler.
- If the depth framebuffer is incomplete, shadows are switched off for the life of the map
  (`painter.shadowsUnsupported`) and creation is never retried.
- With terrain, globe or any non-mercator projection, nothing is drawn.

### No worker or vertex layout changes

The caster pass draws the bucket data as it is, and the receivers already have the position,
elevation and normal they need in the existing attributes. No worker code, bucket or vertex layout
changes.

## Budget

Measured against `main` at `2b68611a4`, built with `npm run build-prod`:

| | main | branch | change |
|---|---|---|---|
| Non-test source lines | — | — | +300 (net +297) |
| `maplibre-gl.mjs`, gzip | 299,218 B | 301,187 B | +1,969 B |
| `maplibre-gl-worker.mjs`, gzip | 149,998 B | 149,998 B | 0 |

Both builds include the overlaid style spec. The new spec entry itself adds 19 bytes of gzip, so
the total increase is about 1.99 KB.

## Performance

Measured with timer queries (`EXT_disjoint_timer_query_webgl2`) in a Chromium-based browser on a
Windows desktop GPU, in the example page (lower Manhattan, zoom 15.5, pitch 45, 984×1026 drawing
buffer), median of 40 frames:

| Work | GPU time |
|---|---|
| Caster pass | 0.5–1.0 ms (median about 0.75 ms) |
| Ground pass | about 0.33 ms |
| Fill-extrusion receivers | about 0.75 ms, the same as without shadows |
| Depth clear | not measurable (fast clear) |

CPU overhead is about 0.1 ms per frame. A moving camera costs the same as a still one, because the
matrices are cheap to recompute. These figures were taken before the normal offset was added, which
adds a handful of vertex-shader operations.

## Testing

- **Unit tests** (`src/ui/map_tests/map_shadows.test.ts`): zero cost when disabled; one extra
  texture, framebuffer and two draw calls when enabled; resources freed when the intensity returns
  to 0; no shadows on the globe; shadows stay off without retrying when the depth framebuffer is
  incomplete.
- **Render tests** (`test/integration/render/tests/light-shadow-intensity/`): a tall box shadows the
  ground and half the roof of a short box, with plain and patterned extrusions. The light comes from
  the west (azimuth 270), so a light mirrored east–west fails them.
- **Example:** `test/examples/cast-shadows-from-3d-buildings.html` lets you change intensity,
  azimuth and polar angle on real buildings.

## Limitations

- One shadow map for the whole view. Shadows are sharp close up and soft when zoomed out or at high
  pitch, where one texel covers more ground.
- Only extrusions in visible tiles cast shadows, so a tall building just off screen does not shade
  the view.
- Extrusions above 1000 m are clipped by the light's near plane.
- No shadows with terrain, on the globe or in non-mercator projections.
- Only fill-extrusions cast shadows. Fill-extrusions and everything below them receive shadows;
  symbols, and layers above the first fill-extrusion layer, do not.

## Future work

- Cascaded shadow maps, to keep shadows sharp near the camera at high pitch.
- Shadows over terrain and on the globe.
- Casting from tiles just outside the viewport.

## References

No reference list accompanied the task, so each technique cites the publication it comes from:

- Bunnell, M. and Pellacini, F. "Shadow Map Antialiasing." *GPU Gems*, chapter 11. Addison-Wesley, 2004.
- Microsoft. "Common Techniques to Improve Shadow Depth Maps." Windows App Development documentation.
- Holbert, D. Normal offset shadows. Poster, Game Developers Conference, 2011.
