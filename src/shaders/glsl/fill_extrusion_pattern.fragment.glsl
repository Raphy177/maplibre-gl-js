uniform vec2 u_texsize;
uniform float u_fade;

uniform sampler2D u_image;

in vec2 v_pos_a;
in vec2 v_pos_b;

#ifdef SHADOWS
    uniform highp vec3 u_lightcolor;
    in mediump vec3 v_ambient;
    in mediump vec3 v_direct;
    in lowp float v_opacity;
#else
    in vec4 v_lighting;
#endif

#pragma maplibre: define lowp float base
#pragma maplibre: define lowp float height
#pragma maplibre: define lowp vec4 pattern_from
#pragma maplibre: define lowp vec4 pattern_to
#pragma maplibre: define lowp float pixel_ratio_from
#pragma maplibre: define lowp float pixel_ratio_to

void main() {
    #pragma maplibre: initialize lowp float base
    #pragma maplibre: initialize lowp float height
    #pragma maplibre: initialize mediump vec4 pattern_from
    #pragma maplibre: initialize mediump vec4 pattern_to
    #pragma maplibre: initialize lowp float pixel_ratio_from
    #pragma maplibre: initialize lowp float pixel_ratio_to

    vec2 pattern_tl_a = pattern_from.xy;
    vec2 pattern_br_a = pattern_from.zw;
    vec2 pattern_tl_b = pattern_to.xy;
    vec2 pattern_br_b = pattern_to.zw;

    vec2 imagecoord = mod(v_pos_a, 1.0);
    vec2 pos = mix(pattern_tl_a / u_texsize, pattern_br_a / u_texsize, imagecoord);
    vec4 color1 = texture(u_image, pos);

    vec2 imagecoord_b = mod(v_pos_b, 1.0);
    vec2 pos2 = mix(pattern_tl_b / u_texsize, pattern_br_b / u_texsize, imagecoord_b);
    vec4 color2 = texture(u_image, pos2);

    vec4 mixedColor = mix(color1, color2, u_fade);

    #ifdef SHADOWS
        vec3 lit = clamp(v_ambient + v_direct * (1.0 - shadow_darkening()), mix(vec3(0.0), vec3(0.3), 1.0 - u_lightcolor), vec3(1.0));
        fragColor = mixedColor * vec4(lit, 1.0) * v_opacity;
    #else
        fragColor = mixedColor * v_lighting;
    #endif

    #ifdef OVERDRAW_INSPECTOR
        fragColor = vec4(1.0);
    #endif
}
