in highp vec2 v_pos;

void main() {
    highp float depth = dot(u_fog_ground.xyz, vec3(v_pos, 1.0));
    if (depth > 1.0) discard;
    fragColor = fog_color(depth);
}
