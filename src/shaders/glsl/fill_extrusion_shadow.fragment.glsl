uniform lowp float u_shadow_darkness;

void main() {
    fragColor = vec4(vec3(1.0 - u_shadow_darkness), 1.0);
}
