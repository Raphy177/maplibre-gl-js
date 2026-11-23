in vec4 v_color;

void main() {
    fragColor = v_color;

    #ifdef FOG
        fragColor = apply_fog(fragColor);
    #endif

    #ifdef OVERDRAW_INSPECTOR
        fragColor = vec4(1.0);
    #endif
}
