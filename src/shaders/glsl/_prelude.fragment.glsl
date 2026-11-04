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
