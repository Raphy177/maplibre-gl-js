import {describe, expect, test} from 'vitest';
import {Context} from './context.ts';
import {updateFogUniformBuffer} from './fog_uniform_buffer.ts';
import {getMercatorHorizon} from '../geo/projection/mercator_utils.ts';
import {Sky} from '../style/sky.ts';
import {createNullGL} from '../util/test/null_gl.ts';
import {createFrameRenderData, createTestCamera} from '../util/test/util.ts';

import type {SkySpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../style/evaluation_parameters.ts';
import type {FrameRenderData} from '../render/frame_render_context.ts';
import type {ProjectedCamera} from '../camera/projected_camera.ts';

function createFrameData(skySpec: SkySpecification): FrameRenderData {
    const sky = new Sky(skySpec, {});
    sky.recalculate({zoom: 0, zoomHistory: {}} as EvaluationParameters);
    return {...createFrameRenderData(), sky: sky.getEvaluated(), hasFog: sky.hasFog()};
}

function createCamera(pitch: number): ProjectedCamera {
    return createTestCamera({width: 512, height: 256, zoom: 15, pitch, maxPitch: 85}).projectedCamera;
}

describe('updateFogUniformBuffer', () => {
    test('creates no buffer on a flat map whose sky sets no fog property', () => {
        const context = new Context(createNullGL());

        expect(updateFogUniformBuffer(context, createCamera(80), createFrameData({'sky-color': '#88c6fc'}), false)).toBe(false);
        expect(context.fogUniformBuffer).toBeNull();
    });

    test('draws fog with terrain even when the sky sets no fog property', () => {
        const context = new Context(createNullGL());

        expect(updateFogUniformBuffer(context, createCamera(80), createFrameData({'sky-color': '#88c6fc'}), true)).toBe(true);
    });

    test('writes the sky colors premultiplied by the fog opacity of the pitch', () => {
        const context = new Context(createNullGL());

        updateFogUniformBuffer(context, createCamera(65), createFrameData({'fog-color': 'rgba(255, 0, 0, 0.5)', 'horizon-color': '#0000ff'}), false);

        expect(Array.from(context.fogUniformBuffer.pending.subarray(0, 8))).toEqual([0.25, 0, 0, 0.25, 0, 0, 0.5, 0.5]);
    });

    test('starts the fog depth at the ground under the screen center and increases it towards the horizon', () => {
        const context = new Context(createNullGL());
        const camera = createCamera(80);

        updateFogUniformBuffer(context, camera, createFrameData({'fog-ground-blend': 0.5}), false);

        const [, , depthAtInfinity, depthPerInverseW, groundX, groundY, groundAtCenter] = context.fogUniformBuffer.pending.subarray(8, 15);
        expect(depthAtInfinity - depthPerInverseW / camera.cameraToCenterDistance).toBeCloseTo(0, 5);
        expect(groundAtCenter).toBeCloseTo(0, 5);
        expect(groundX).toBeCloseTo(0, 5);
        expect(groundY).toBeGreaterThan(0);
    });

    test('reaches fog depth 1 at the mercator horizon on a flat map even when high zoom inflates farZ', () => {
        const context = new Context(createNullGL());
        const camera = createTestCamera({width: 512, height: 256, zoom: 18, pitch: 85, maxPitch: 85}).projectedCamera;

        updateFogUniformBuffer(context, camera, createFrameData({'fog-ground-blend': 0.5}), false);

        const [groundX, groundY, groundAtCenter] = context.fogUniformBuffer.pending.subarray(12, 15);
        const horizonNdcY = (2 * getMercatorHorizon(camera)) / camera.height;
        expect(groundX).toBeCloseTo(0, 5);
        expect(groundY * horizonNdcY + groundAtCenter).toBeCloseTo(1, 5);
    });
});
