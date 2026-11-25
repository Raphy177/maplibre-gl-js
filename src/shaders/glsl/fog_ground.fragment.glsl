in highp float v_depth;

void main() {
    if (v_depth > 1.0) discard;
    fragColor = fog_color(v_depth);
}
