in highp float v_depth;

void main() {
    fragColor = fog_color(v_depth);
}
