layout(location = 0) in vec2 a_pos;

uniform mat4 u_inv_proj_matrix;
uniform float u_sky_min_y;

out vec3 v_view_direction;

void main() {
    vec2 pos = vec2(a_pos.x, a_pos.y < 0.0 ? u_sky_min_y : a_pos.y);
    v_view_direction = (u_inv_proj_matrix * vec4(pos, 0.0, 1.0)).xyz;
    gl_Position = vec4(pos, 1.0, 1.0);
}
