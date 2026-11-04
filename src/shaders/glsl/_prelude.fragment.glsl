#ifdef GL_ES
precision mediump float;
#else

#if !defined(lowp)
#define lowp
#endif

#if !defined(mediump)
#define mediump
#endif

#if !defined(highp)
#define highp
#endif

#endif

out highp vec4 fragColor;

layout(std140) uniform ProjectionUBO {
    highp mat4 u_projection_matrix;
    highp mat4 u_projection_fallback_matrix;
    highp vec4 u_projection_tile_mercator_coords;
    highp vec4 u_projection_clipping_plane;
    highp float u_projection_transition;
    highp int u_projection_clip_antimeridian;
};
layout(std140) uniform FrameUBO {
    highp vec2 u_units_to_pixels;
    highp vec2 u_world_size;
    highp float u_camera_to_center_distance;
    highp float u_symbol_fade_change;
    highp float u_aspect_ratio;
    highp float u_device_pixel_ratio;
    highp vec2 u_viewport_size;
    highp vec2 u_pixel_extrude_scale;
    highp float u_pitch;
};

#ifdef FOG
layout(std140) uniform FogUBO {
    highp vec4 u_fog_color;
    highp vec4 u_horizon_color;
    highp vec4 u_fog_params;
    highp vec4 u_fog_ground;
};
lowp vec4 fog_color(highp float depth) {
    lowp float horizon = smoothstep(0.0, 1.0, max((depth - u_fog_params.y) / max(1.0 - u_fog_params.y, 1e-4), 0.0));
    lowp float t = max(depth - u_fog_params.x, 0.0) / (1.0 - u_fog_params.x);
    return mix(u_fog_color, u_horizon_color, horizon) * t * t;
}
lowp vec4 apply_fog(lowp vec4 color) {
    lowp vec4 fog = fog_color(u_fog_params.z - u_fog_params.w * gl_FragCoord.w);
    return vec4(color.rgb * (1.0 - fog.a) + fog.rgb * color.a, color.a);
}
#endif

#ifdef SHADOWS
uniform highp sampler2DShadow u_shadow_map;
in highp vec3 v_shadow_pos;
in lowp float v_shadow_weight;
// Four bilinear depth comparisons half a texel apart filter 3x3 texels (GPU Gems, chapter 11), fading out at the border.
lowp float shadow_darkening() {
    highp vec3 p = v_shadow_pos;
    highp vec2 offset = vec2(0.5 / SHADOW_MAP_SIZE);
    lowp float lit = 0.25 * (
        texture(u_shadow_map, vec3(p.xy - offset, p.z)) + texture(u_shadow_map, vec3(p.xy + offset, p.z)) +
        texture(u_shadow_map, vec3(p.x - offset.x, p.y + offset.y, p.z)) + texture(u_shadow_map, vec3(p.x + offset.x, p.y - offset.y, p.z)));
    highp vec2 border = abs(p.xy - 0.5);
    return v_shadow_weight * (1.0 - lit) * (1.0 - smoothstep(0.45, 0.5, max(border.x, border.y)));
}
#else
#define shadow_darkening() 0.0
#endif
