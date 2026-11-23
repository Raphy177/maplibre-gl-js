import {mat3} from 'gl-matrix';
import {UBO_BINDINGS, UniformBuffer, std140Layout} from './uniform_buffer.ts';
import {calculateFogBlendOpacity} from '../style/sky.ts';
import {getCameraToSeaLevelDistance} from '../camera/mercator_camera_math.ts';

import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {Context} from './context.ts';
import type {FrameRenderData} from '../render/frame_render_context.ts';
import type {ProjectedCamera} from '../camera/projected_camera.ts';

/**
 * The fog and horizon colors premultiplied by the fog opacity; `fog-ground-blend`, `horizon-fog-blend` and the fog
 * depth as `z - w * gl_FragCoord.w`; and the fog depth of the ground as a plane over normalized device coordinates.
 */
const layout = std140Layout([
    {name: 'u_fog_color', type: 'vec4'},
    {name: 'u_horizon_color', type: 'vec4'},
    {name: 'u_fog_params', type: 'vec4'},
    {name: 'u_fog_ground', type: 'vec4'},
]);
const offsets = layout.offsets;

/** From `(x, y, 1)` on the ground, in world pixels, to `(x, y, w)` in clip space. */
const groundToClip = new Float64Array(9) as unknown as mat3;
const clipToGround = new Float64Array(9) as unknown as mat3;

/**
 * Writes the fog of the frame into the buffer behind the `FogUBO` block of the fragment prelude, and returns whether
 * there is any to draw. With terrain the fog is drawn whenever there is a sky, as the terrain draws it; on a flat map
 * only when the style sets one of the fog properties.
 */
export function updateFogUniformBuffer(context: Context, projectedCamera: ProjectedCamera, data: FrameRenderData, hasTerrain: boolean): boolean {
    const sky = data.sky;
    if (!sky || data.isRenderingGlobe || (!hasTerrain && !data.hasFog)) return false;

    const opacity = calculateFogBlendOpacity(projectedCamera.pitch);
    const fogGroundBlend = sky['fog-ground-blend'];
    if (opacity <= 0 || fogGroundBlend >= 1) return false;

    const m = projectedCamera.modelViewProjectionMatrix;
    mat3.set(groundToClip, m[0], m[1], m[3], m[4], m[5], m[7], m[12], m[13], m[15]);
    if (!mat3.invert(clipToGround, groundToClip)) return false;

    const near = getCameraToSeaLevelDistance(projectedCamera);
    const far = projectedCamera.farZ;
    const depthAtInfinity = far / (far - near);
    const depthPerInverseW = far * near / (far - near);

    const buffer = context.fogUniformBuffer ??= new UniformBuffer(context, UBO_BINDINGS.FogUBO, layout);
    const f32 = buffer.pending;
    writeColor(f32, offsets.u_fog_color, sky['fog-color'], opacity);
    writeColor(f32, offsets.u_horizon_color, sky['horizon-color'], opacity);
    f32[offsets.u_fog_params] = fogGroundBlend;
    f32[offsets.u_fog_params + 1] = sky['horizon-fog-blend'];
    f32[offsets.u_fog_params + 2] = depthAtInfinity;
    f32[offsets.u_fog_params + 3] = depthPerInverseW;
    f32[offsets.u_fog_ground] = -depthPerInverseW * clipToGround[2];
    f32[offsets.u_fog_ground + 1] = -depthPerInverseW * clipToGround[5];
    f32[offsets.u_fog_ground + 2] = depthAtInfinity - depthPerInverseW * clipToGround[8];
    buffer.upload();
    return true;
}

function writeColor(f32: Float32Array, offset: number, color: Color, opacity: number): void {
    f32[offset] = color.r * opacity;
    f32[offset + 1] = color.g * opacity;
    f32[offset + 2] = color.b * opacity;
    f32[offset + 3] = color.a * opacity;
}
