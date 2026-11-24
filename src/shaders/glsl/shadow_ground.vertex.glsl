layout(location = 0) in vec2 a_pos;
out lowp vec3 v_shadow_scale;

void main() {
    gl_Position = u_projection_matrix * vec4(a_pos, 0.0, 1.0);
    set_shadow_pos(vec4(a_pos, 0.0, 1.0), vec2(0.0), 1.0);
    v_shadow_scale = u_shadow_params.rgb;
}
