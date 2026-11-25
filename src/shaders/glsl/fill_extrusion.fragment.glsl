#ifdef SHADOWS
    uniform highp vec3 u_lightcolor;
    in mediump vec3 v_ambient;
    in mediump vec3 v_direct;
    in lowp float v_opacity;
#else
    in vec4 v_color;
#endif

void main() {
    #ifdef SHADOW_CASTER
        fragColor = vec4(1.0);
    #else
        #ifdef SHADOWS
            vec3 lit = clamp(v_ambient + v_direct * (1.0 - shadow_darkening()), 0.3 * (1.0 - u_lightcolor), vec3(1.0));
            fragColor = vec4(lit, 1.0) * v_opacity;
        #else
            fragColor = v_color;
        #endif

        #ifdef OVERDRAW_INSPECTOR
            fragColor = vec4(1.0);
        #endif
    #endif
}
