import {patternUniformValues} from './pattern.ts';
import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    Uniform3f
} from '../uniform_binding.ts';
import {mat3, vec3} from 'gl-matrix';
import {extend, sphericalToCartesian} from '../../util/util.ts';

import type {Context} from '../../webgl/context.ts';
import type {IReadonlyTransform} from '../../geo/transform_interface.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';
import type {UniformValues, UniformLocations} from '../uniform_binding.ts';
import type {CrossfadeParameters} from '../../style/evaluation_parameters.ts';
import type {Tile} from '../../tile/tile.ts';
import type {LightPropsPossiblyEvaluated} from '../../style/light_properties.g.ts';

export type FillExtrusionUniformsType = {
    'u_lightpos': Uniform3f;
    'u_lightpos_globe': Uniform3f;
    'u_lightintensity': Uniform1f;
    'u_lightcolor': Uniform3f;
    'u_vertical_gradient': Uniform1f;
    'u_opacity': Uniform1f;
    'u_fill_translate': Uniform2f;
};

export type FillExtrusionPatternUniformsType = {
    'u_lightpos': Uniform3f;
    'u_lightpos_globe': Uniform3f;
    'u_lightintensity': Uniform1f;
    'u_lightcolor': Uniform3f;
    'u_height_factor': Uniform1f;
    'u_vertical_gradient': Uniform1f;
    'u_opacity': Uniform1f;
    'u_fill_translate': Uniform2f;
    // pattern uniforms:
    'u_texsize': Uniform2f;
    'u_image': Uniform1i;
    'u_pixel_coord_upper': Uniform2f;
    'u_pixel_coord_lower': Uniform2f;
    'u_scale': Uniform3f;
    'u_fade': Uniform1f;
};

export type FillExtrusionShadowUniformsType = {
    'u_fill_translate': Uniform2f;
    'u_shadow_offset': Uniform2f;
    'u_shadow_darkness': Uniform1f;
};

/** The longest shadow, as a multiple of the caster's height: `tan(80°)`. */
const MAX_SHADOW_LENGTH = 5.67;

/** Shadows fade out over this many degrees above the horizon. */
const SHADOW_HORIZON_FADE = 10;

const fillExtrusionUniforms = (context: Context, locations: UniformLocations): FillExtrusionUniformsType => ({
    'u_lightpos': new Uniform3f(context, locations.u_lightpos),
    'u_lightpos_globe': new Uniform3f(context, locations.u_lightpos_globe),
    'u_lightintensity': new Uniform1f(context, locations.u_lightintensity),
    'u_lightcolor': new Uniform3f(context, locations.u_lightcolor),
    'u_vertical_gradient': new Uniform1f(context, locations.u_vertical_gradient),
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_fill_translate': new Uniform2f(context, locations.u_fill_translate),
});

const fillExtrusionPatternUniforms = (context: Context, locations: UniformLocations): FillExtrusionPatternUniformsType => ({
    'u_lightpos': new Uniform3f(context, locations.u_lightpos),
    'u_lightpos_globe': new Uniform3f(context, locations.u_lightpos_globe),
    'u_lightintensity': new Uniform1f(context, locations.u_lightintensity),
    'u_lightcolor': new Uniform3f(context, locations.u_lightcolor),
    'u_vertical_gradient': new Uniform1f(context, locations.u_vertical_gradient),
    'u_height_factor': new Uniform1f(context, locations.u_height_factor),
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_fill_translate': new Uniform2f(context, locations.u_fill_translate),
    // pattern uniforms
    'u_image': new Uniform1i(context, locations.u_image),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_pixel_coord_upper': new Uniform2f(context, locations.u_pixel_coord_upper),
    'u_pixel_coord_lower': new Uniform2f(context, locations.u_pixel_coord_lower),
    'u_scale': new Uniform3f(context, locations.u_scale),
    'u_fade': new Uniform1f(context, locations.u_fade)
});

