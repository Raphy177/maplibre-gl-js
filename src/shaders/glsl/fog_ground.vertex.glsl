layout(location = 0) in vec2 a_pos;
out highp float v_depth;

void main() {
    vec2 pos = a_pos;
    if (abs(u_fog_ground.x) < 1e-6 && u_fog_ground.y > 1e-6) {
        float yMin = clamp((u_fog_params.x - u_fog_ground.z) / u_fog_ground.y, -1.0, 1.0);
        float yMax = clamp((1.0 - u_fog_ground.z) / u_fog_ground.y + 4.0 / u_viewport_size.y, -1.0, 1.0);
        pos.y = a_pos.y < 0.0 ? yMin : yMax;
    }
    v_depth = dot(u_fog_ground.xyz, vec3(pos, 1.0));
    gl_Position = vec4(pos, 1.0, 1.0);
}
