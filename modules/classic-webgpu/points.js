// FIREWRAITH · classic-webgpu · point sprites and billboards for WebGPU (which draws points one pixel wide). classic draws
// its embers and sparks with gl_PointSize and its jet and steam puffs as view-space billboards; these helpers give the
// same shapes from an instanced quad (`position.xy` = the corner, ±1).
import { NodeMaterial } from 'three/webgpu';
import { vec2, vec4, float, floor, select, cos, sin, positionGeometry, cameraViewMatrix, cameraProjectionMatrix } from 'three/tsl';

/**
 * Clip position of a square point sprite of `size(viewZ)` pixels centred on a world point (classic's gl_PointSize).
 * hybrid: the centre snaps to the fire-pixel grid of `pix` px, counted from the top of the frame like the march's cells.
 * @param {{ world: any, alive: any, hybrid: boolean, res: any, pix: any, size: (viewZ: any) => any }} o
 * @returns {{ clip: any, viewZ: any }}
 */
export function pointSprite({ world, alive, hybrid, res, pix, size }) {
  const mv = cameraViewMatrix.mul(vec4(world, 1.0)).toVar();
  const viewZ = mv.z.negate().toVar();
  const c = cameraProjectionMatrix.mul(mv).toVar();
  if (hybrid) {
    const ndc = c.xy.div(c.w).toVar();
    const px = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).mul(res).toVar();
    const sn = floor(px.div(pix)).add(0.5).mul(pix).toVar();
    c.assign(vec4(vec2(sn.x.div(res.x).mul(2.0).sub(1.0), sn.y.div(res.y).mul(-2.0).add(1.0)).mul(c.w), c.z, c.w));
  }
  const s = size(viewZ);
  const out = vec4(c.xy.add(positionGeometry.xy.mul(s).div(res).mul(c.w)), c.z, c.w);
  return { clip: select(alive, out, vec4(2.0, 2.0, 2.0, 1.0)), viewZ };
}

/**
 * A view-space billboard of half-size `half` (m) round a world point, turned by `angle` (classic's jet and steam VERT:
 * mv.xy += R(angle) · position.xy · half). @returns {{ clip: any, viewZ: any }}
 */
export function billboard({ world, angle, half }) {
  const mv = cameraViewMatrix.mul(vec4(world, 1.0)).toVar();
  const ca = cos(angle).toVar(), sa = sin(angle).toVar();
  const p = positionGeometry.xy;
  const off = vec2(ca.mul(p.x).sub(sa.mul(p.y)), sa.mul(p.x).add(ca.mul(p.y))).mul(half);
  const m2 = vec4(mv.xy.add(off), mv.z, mv.w).toVar();
  return { clip: cameraProjectionMatrix.mul(m2), viewZ: mv.z.negate() };
}

/** A NodeMaterial for a sprite pass: vertex + fragment nodes, no depth, the given blending. */
export function spriteMaterial(name, vertexNode, fragmentNode, blend) {
  const m = new NodeMaterial();
  m.name = name; m.vertexNode = vertexNode; m.fragmentNode = fragmentNode;
  Object.assign(m, { depthTest: false, depthWrite: false, transparent: true, fog: false, lights: false, toneMapped: false }, blend);
  return m;
}

export const ONE = float(1.0);
