import {beforeEach, describe, expect, test, vi, type Mock} from 'vitest';
import {createMap, beforeMapTest} from '../../util/test/util.ts';

import type {LightSpecification, ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Map} from '../map.ts';

beforeEach(() => {
    beforeMapTest();
    global.fetch = null;
});

describe('shadows', () => {
    test('cost no draw calls, programs, textures or framebuffers while shadow-intensity is 0', async () => {
        const withoutLight = await createBuildingsMap(undefined);
        const withShadowsOff = await createBuildingsMap({'shadow-intensity': 0});
        const gl = glOf(withShadowsOff);

        expect(glUsage(withShadowsOff)).toEqual(glUsage(withoutLight));
        expect(gl.createFramebuffer).not.toHaveBeenCalled();
        expect(gl.texStorage2D).not.toHaveBeenCalledWith(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT16, expect.anything(), expect.anything());
        expect(shaderSources(withShadowsOff)).not.toContainEqual(expect.stringContaining('#define SHADOWS'));
    });

    test('cast the extrusion tile into a depth texture, then darken extrusions and the ground', async () => {
        const off = glUsage(await createBuildingsMap({'shadow-intensity': 0}));
        const withShadows = await createBuildingsMap({'shadow-intensity': 0.5});
        const gl = glOf(withShadows);

        expect(glUsage(withShadows)).toEqual({draws: off.draws + 2, programs: off.programs + 2, textures: off.textures + 1, framebuffers: off.framebuffers + 1});
        expect(gl.texStorage2D).toHaveBeenCalledWith(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT16, 2048, 2048);
        expect(shaderSources(withShadows)).toContainEqual(expect.stringContaining('#define SHADOWS'));
    });

    test('free the shadow map when shadow-intensity returns to 0', async () => {
        const map = await createBuildingsMap({'shadow-intensity': 0.5});
        const gl = glOf(map);
        const framebuffer = gl.createFramebuffer.mock.results[0].value;
        const texture = gl.framebufferTexture2D.mock.calls[0][3];
        const drawsWithShadows = drawCallsOfFrame(map);

        map.setLight({'shadow-intensity': 0});
        await map.once('idle');

        expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
        expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
        expect(drawCallsOfFrame(map)).toBe(drawsWithShadows - 2);
    });

    test('are not drawn on the globe', async () => {
        const map = await createBuildingsMap({'shadow-intensity': 0.5}, {type: 'globe'});

        expect(glOf(map).createFramebuffer).not.toHaveBeenCalled();
    });

    test('stay disabled without retrying when the GPU cannot render into the depth texture', async () => {
        failFramebufferCompleteness();
        const map = await createBuildingsMap({'shadow-intensity': 0.5});
        const gl = glOf(map);

        map.redraw();

        expect(gl.createFramebuffer).toHaveBeenCalledTimes(1);
        expect(gl.deleteFramebuffer).toHaveBeenCalledWith(gl.createFramebuffer.mock.results[0].value);
        expect(shaderSources(map)).not.toContainEqual(expect.stringContaining('#define SHADOWS'));
    });
});

type NullGL = {[K in keyof WebGL2RenderingContext]: WebGL2RenderingContext[K] extends (...args: any[]) => any ? Mock<WebGL2RenderingContext[K]> : WebGL2RenderingContext[K]};

/** The draw calls of one frame, and everything the map has created on the GPU since it was constructed. */
type GLUsage = {draws: number; programs: number; textures: number; framebuffers: number};

async function createBuildingsMap(light: LightSpecification | undefined, projection?: ProjectionSpecification): Promise<Map> {
    const building: GeoJSON.Feature = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]]}};
    const map = createMap({style: {
        version: 8,
        sources: {buildings: {type: 'geojson', data: building}},
        layers: [{id: 'buildings', type: 'fill-extrusion', source: 'buildings', paint: {'fill-extrusion-height': 100000}}],
        light,
        projection
    }});
    await map.once('idle');
    return map;
}

function failFramebufferCompleteness(): void {
    const getContext = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: Parameters<typeof getContext>) {
        const context = getContext.apply(this, args);
        if (args[0] === 'webgl2') (context as NullGL).checkFramebufferStatus.mockReturnValue(0);
        return context;
    });
}

function glOf(map: Map): NullGL {
    return map.painter.context.gl as unknown as NullGL;
}

function drawCallsOfFrame(map: Map): number {
    const drawElements = glOf(map).drawElements;
    const before = drawElements.mock.calls.length;
    map.redraw();
    return drawElements.mock.calls.length - before;
}

function glUsage(map: Map): GLUsage {
    const gl = glOf(map);
    return {
        draws: drawCallsOfFrame(map),
        programs: gl.createProgram.mock.calls.length,
        textures: gl.createTexture.mock.calls.length,
        framebuffers: gl.createFramebuffer.mock.calls.length
    };
}

function shaderSources(map: Map): string[] {
    return glOf(map).shaderSource.mock.calls.map(([, source]) => source);
}
