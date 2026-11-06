import {mat4} from 'gl-matrix';
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
const layout = std140Layout([{name: 'u_shadow_matrix', type: 'mat4'}, {name: 'u_shadow_intensity', type: 'float'}]);
const VIEWPORT: [number, number, number, number] = [0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE];
const CLEAR_DEPTH = {depth: 1};
const DEPTH_MODE = new DepthMode(0x0203 /* LEQUAL */, DepthMode.ReadWrite, [0, 1]);
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
function createShadowMap({context, transform, data}: FrameRenderContext): ShadowMap | null {
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
    return {
        texture,
        framebuffer,
        uniformBuffer: new UniformBuffer(context, UBO_BINDINGS.ShadowUBO, layout),
        cameraMatrix: new Float64Array(16),
        azimuth: 0,
        polar: 0,
        anchor: '',
        lightMatrix: new Float64Array(16),
        ground: transform.getProjectionData({overscaledTileID: null}),
        groundShadowMatrix: new Float32Array(16),
        caster: transform.getProjectionData({overscaledTileID: null}),
        casterUniforms: fillExtrusionUniformValues(transform, data.light, false, 1, NO_TRANSLATE),
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
    const {context, transform, data, terrain} = frameRenderContext;
    const gl = context.gl;
    const intensity = data.light?.['shadow-intensity'] ?? 0;
    if (!intensity) destroyShadowMap(painter);
    if (!intensity || terrain || data.isRenderingGlobe || data.projectionShaderVariant?.name !== MercatorShaderVariantKey || painter.shadowsUnsupported) return null;
    let shadowMap: ShadowMap | null = null;
    for (const layerId of style._order) {
        const layer = style._layers[layerId];
        const coords = coordsBySource[layer.source];
        if (!isFillExtrusionStyleLayer(layer) || layer.isHidden(transform.zoom) || !coords?.length || layer.paint.get('fill-extrusion-opacity') === 0) continue;

        if (!shadowMap) {
            shadowMap = painter.shadowMap ??= createShadowMap(frameRenderContext);
            painter.shadowsUnsupported = !shadowMap;
            if (!shadowMap) return null;
            updateLightMatrix(shadowMap, frameRenderContext);
            shadowMap.uniformBuffer.pending[layout.offsets.u_shadow_intensity] = intensity;
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
            setTileShadowMatrix(shadowMap.caster.mainMatrix, 0, shadowMap.lightMatrix, coord, transform.worldSize);
            shadowMap.casterUniforms.u_fill_translate = translate[0] || translate[1] ? translatePosition(transform, tile, translate, layer.paint.get('fill-extrusion-translate-anchor')) : NO_TRANSLATE;
            frameRenderContext.useProgram('fillExtrusion', programConfiguration).draw(context, gl.TRIANGLES, DEPTH_MODE, StencilMode.disabled,
                ColorMode.disabled, CullFaceMode.frontCCW, shadowMap.casterUniforms, null, shadowMap.caster, vaoKey,
                bucket.layoutVertexBuffer, bucket.indexBuffer, bucket.segments, layer.paint, transform.zoom, programConfiguration);
        }
    }
    if (shadowMap) gl.disable(gl.POLYGON_OFFSET_FILL);
    return shadowMap;
}

/** Darkens the ground drawn so far where it lies in shadow, with one quad over the area the shadow map covers. */
export function drawGroundShadow(painter: Painter, frameRenderContext: FrameRenderContext): void {
    const {context, shadowMap} = frameRenderContext;
    shadowMap.uniformBuffer.pending.set(shadowMap.groundShadowMatrix, layout.offsets.u_shadow_matrix);
    bindShadowMap(frameRenderContext);
    frameRenderContext.useProgram('shadowGround', null, false, SHADOW_DEFINES).draw(context, context.gl.TRIANGLES, DepthMode.disabled,
        StencilMode.disabled, ColorMode.alphaBlended, CullFaceMode.disabled, GROUND_UNIFORMS, null, shadowMap.ground,
        'shadowGround', painter.viewportBuffer, painter.quadTriangleIndexBuffer, painter.viewportSegments);
}

/** Binds the shadow map for the tile a shadow receiver draws next. */
export function setShadowTile(frameRenderContext: FrameRenderContext, tileID: OverscaledTileID): void {
    const shadowMap = frameRenderContext.shadowMap;
    setTileShadowMatrix(shadowMap.uniformBuffer.pending, layout.offsets.u_shadow_matrix, shadowMap.lightMatrix, tileID, frameRenderContext.transform.worldSize);
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
function updateLightMatrix(shadowMap: ShadowMap, {transform, data: {light}}: FrameRenderContext): void {
    const [, azimuth, polar] = light.position;
    if (mat4.exactEquals(shadowMap.cameraMatrix, transform.modelViewProjectionMatrix) &&
        azimuth === shadowMap.azimuth && polar === shadowMap.polar && light.anchor === shadowMap.anchor) return;
    mat4.copy(shadowMap.cameraMatrix, transform.modelViewProjectionMatrix);
    shadowMap.azimuth = azimuth;
    shadowMap.polar = polar;
    shadowMap.anchor = light.anchor;
    const sinPitch = Math.sin(transform.pitchInRadians);
    const bearing = transform.bearingInRadians;
    const radius = Math.hypot(transform.width, transform.height) / 2 * (1 + sinPitch);
    const ahead = (transform.cameraToCenterDistance + radius / 2) * sinPitch;
    const centerX = transform.cameraPosition[0] + Math.sin(bearing) * ahead;
    const centerY = transform.cameraPosition[1] - Math.cos(bearing) * ahead;
    const theta = azimuth * Math.PI / 180 + (light.anchor === 'viewport' ? bearing : 0);
    const phi = Math.min(polar, MAX_POLAR_ANGLE) * Math.PI / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const lightX = Math.sin(theta);
    const lightY = -Math.cos(theta);
    const metersToPixels = transform.pixelsPerMeter;
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
    mat4.multiply(shadowMap.ground.mainMatrix, transform.modelViewProjectionMatrix, quad);
    mat4.multiply(shadowMap.groundShadowMatrix, lightMatrix, quad);
}
