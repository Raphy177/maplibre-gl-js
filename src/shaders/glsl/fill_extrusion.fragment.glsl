#if defined(WALL_AMBIENT_OCCLUSION) || defined(SHADOWS)
    #define LIGHT_PER_FRAGMENT
#endif

#ifdef LIGHT_PER_FRAGMENT
    uniform highp vec3 u_lightcolor;
    in mediump vec3 v_ambient;
    in mediump vec3 v_direct;
    in lowp float v_opacity;
#else
    in vec4 v_color;
#endif

#ifdef WALL_AMBIENT_OCCLUSION
    uniform lowp float u_ao_wall_intensity;
    in mediump float v_ao_wall_height;
#endif

void main() {
    #ifdef SHADOW_CASTER
        fragColor = vec4(1.0);
    #else
        #ifdef LIGHT_PER_FRAGMENT
            float ao = 1.0;
            #ifdef WALL_AMBIENT_OCCLUSION
                // (1 - s)^1.5 approximates the share of ambient light the ground blocks within the radius.
                if (v_ao_wall_height < 1.0) {
                    float oneMinusS = 1.0 - max(v_ao_wall_height, 0.0);
                    ao -= u_ao_wall_intensity * oneMinusS * sqrt(oneMinusS);
                }
            #endif

            vec3 lit = clamp(v_ambient * ao + v_direct * (1.0 - shadow_darkening()), 0.3 * (1.0 - u_lightcolor), vec3(1.0));
            fragColor = vec4(lit, 1.0) * v_opacity;
        #else
            fragColor = v_color;
        #endif

        #ifdef FOG
            fragColor = apply_fog(fragColor);
        #endif

        #ifdef OVERDRAW_INSPECTOR
            fragColor = vec4(1.0);
        #endif
    #endif
}
