import {describe, expect, test} from 'vitest';
import {groundShadowParameters} from './fill_extrusion_program.ts';
import {Light} from '../../style/light.ts';
import {MercatorTransform} from '../../geo/projection/mercator_transform.ts';

import type {LightSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {LightPropsPossiblyEvaluated} from '../../style/light_properties.g.ts';

function evaluatedLight(light: LightSpecification): LightPropsPossiblyEvaluated {
    return new Light(light, {}).getEvaluated();
}

/** The length of the shadow of a point one meter high, in meters, with the light at `polar` degrees from the zenith. */
function shadowLengthAt(polar: number): number {
    const light = evaluatedLight({anchor: 'map', position: [1, 210, polar], 'shadow-intensity': 1});
    return Math.hypot(...groundShadowParameters(new MercatorTransform(), light, 1).offset);
}

describe('groundShadowParameters', () => {
    test('casts no shadow while the light has no shadow intensity', () => {
        const light = evaluatedLight({anchor: 'map', position: [1, 210, 30]});

        expect(groundShadowParameters(new MercatorTransform(), light, 1)).toBeNull();
    });

    test('darkens a full shadow by the ratio the light darkens a face turned away from it compared with a roof', () => {
        const light = evaluatedLight({anchor: 'map', position: [1, 210, 30], intensity: 0.5, 'shadow-intensity': 0.8});

        const shadow = groundShadowParameters(new MercatorTransform(), light, 0.5);

        const roof = 0.5 + 0.5 * Math.cos(Math.PI / 6);
        const turnedAway = 0.5;
        expect(shadow.darkness).toBeCloseTo((1 - turnedAway / roof) * 0.8 * 0.5);
    });

    test('is tan(polar) times as long as the caster is high, capped near the horizon and gone below it', () => {
        expect(shadowLengthAt(45)).toBeCloseTo(1);
        expect(shadowLengthAt(85)).toBeCloseTo(5.67);

        const light = evaluatedLight({anchor: 'map', position: [1, 210, 90], 'shadow-intensity': 1});
        expect(groundShadowParameters(new MercatorTransform(), light, 1)).toBeNull();
    });
});
