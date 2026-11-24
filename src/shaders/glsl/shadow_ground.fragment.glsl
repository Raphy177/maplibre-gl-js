in lowp vec3 v_shadow_scale;

void main() {
    fragColor = vec4(1.0 - v_shadow_scale * shadow_darkening(), 1.0);
}
