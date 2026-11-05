uniform vec2 u_fill_translate;
// Where the shadow of a point one meter high lies relative to its foot, in tile units.
uniform highp vec2 u_shadow_offset;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in ivec4 a_normal_ed;

#pragma maplibre: define highp float base
#pragma maplibre: define highp float height

// Shears the extrusion along the light onto the ground; each vertex moves by its own elevation.
void main() {
    #pragma maplibre: initialize highp float base
    #pragma maplibre: initialize highp float height

    highp float bottom = max(base, 0.0);
    if (height <= bottom) {
        gl_Position = vec4(0.0);
        return;
    }

    highp vec2 posInTile = a_pos + u_fill_translate + u_shadow_offset * ((a_normal_ed.x & 1) == 1 ? height : bottom);
    #ifdef GLOBE
        vec3 spherePos = projectToSphere(posInTile, a_pos);
        gl_Position = interpolateProjectionFor3D(posInTile, spherePos, 0.0);
    #else
        gl_Position = u_projection_matrix * vec4(posInTile, 0.0, 1.0);
    #endif
}