const fillExtrusionShadowUniforms = (context: Context, locations: UniformLocations): FillExtrusionShadowUniformsType => ({
    'u_fill_translate': new Uniform2f(context, locations.u_fill_translate),
    'u_shadow_offset': new Uniform2f(context, locations.u_shadow_offset),
    'u_shadow_darkness': new Uniform1f(context, locations.u_shadow_darkness),
});

/** Returns the direction towards the light in tile coordinates. A light anchored to the viewport turns with the camera. */
function lightDirection(transform: IReadonlyTransform, light: Readonly<LightPropsPossiblyEvaluated>): vec3 {
    const lightPos = sphericalToCartesian(light.position);
    const lightMat = mat3.create();
    if (light.anchor === 'viewport') {
        mat3.fromRotation(lightMat, transform.bearingInRadians);
    }
    return vec3.transformMat3(lightPos, lightPos, lightMat);
}

/**
 * Returns the shadow a layer casts onto the ground, or null if none.
 *
 * `offset` is where the shadow of a point one meter high lies relative to its foot, in meters along the tile
 * axes: `tan(polar)` long, capped at {@link MAX_SHADOW_LENGTH}. `darkness` is the fraction of brightness the
 * shadowed ground loses, matching how much the extrusion shader darkens a wall facing away from the light
 * compared with a roof.
 * @param opacity - `fill-extrusion-opacity` of the casting layer
 */
function groundShadowParameters(
    transform: IReadonlyTransform,
    light: Readonly<LightPropsPossiblyEvaluated>,
    opacity: number
): {offset: [number, number]; darkness: number} | null {
    const polar = light.position[2];
    const fade = Math.min(1, (90 - polar) / SHADOW_HORIZON_FADE);
    const [x, y, z] = lightDirection(transform, light);
    const roof = light.intensity * Math.min(1, Math.max(0, z));
    const lit = 1 - light.intensity + roof;
    const darkness = lit > 0 && fade > 0 ? light['shadow-intensity'] * opacity * fade * roof / lit : 0;
    if (darkness === 0) return null;

    const horizontal = Math.hypot(x, y);
    const scale = horizontal > 0 ? Math.min(MAX_SHADOW_LENGTH, Math.tan(polar * Math.PI / 180)) / horizontal : 0;
    return {offset: [x * scale, y * scale], darkness};
}

const fillExtrusionUniformValues = (
    transform: IReadonlyTransform,
    light: Readonly<LightPropsPossiblyEvaluated>,
    shouldUseVerticalGradient: boolean,
    opacity: number,
    translate: [number, number],
): UniformValues<FillExtrusionUniformsType> => {
    const lightPos = lightDirection(transform, light);
    const transformedLightPos = transform.transformLightDirection(lightPos);

    const lightColor = light.color;

    return {
        'u_lightpos': lightPos,
        'u_lightpos_globe': transformedLightPos,
        'u_lightintensity': light.intensity,
        'u_lightcolor': [lightColor.r, lightColor.g, lightColor.b],
        'u_vertical_gradient': +shouldUseVerticalGradient,
        'u_opacity': opacity,
        'u_fill_translate': translate,
    };
};

const fillExtrusionPatternUniformValues = (
    transform: IReadonlyTransform,
    light: Readonly<LightPropsPossiblyEvaluated>,
    shouldUseVerticalGradient: boolean,
    opacity: number,
    translate: [number, number],
    coord: OverscaledTileID,
    crossfade: CrossfadeParameters,
    tile: Tile
): UniformValues<FillExtrusionPatternUniformsType> => {
    return extend(fillExtrusionUniformValues(transform, light, shouldUseVerticalGradient, opacity, translate),
        patternUniformValues(crossfade, transform, tile),
        {
            'u_height_factor': -Math.pow(2, coord.overscaledZ) / tile.tileSize / 8
        });
};

export {
    fillExtrusionUniforms,
    fillExtrusionPatternUniforms,
    fillExtrusionShadowUniforms,
    fillExtrusionUniformValues,
    fillExtrusionPatternUniformValues,
    groundShadowParameters
};
