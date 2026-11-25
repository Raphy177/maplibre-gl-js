import {mat4} from 'gl-matrix';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../depth_mode.ts';
import {StencilMode} from '../stencil_mode.ts';
import {ColorMode} from '../color_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {UBO_BINDINGS, UniformBuffer, std140Layout} from '../uniform_buffer.ts';
import {SHADOW_MAP_TEXTURE_UNIT, fillExtrusionUniformValues, type FillExtrusionUniformsType, type ShadowGroundUniformsType} from '../program/fill_extrusion_program.ts';
import {EXTENT} from '../../data/extent.ts';
import {translatePosition, type Mat4f32} from '../../util/util.ts';
import {isFillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer.ts';
import {MercatorShaderVariantKey} from '../../geo/projection/mercator_projection.ts';
import {getCameraMath} from '../../camera/camera_math_factory.ts';

import type {Painter} from '../../render/painter.ts';
import type {FrameRenderContext} from '../../render/frame_render_context.ts';
import type {Style} from '../../style/style.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';
import type {RendererProjectionData} from '../../geo/projection/projection_data.ts';
import type {UniformValues} from '../uniform_binding.ts';
import type {FillExtrusionBucket} from '../../data/bucket/fill_extrusion_bucket.ts';

const SHADOW_MAP_SIZE = 2048;
/** Height in meters up to which extrusions lie in front of the light's near plane. */
const MAX_CASTER_HEIGHT = 1000;
/** Polar angle in degrees beyond which the light stops lowering, so that shadows keep a finite length. */
const MAX_POLAR_ANGLE = 80;
/** Defines that compile a program as a shadow receiver. */
export const SHADOW_DEFINES: string[] = ['#define SHADOWS', `#define SHADOW_MAP_SIZE ${SHADOW_MAP_SIZE}.0`];
/** Defines that compile `fillExtrusion` as a depth-only shadow caster. */
const SHADOW_CASTER_DEFINES: string[] = ['#define SHADOW_CASTER'];
const layout = std140Layout([{name: 'u_shadow_matrix', type: 'mat4'}, {name: 'u_shadow_params', type: 'vec4'}]);
const VIEWPORT: [number, number, number, number] = [0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE];
const CLEAR_DEPTH = {depth: 1};
const DEPTH_MODE = new DepthMode(0x0203 /* LEQUAL */, DepthMode.ReadWrite, [0, 1]);
/** `ZERO, SRC_COLOR`: multiplies the ground by the remaining light factor. */
const GROUND_SHADOW_COLOR_MODE = new ColorMode([0x0000, 0x0300], Color.transparent, [true, true, true, true]);
const NO_TRANSLATE: [number, number] = [0, 0];
const GROUND_UNIFORMS: UniformValues<ShadowGroundUniformsType> = {'u_shadow_map': SHADOW_MAP_TEXTURE_UNIT};
const quad = new Float64Array(16);

/** @internal The depth texture the light renders fill-extrusions into, and the matrices that project into it. */
export type ShadowMap = {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    uniformBuffer: UniformBuffer;
    /** The camera matrix and light the matrices below were computed for. */
    cameraMatrix: mat4;
    azimuth: number;
    polar: number;
    anchor: string;
    /** Projects x and y in world pixels, and z in meters, into the light's clip space. */
    lightMatrix: mat4;
    /** Project a quad spanning 0..1 that covers the shadow map on the ground onto the screen, and into the light's clip space. */
    ground: RendererProjectionData;
    groundShadowMatrix: Mat4f32;
    caster: RendererProjectionData;
    casterUniforms: UniformValues<FillExtrusionUniformsType>;
    /** Vertex array keys of the caster pass, apart from the receivers' so that neither rebinds the other's. */
    casterVaoKeys: Record<string, string>;
};

/** Returns a shadow map, or null when the GPU cannot render into a depth texture. */
function createShadowMap({context, projectedCamera, data}: FrameRenderContext): ShadowMap | null {
    const gl = context.gl;
    const texture = gl.createTexture();
    context.bindTexture.set(texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT16, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    const framebuffer = gl.createFramebuffer();
    context.bindFramebuffer.set(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        return null;
    }
    const cameraMath = getCameraMath(projectedCamera);
    return {
        texture,
        framebuffer,
        uniformBuffer: new UniformBuffer(context, UBO_BINDINGS.ShadowUBO, layout),
        cameraMatrix: new Float64Array(16),
        azimuth: 0,
        polar: 0,
        anchor: '',
        lightMatrix: new Float64Array(16),
        ground: cameraMath.getProjectionData(projectedCamera, {overscaledTileID: null}),
        groundShadowMatrix: new Float32Array(16),
        caster: cameraMath.getProjectionData(projectedCamera, {overscaledTileID: null}),
        casterUniforms: fillExtrusionUniformValues(projectedCamera, data.light, false, NO_TRANSLATE, 0, 0),
        casterVaoKeys: {},
    };
}

export function destroyShadowMap(painter: Painter): void {
    if (!painter.shadowMap) return;
    painter.context.gl.deleteFramebuffer(painter.shadowMap.framebuffer);
    painter.context.gl.deleteTexture(painter.shadowMap.texture);
    painter.shadowMap.uniformBuffer.destroy();
    painter.shadowMap = null;
}

/**
 * Renders the visible fill-extrusions into the shadow map from the light and returns it, or null when nothing casts a shadow
 * or the map is not mercator without terrain. Slope-scaled depth bias: Microsoft, "Common Techniques to Improve Shadow Depth Maps".
 */
export function drawShadowMap(painter: Painter, style: Style, coordsBySource: Record<string, OverscaledTileID[]>, frameRenderContext: FrameRenderContext): ShadowMap | null {
    const {context, projectedCamera, data, terrain} = frameRenderContext;
    const gl = context.gl;
    const light = data.light;
    const intensity = light?.['shadow-intensity'] ?? 0;
    if (!intensity) destroyShadowMap(painter);
    if (!intensity || !light.intensity || light.position[2] >= 90 || terrain || data.isRenderingGlobe || data.projectionShaderVariant?.name !== MercatorShaderVariantKey || painter.shadowsUnsupported) return null;
    let shadowMap: ShadowMap | null = null;
    for (const layerId of style._order) {
        const layer = style._layers[layerId];
        const coords = coordsBySource[layer.source];
        if (!isFillExtrusionStyleLayer(layer) || layer.isHidden(projectedCamera.zoom) || !coords?.length || layer.paint.get('fill-extrusion-opacity').constantOr(1) === 0) continue;

        if (!shadowMap) {
            shadowMap = painter.shadowMap ??= createShadowMap(frameRenderContext);
            painter.shadowsUnsupported = !shadowMap;
            if (!shadowMap) return null;
            updateLightMatrix(shadowMap, frameRenderContext);
            const direct = light.intensity * Math.max(0, Math.cos(light.position[2] * Math.PI / 180));
            const ambientColor = light['ambient-color'];
            const ambientIntensity = light['ambient-intensity'];
            const offset = layout.offsets.u_shadow_params;
            const pending = shadowMap.uniformBuffer.pending;
            pending[offset] = direct / Math.max(ambientColor.r * ambientIntensity + direct, 1e-4);
            pending[offset + 1] = direct / Math.max(ambientColor.g * ambientIntensity + direct, 1e-4);
            pending[offset + 2] = direct / Math.max(ambientColor.b * ambientIntensity + direct, 1e-4);
            pending[offset + 3] = intensity;
            context.bindFramebuffer.set(shadowMap.framebuffer);
            context.viewport.set(VIEWPORT);
            context.clear(CLEAR_DEPTH);
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(2, 4);
        }
        const translate = layer.paint.get('fill-extrusion-translate');
        const vaoKey = shadowMap.casterVaoKeys[layer.id] ??= `${layer.id}/shadow`;
        for (const coord of coords) {
            const tile = style.tileManagers[layer.source].getTile(coord);
            const bucket = tile.getBucket(layer) as FillExtrusionBucket;
            if (!bucket) continue;
            const programConfiguration = bucket.programConfigurations.get(layer.id);
            setTileShadowMatrix(shadowMap.caster.mainMatrix, 0, shadowMap.lightMatrix, coord, projectedCamera.worldSize);
            shadowMap.casterUniforms.u_fill_translate = translate[0] || translate[1] ? translatePosition(projectedCamera, tile, translate, layer.paint.get('fill-extrusion-translate-anchor')) : NO_TRANSLATE;
            frameRenderContext.useProgram('fillExtrusion', programConfiguration, false, SHADOW_CASTER_DEFINES).draw(context, gl.TRIANGLES, DEPTH_MODE, StencilMode.disabled,
                ColorMode.disabled, CullFaceMode.frontCCW, shadowMap.casterUniforms, null, shadowMap.caster, vaoKey,
                bucket.layoutVertexBuffer, bucket.indexBuffer, bucket.segments, layer.paint, projectedCamera.zoom, programConfiguration);
        }
    }
    if (shadowMap) gl.disable(gl.POLYGON_OFFSET_FILL);
    return shadowMap;
}

/** Darkens the ground drawn so far where it lies in shadow, removing only the directional light's share. */
export function drawGroundShadow(painter: Painter, frameRenderContext: FrameRenderContext, depthTest: boolean = false): void {
    const {context, shadowMap} = frameRenderContext;
    shadowMap.uniformBuffer.pending.set(shadowMap.groundShadowMatrix, layout.offsets.u_shadow_matrix);
    bindShadowMap(frameRenderContext);
    const depthMode = depthTest ? new DepthMode(context.gl.LESS, DepthMode.ReadOnly, frameRenderContext.depthRangeFor3D) : DepthMode.disabled;
    frameRenderContext.useProgram('shadowGround', null, false, SHADOW_DEFINES).draw(context, context.gl.TRIANGLES, depthMode,
        StencilMode.disabled, GROUND_SHADOW_COLOR_MODE, CullFaceMode.disabled, GROUND_UNIFORMS, null, shadowMap.ground,
        'shadowGround', painter.viewportBuffer, painter.quadTriangleIndexBuffer, painter.viewportSegments);
}

/** Binds the shadow map for the tile a shadow receiver draws next. */
export function setShadowTile(frameRenderContext: FrameRenderContext, tileID: OverscaledTileID): void {
    const shadowMap = frameRenderContext.shadowMap;
    setTileShadowMatrix(shadowMap.uniformBuffer.pending, layout.offsets.u_shadow_matrix, shadowMap.lightMatrix, tileID, frameRenderContext.projectedCamera.worldSize);
    bindShadowMap(frameRenderContext);
}

function bindShadowMap({context, shadowMap}: FrameRenderContext): void {
    shadowMap.uniformBuffer.upload();
    context.activeTexture.set(context.gl.TEXTURE0 + SHADOW_MAP_TEXTURE_UNIT);
    context.gl.bindTexture(context.gl.TEXTURE_2D, shadowMap.texture);
}

/** Writes the light matrix multiplied by the matrix that places tile coordinates in world pixels. */
function setTileShadowMatrix(out: Float32Array, offset: number, lightMatrix: mat4, tileID: OverscaledTileID, worldSize: number): void {
    const {x, y, z} = tileID.canonical;
    const tileSize = worldSize / Math.pow(2, z);
    const tileX = (x + tileID.wrap * Math.pow(2, z)) * tileSize;
    for (let i = 0; i < 4; i++) {
        out[offset + i] = lightMatrix[i] * tileSize / EXTENT;
        out[offset + 4 + i] = lightMatrix[4 + i] * tileSize / EXTENT;
        out[offset + 8 + i] = lightMatrix[8 + i];
        out[offset + 12 + i] = lightMatrix[i] * tileX + lightMatrix[4 + i] * y * tileSize + lightMatrix[12 + i];
    }
}

/**
 * Fits an orthographic light to a ground square aligned with its azimuth that moves ahead of the map center as the camera pitches,
 * unless neither changed.
 */
function updateLightMatrix(shadowMap: ShadowMap, {projectedCamera, data: {light}}: FrameRenderContext): void {
    const [, azimuth, polar] = light.position;
    if (mat4.exactEquals(shadowMap.cameraMatrix, projectedCamera.modelViewProjectionMatrix) &&
        azimuth === shadowMap.azimuth && polar === shadowMap.polar && light.anchor === shadowMap.anchor) return;
    mat4.copy(shadowMap.cameraMatrix, projectedCamera.modelViewProjectionMatrix);
    shadowMap.azimuth = azimuth;
    shadowMap.polar = polar;
    shadowMap.anchor = light.anchor;
    const sinPitch = Math.sin(projectedCamera.pitchInRadians);
    const bearing = projectedCamera.bearingInRadians;
    const radius = Math.hypot(projectedCamera.width, projectedCamera.height) / 2 * (1 + sinPitch);
    const ahead = (projectedCamera.cameraToCenterDistance + radius / 2) * sinPitch;
    const centerX = projectedCamera.cameraPosition[0] + Math.sin(bearing) * ahead;
    const centerY = projectedCamera.cameraPosition[1] - Math.cos(bearing) * ahead;
    const theta = azimuth * Math.PI / 180 + (light.anchor === 'viewport' ? bearing : 0);
    const phi = Math.min(polar, MAX_POLAR_ANGLE) * Math.PI / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const lightX = Math.sin(theta);
    const lightY = -Math.cos(theta);
    const metersToPixels = projectedCamera.pixelsPerMeter;
    const distance = radius * sinPhi + MAX_CASTER_HEIGHT * metersToPixels * cosPhi;
    const far = distance + radius * sinPhi;
    const k = 2 * sinPhi / far;
    const centerAlongLight = lightX * centerX + lightY * centerY;
    const lightMatrix = mat4.set(shadowMap.lightMatrix,
        lightY / radius, lightX / radius, -k * lightX, 0,
        -lightX / radius, lightY / radius, -k * lightY, 0,
        0, -Math.tan(phi) * metersToPixels / radius, -2 * cosPhi * metersToPixels / far, 0,
        (lightX * centerY - lightY * centerX) / radius, -centerAlongLight / radius, k * centerAlongLight + 2 * distance / far - 1, 1);
    mat4.set(quad,
        2 * radius * lightY, -2 * radius * lightX, 0, 0,
        2 * radius * lightX, 2 * radius * lightY, 0, 0,
        0, 0, 1, 0,
        centerX - radius * (lightX + lightY), centerY + radius * (lightX - lightY), 0, 1);
    mat4.multiply(shadowMap.ground.mainMatrix, projectedCamera.modelViewProjectionMatrix, quad);
    mat4.multiply(shadowMap.groundShadowMatrix, lightMatrix, quad);
}
