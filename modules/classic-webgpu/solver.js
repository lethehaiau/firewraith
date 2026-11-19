// FIREWRAITH · classic-webgpu · the grid solver: classic's solver.js (read its header and FLUID.md "How it works"),
// pass for pass in TSL. Fields: velocity V (xy m/s along +X/+Z, z = this step's sink), curl, divergence, pressure P, the
// scalars S = (fuel, fire, smoke, heat) and the hue mass H (S's second texture, written in the same pass: MRT).
// Per sub-step: splat ops → advect V → vorticity confinement → divergence (+ the combustion expansion and the swirl sinks)
// → Jacobi pressure (warm-started) → project → advect + react S/H. Per frame: the 64² summary and hue grids (read back)
// and the 64² light map (+ the columns' light).
// Layout: every field is a render target addressed by uv = ((x − x0) / size, (z − z0) / size); WebGPU stores targets
// top-down and a pass's uv() has y = 0 at the first row, so row j = z cell j, as in classic (the light map and the read-
// back line up with the world unchanged). The op → splat mapping is classic's own `queue()` (shared, not copied).
import {
  Mesh, Vector2, Vector3, Vector4, HalfFloatType, UnsignedByteType, LinearFilter, NearestFilter, OrthographicCamera,
  InstancedBufferAttribute, DynamicDrawUsage, CustomBlending, AddEquation, OneFactor, ZeroFactor, DoubleSide,
} from 'three/webgpu';
import {
  Fn, uv, uniform, vec2, vec4, float, If, select, min, max, clamp, mix, smoothstep, step, abs, dot, exp, length,
  attribute, varying, positionGeometry,
} from 'three/tsl';
import { FluidSolver, KNOBS, RES, LIGHT_COLS, MAX_SPLATS, buildObstacles } from '../classic/solver.js';
import { W } from './world.js';
import { makeTarget, PingPong, Quad, passMaterial, texNode, mrtOutput, clearTargets, uvToClip, instancedQuad } from '../../src/kit/webgpu/index.js';

// (DoubleSide: a quad placed by uv with WebGPU's flipped y winds the other way)
const ADD = { side: DoubleSide, blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
  blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor, depthTest: false, depthWrite: false, transparent: true };
const GAUSS = [0.227, 0.194, 0.122, 0.054, 0.016];   // the light map's 9-tap kernel (classic LIGHT_H / LIGHT_V)

export class FluidSolverGPU {
  /** @param {any} renderer a WebGPURenderer @param {keyof typeof RES} quality @param {{ noise3: any }} o */
  constructor(renderer, quality, { noise3 }) {
    this.renderer = renderer;
    this.quad = new Quad();
    this.obs = buildObstacles();
    this.wind = new Vector2(0, 0);
    this.rain = 0;
    this.lightSplats = [];
    this.time = 0; this.accum = 0; this.stepsLast = 0; this.pending = 0; this.lastJacobi = 0;
    // outputs that never change size
    this.summaryRT = makeTarget(64, 64, { type: UnsignedByteType, filter: LinearFilter });
    this.lightTmp = makeTarget(64, 64, { type: HalfFloatType });
    this.lightRT = makeTarget(64, 64, { type: HalfFloatType });
    this.hueRT = makeTarget(64, 64, { type: UnsignedByteType, filter: LinearFilter });
    // splats: the attributes classic's queue() fills (same names, same layout)
    const geo = instancedQuad();
    this.splat = {};
    for (const k of ['seg', 'shape', 'add', 'vel', 'hue']) this.splat[k] = new InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4).setUsage(DynamicDrawUsage);
    geo.setAttribute('aSeg', this.splat.seg); geo.setAttribute('aShape', this.splat.shape);
    geo.setAttribute('aAdd', this.splat.add); geo.setAttribute('aVel', this.splat.vel); geo.setAttribute('aHue', this.splat.hue);
    this.splatCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.setQuality(quality, true);
    this._build(noise3);
    this._sizes();
    this.splatMesh = new Mesh(geo, this.splatSMat);
    this.splatMesh.frustumCulled = false;
  }

  /** The materials (built once, with the real textures: each texture node is compiled for its texture's kind). */
  _build(noise3) {
    const T = this.T = {
      vel: texNode(this.V.read.texture), obs: texNode(this.obs), curl: texNode(this.curl.texture), S: texNode(this.S.read.textures[0]),
      H: texNode(this.S.read.textures[1]), P: texNode(this.P.read.texture), div: texNode(this.div.texture),
      sum: texNode(this.summaryRT.texture), hue: texNode(this.hueRT.texture), lightTmp: texNode(this.lightTmp.texture),
      src: texNode(this.V.read.texture), src2: texNode(this.S.read.textures[1]), noise: noise3.tex,
    };
    const u = this.u = {
      texV: uniform(new Vector2()), texS: uniform(new Vector2()), dt: uniform(0), decay: uniform(1), windPull: uniform(0),
      wind: uniform(this.wind), size: uniform(W.area.size), curlK: uniform(0), turb: uniform(0), time: uniform(0), expand: uniform(0),
      keep: uniform(1), ignite: uniform(0), burnRate: uniform(0), fireYield: uniform(0), fireDecay: uniform(0), smokeYield: uniform(0),
      smokeDecay: uniform(0), heatGain: uniform(0), cool: uniform(0), heatDiffuse: uniform(0), spread: uniform(0), spreadOff: uniform(0),
      stick: uniform(0), lightCols: LIGHT_COLS.map((c) => uniform(new Vector3(c[0], c[1], c[2]).multiplyScalar(1.5))),
      rect: uniform(new Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size)),
      minRS: uniform(0.2), minRV: uniform(0.3),
    };
    const solidAt = (p) => step(0.5, T.obs.sample(p).r);
    const open = (p) => float(1.0).sub(solidAt(p));

    const advectVel = Fn(() => {
      const vUv = uv();
      const v0 = T.vel.sample(vUv).toVar();
      const p = vUv.sub(v0.xy.mul(u.dt).div(u.size));
      const a = T.vel.sample(p).xy.mul(u.decay).toVar();
      a.addAssign(u.wind.sub(a).mul(min(1.0, u.windPull.mul(u.dt))));
      const e = min(vUv, vec2(1.0).sub(vUv)).toVar();
      a.assign(mix(u.wind, a, smoothstep(0.0, u.texV.x.mul(3.0), min(e.x, e.y))));
      a.mulAssign(open(vUv));
      return vec4(clamp(a, vec2(-60.0), vec2(60.0)), v0.z, 1.0);   // z: this step's sink (swirl ops), not advected
    })();

    const curl = Fn(() => {
      const vUv = uv();
      const L = T.vel.sample(vUv.sub(vec2(u.texV.x, 0.0))).y, R = T.vel.sample(vUv.add(vec2(u.texV.x, 0.0))).y;
      const Tt = T.vel.sample(vUv.add(vec2(0.0, u.texV.y))).x, B = T.vel.sample(vUv.sub(vec2(0.0, u.texV.y))).x;
      return vec4(R.sub(L).sub(Tt).add(B).mul(0.5), 0.0, 0.0, 1.0);
    })();

    const vort = Fn(() => {
      const vUv = uv();
      const L = T.curl.sample(vUv.sub(vec2(u.texV.x, 0.0))).x.toVar(), R = T.curl.sample(vUv.add(vec2(u.texV.x, 0.0))).x.toVar();
      const Tt = T.curl.sample(vUv.add(vec2(0.0, u.texV.y))).x.toVar(), B = T.curl.sample(vUv.sub(vec2(0.0, u.texV.y))).x.toVar();
      const C = T.curl.sample(vUv).x;
      const force = vec2(abs(Tt).sub(abs(B)), abs(R).sub(abs(L))).mul(0.5).toVar();
      force.divAssign(length(force).add(1e-4));
      const s = T.S.sample(vUv).toVar();
      const act = clamp(s.g.add(s.b.mul(0.35)), 0.0, 1.0).mul(1.6).add(0.25);   // the curls live in the fire and the smoke
      force.mulAssign(u.curlK.mul(C).mul(act));
      force.assign(vec2(force.x, force.y.negate()));
      // hot gas churns: a slowly drifting noise force inside the fire (the projection keeps only its swirling part)
      const q = vUv.mul(0.125).toVar();
      const nz = vec2(T.noise.sample(q.add(vec2(u.time.mul(0.0045), 0.0))).b, T.noise.sample(q.yx.add(vec2(0.37, u.time.mul(0.0037)))).a).sub(0.5);
      force.addAssign(nz.mul(u.turb).mul(clamp(s.g, 0.0, 1.5)));
      const v0 = T.vel.sample(vUv).toVar();
      const v = v0.xy.add(force.mul(u.dt)).mul(open(vUv));
      return vec4(v, v0.z, 1.0);
    })();

    const divergence = Fn(() => {
      const vUv = uv();
      const v0 = T.vel.sample(vUv).toVar();
      const pL = vUv.sub(vec2(u.texV.x, 0.0)).toVar(), pR = vUv.add(vec2(u.texV.x, 0.0)).toVar();
      const pB = vUv.sub(vec2(0.0, u.texV.y)).toVar(), pT = vUv.add(vec2(0.0, u.texV.y)).toVar();
      const L = mix(T.vel.sample(pL).x, v0.x.negate(), solidAt(pL));
      const R = mix(T.vel.sample(pR).x, v0.x.negate(), solidAt(pR));
      const B = mix(T.vel.sample(pB).y, v0.y.negate(), solidAt(pB));
      const Tt = mix(T.vel.sample(pT).y, v0.y.negate(), solidAt(pT));
      const d = R.sub(L).add(Tt).sub(B).mul(0.5).toVar();
      d.subAssign(u.expand.mul(clamp(T.S.sample(vUv).g, 0.0, 2.0)));
      d.addAssign(v0.z);   // whirlpool sinks (a convergence the projection keeps)
      return vec4(d.mul(open(vUv)), 0.0, 0.0, 1.0);
    })();

    const outside = (p) => p.x.lessThan(0.0).or(p.y.lessThan(0.0)).or(p.x.greaterThan(1.0)).or(p.y.greaterThan(1.0));
    /** The pressure at p (open borders: 0; walls: no flux, the centre's value). */
    const pAt = (p, c, keep) => select(outside(p), float(0.0), mix(T.P.sample(p).x.mul(keep), c, solidAt(p)));
    const fourP = (vUv, c, keep) => {
      const L = pAt(vUv.sub(vec2(u.texV.x, 0.0)), c, keep), R = pAt(vUv.add(vec2(u.texV.x, 0.0)), c, keep);
      const B = pAt(vUv.sub(vec2(0.0, u.texV.y)), c, keep), Tt = pAt(vUv.add(vec2(0.0, u.texV.y)), c, keep);
      return { L, R, B, Tt };
    };
    const jacobi = Fn(() => {
      const vUv = uv();
      const c = T.P.sample(vUv).x.mul(u.keep).toVar();
      const { L, R, B, Tt } = fourP(vUv, c, u.keep);
      return vec4(L.add(R).add(B).add(Tt).sub(T.div.sample(vUv).x).mul(0.25), 0.0, 0.0, 1.0);
    })();

    const project = Fn(() => {
      const vUv = uv();
      const c = T.P.sample(vUv).x.toVar();
      const { L, R, B, Tt } = fourP(vUv, c, float(1.0));
      const v = T.vel.sample(vUv).xy.sub(vec2(R.sub(L), Tt.sub(B)).mul(0.5)).mul(open(vUv));
      return vec4(v, 0.0, 1.0);
    })();

    // scalars: R fuel (does not move), G fire, B smoke, A heat; second output: the hue mass H (classic SCALARS)
    const scalars = mrtOutput((out1) => {
      const vUv = uv();
      const s0 = T.S.sample(vUv).toVar();
      const v = T.vel.sample(vUv).xy;
      const p = vUv.sub(v.mul(u.dt).div(u.size)).toVar();
      const a = T.S.sample(p).toVar();
      const o = u.texS.mul(1.5).toVar();
      const hn = T.S.sample(p.add(vec2(o.x, 0.0))).a.add(T.S.sample(p.sub(vec2(o.x, 0.0))).a)
        .add(T.S.sample(p.add(vec2(0.0, o.y))).a).add(T.S.sample(p.sub(vec2(0.0, o.y))).a).mul(0.25).toVar();
      const fuel = max(s0.r, 0.0).toVar();
      // flames sit on burning oil: on fuel, fire and heat only partly move with the flow
      const stick = clamp(fuel.mul(4.0), 0.0, u.stick).toVar();
      const fireRaw = mix(a.g, s0.g, stick).toVar();
      const fire = max(fireRaw, 0.0).toVar(), smoke = max(a.b, 0.0).toVar(), heat = max(mix(a.a, s0.a, stick), 0.0).toVar();
      heat.assign(mix(heat, max(hn, 0.0), u.heatDiffuse));
      // the hue fraction of the advected fire (the mass moves exactly like the fire: same sample, same stick)
      const hm = max(mix(T.H.sample(p), T.H.sample(vUv), stick), 0.0);
      const fr = hm.div(max(fireRaw, 0.02)).toVar();
      // fire runs across oil: fuel next to flames (≈ 0.4 m away) heats up
      If(fuel.greaterThan(0.02), () => {
        const oX = vec2(u.spreadOff, 0.0).toVar(), oY = vec2(0.0, u.spreadOff).toVar();
        const gR = T.S.sample(vUv.add(oX)).g.toVar(), gL = T.S.sample(vUv.sub(oX)).g.toVar();
        const gT = T.S.sample(vUv.add(oY)).g.toVar(), gB = T.S.sample(vUv.sub(oY)).g.toVar();
        const fn = max(max(gR, gL), max(gT, gB)).toVar();
        heat.addAssign(u.spread.mul(clamp(fn, 0.0, 1.5)).mul(u.dt));
        // oil that catches from a neighbour's flame (no flame of its own yet) burns in that flame's hue
        If(fireRaw.lessThan(0.05).and(fn.greaterThan(0.02)), () => {
          const o2 = select(fn.equal(gR), oX, select(fn.equal(gL), oX.negate(), select(fn.equal(gT), oY, oY.negate())));
          const nfr = max(T.H.sample(vUv.add(o2)), 0.0).div(max(fn, 0.02));
          fr.assign(mix(nfr, fr, smoothstep(0.0, 0.05, fireRaw)));
        });
      });
      fr.assign(clamp(fr, 0.0, 1.0));
      fr.divAssign(max(1.0, dot(fr, vec4(1.0))));
      const ign = smoothstep(u.ignite, u.ignite.add(0.22), heat);
      const burn = min(fuel, u.burnRate.mul(ign).mul(min(1.0, fuel.mul(5.0).add(0.05))).mul(u.dt)).toVar();
      fuel.subAssign(burn);
      fire.addAssign(burn.mul(u.fireYield));
      heat.addAssign(fire.mul(u.heatGain).mul(u.dt));
      const loss = fire.mul(min(1.0, u.fireDecay.mul(u.dt).mul(fire.mul(0.35).add(1.0)))).toVar();
      fire.subAssign(loss);
      smoke.addAssign(loss.mul(u.smokeYield));
      heat.subAssign(heat.mul(min(1.0, u.cool.mul(u.dt))));
      smoke.subAssign(smoke.mul(min(1.0, u.smokeDecay.mul(u.dt).mul(smoke.add(1.0)))));
      smoke.assign(max(0.0, smoke.sub(u.dt.mul(0.03))));   // thin smoke clears (keeps the empty-space skip effective)
      heat.assign(max(0.0, heat.sub(u.dt.mul(0.02))));
      fire.assign(select(fire.lessThan(0.004), float(0.0), fire));
      const keepC = open(vUv).toVar();
      const e = min(vUv, vec2(1.0).sub(vUv)).toVar();
      const edge = smoothstep(0.0, u.texS.x.mul(6.0), min(e.x, e.y)).toVar();
      const r = vec4(min(fuel, 2.0), min(fire, 3.0).mul(edge), min(smoke, 3.0).mul(edge), min(heat, 2.0).mul(edge)).toVar();
      out1.assign(fr.mul(r.g).mul(keepC));
      return r.mul(keepC);
    });

    // 64² summary: R heat for gameplay (max over the cell of max(heat, 0.8 fire)), G fuel (mean), B fire (mean), A smoke (mean)
    const summary = Fn(() => {
      const base = uv().sub(0.5 / 64).toVar();
      let hmax = float(0.0), acc = null;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const s = T.S.sample(base.add(vec2((i + 0.5) / 256, (j + 0.5) / 256))).toVar();
        hmax = max(hmax, max(s.a, s.g.mul(0.8)));
        acc = acc ? acc.add(s.rgb) : s.rgb;
      }
      const m = acc.div(16.0).toVar();
      return clamp(vec4(hmax, m.r, m.g, m.b), 0.0, 1.0);
    })();

    // 64² hue map: the fire-weighted hue fractions over a 2 m window round each 1 m cell (classic HUESUM)
    const hueSum = Fn(() => {
      const base = uv().sub(1.0 / 64).toVar();
      let f = null, h = null;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const q = base.add(vec2((i + 0.5) / 128, (j + 0.5) / 128)).toVar();
        const fs = max(T.S.sample(q).g, 0.0), hs = max(T.H.sample(q), 0.0);
        f = f ? f.add(fs) : fs; h = h ? h.add(hs) : hs;
      }
      const fr = clamp(h.div(max(f, 0.01)), 0.0, 1.0).toVar();
      return fr.div(max(1.0, dot(fr, vec4(1.0))));
    })();

    // light map: separable gaussian over the summary; each tap's light takes its cell's hue mix (classic LIGHT_H / LIGHT_V)
    const lightH = Fn(() => {
      const vUv = uv();
      let acc = null;
      for (let i = -4; i <= 4; i++) {
        const q = vUv.add(vec2(i / 64, 0.0));
        const s = T.sum.sample(q).toVar(), fr = T.hue.sample(q).toVar();
        const col = u.lightCols[0].mul(float(1.0).sub(dot(fr, vec4(1.0)))).add(u.lightCols[1].mul(fr.x)).add(u.lightCols[2].mul(fr.y))
          .add(u.lightCols[3].mul(fr.z)).add(u.lightCols[4].mul(fr.w));
        const L = s.b.mul(1.15).add(s.r.mul(0.35));
        const tap = vec4(col.mul(L), max(max(s.r, s.b), s.a.mul(1.5))).mul(GAUSS[Math.abs(i)]);
        acc = acc ? acc.add(tap) : tap;
      }
      return acc;
    })();
    const lightV = Fn(() => {
      const vUv = uv();
      let acc = null, occ = float(0.0);
      for (let i = -4; i <= 4; i++) {
        const s = T.lightTmp.sample(vUv.add(vec2(0.0, i / 64))).toVar();
        const tap = s.mul(GAUSS[Math.abs(i)]);
        acc = acc ? acc.add(tap) : tap;
        occ = max(occ, s.a);
      }
      return vec4(acc.rgb, occ);
    })();

    const copy = Fn(() => T.src.sample(uv()))();
    const copy2 = mrtOutput((out1) => { const vUv = uv(); out1.assign(T.src2.sample(vUv)); return T.S.sample(vUv); });

    this.mats = {
      advectVel: passMaterial(advectVel), curl: passMaterial(curl), vort: passMaterial(vort), div: passMaterial(divergence),
      jacobi: passMaterial(jacobi), project: passMaterial(project), scalars: passMaterial(scalars), hueSum: passMaterial(hueSum),
      summary: passMaterial(summary), lightH: passMaterial(lightH), lightV: passMaterial(lightV), copy: passMaterial(copy), copy2: passMaterial(copy2),
    };

    // splats (classic SPLAT_*): aSeg = (x0, z0, x1, z1) world, aShape = (radius, kind 0 capsule / 1 box, sink, 0),
    // aAdd = scalar deposit, aVel = (vx, vz, radial push, spin), aHue = the op's hue (one-hot)
    const aSeg = attribute('aSeg', 'vec4'), aShape = attribute('aShape', 'vec4'), aAdd = attribute('aAdd', 'vec4');
    const aVel = attribute('aVel', 'vec4'), aHue = attribute('aHue', 'vec4');
    const splatMat = (minR, frag) => {
      const r = max(aShape.x, minR);
      const pad = select(aShape.y.greaterThan(0.5), r, r.mul(1.6));
      const ext = select(aVel.z.notEqual(0.0), r.mul(0.6), float(0.0));
      const mn = min(aSeg.xy, aSeg.zw).sub(pad).sub(ext), mx = max(aSeg.xy, aSeg.zw).add(pad).add(ext);
      const w = mix(mn, mx, positionGeometry.xy.mul(0.5).add(0.5));
      const vW = varying(w, 'vW'), vShape = varying(vec4(r, aShape.yzw), 'vShape');
      const m = passMaterial(frag({ vW, vShape }), ADD);
      m.vertexNode = uvToClip(w.sub(u.rect.xy).div(u.rect.zw));
      return m;
    };
    const splatWeight = ({ vW, vShape }) => {
      const r = vShape.x;
      const mn = min(aSeg.xy, aSeg.zw), mx = max(aSeg.xy, aSeg.zw);
      const d = max(mn.sub(vW), vW.sub(mx));
      const box = float(1.0).sub(smoothstep(r.negate(), r, max(d.x, d.y)));
      const pa = vW.sub(aSeg.xy).toVar(), ba = aSeg.zw.sub(aSeg.xy).toVar();
      const h = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-6)), 0.0, 1.0);
      const dc = length(pa.sub(ba.mul(h))).toVar();
      const cap = exp(dc.mul(dc).mul(-2.6).div(r.mul(r)));
      return select(vShape.y.greaterThan(0.5), box, cap);
    };
    this.splatSMat = splatMat(u.minRS, (vv) => mrtOutput((out1) => {
      const w = splatWeight(vv).toVar();
      out1.assign(aHue.mul(max(aAdd.g, 0.0)).mul(w));
      return aAdd.mul(w);
    }));
    this.splatVMat = splatMat(u.minRV, (vv) => Fn(() => {
      const { vW, vShape } = vv;
      const v = aVel.xy.mul(splatWeight(vv)).toVar();
      const sink = float(0.0).toVar();
      const r = vShape.x;
      If(aVel.z.notEqual(0.0), () => {
        const dv = vW.sub(aSeg.xy).toVar(), d = length(dv).toVar();
        const prof = clamp(d.div(r), 0.0, 1.0).mul(float(1.0).sub(smoothstep(r, r.mul(1.6), d)));
        v.addAssign(select(d.greaterThan(1e-4), dv.div(d), vec2(0.0)).mul(aVel.z).mul(prof));
      });
      If(aVel.w.notEqual(0.0).or(vShape.z.notEqual(0.0)), () => {   // a whirlpool: tangential flow (ccw for w > 0) + a sink
        const dv = vW.sub(aSeg.xy).toVar(), d = length(dv).toVar();
        const prof = smoothstep(0.0, r.mul(0.35), d).mul(float(1.0).sub(smoothstep(r.mul(0.7), r.mul(1.25), d)));
        v.addAssign(select(d.greaterThan(1e-4), vec2(dv.y.negate(), dv.x).div(d), vec2(0.0)).mul(aVel.w).mul(prof));
        sink.assign(vShape.z.mul(exp(d.mul(d).mul(-2.0).div(r.mul(r)))));
      });
      return vec4(v, sink, 0.0);
    })());
  }

  /** (Re)build the fields at a tier's resolution, resampling the current state into the new targets. */
  setQuality(q, first = false) {
    const cfg = RES[q] || RES.high;
    const old = this.cfg ? { V: this.V, S: this.S, P: this.P, curl: this.curl, div: this.div } : null;
    this.cfg = { ...cfg, name: q in RES ? q : 'high' };
    const nv = cfg.vel, ns = cfg.sca;
    const V = new PingPong(nv, nv), P = new PingPong(nv, nv, { filter: NearestFilter });
    const S = new PingPong(ns, ns, { count: 2 });   // textures[0] = S, textures[1] = H (the hue mass)
    const curl = makeTarget(nv, nv, { filter: NearestFilter }), div = makeTarget(nv, nv, { filter: NearestFilter });
    const r = this.renderer;
    clearTargets(r, [V.a, V.b, P.a, P.b, S.a, S.b, curl, div]);
    if (first) clearTargets(r, [this.summaryRT, this.lightTmp, this.lightRT, this.hueRT]);
    if (old && this.T) {
      const prev = r.getRenderTarget();
      this.T.src.value = old.V.read.texture; this.quad.run(r, this.mats.copy, V.read);
      this.T.S.value = old.S.read.textures[0]; this.T.src2.value = old.S.read.textures[1]; this.quad.run(r, this.mats.copy2, S.read);
      r.setRenderTarget(prev);
      old.V.dispose(); old.S.dispose(); old.P.dispose(); old.curl.dispose(); old.div.dispose();
    }
    Object.assign(this, { V, P, S, curl, div });
    if (this.u) this._sizes();
  }
  _sizes() {
    const nv = this.cfg.vel, ns = this.cfg.sca;
    this.u.texV.value.set(1 / nv, 1 / nv); this.u.texS.value.set(1 / ns, 1 / ns);
    this.u.minRS.value = 1.4 * W.area.size / ns;
    this.u.minRV.value = 1.4 * W.area.size / nv;
  }

  /** Queue the ops for the next sub-step: classic's own op → splat mapping (DEPOSIT, the swirl's two splats, the caps). */
  queue(ops) { return FluidSolver.prototype.queue.call(this, ops); }

  _splat() {
    const n = this.pending;
    if (!n) return;
    for (const a of Object.values(this.splat)) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    this.splatMesh.geometry.instanceCount = n;
    const r = this.renderer;
    this.splatMesh.material = this.splatSMat; r.setRenderTarget(this.S.read); r.render(this.splatMesh, this.splatCam);
    this.splatMesh.material = this.splatVMat; r.setRenderTarget(this.V.read); r.render(this.splatMesh, this.splatCam);
    this.pending = 0;
  }

  /** One fixed sub-step. @param {number} dt seconds */
  _step(dt) {
    const r = this.renderer, q = this.quad, m = this.mats, K = KNOBS, T = this.T, u = this.u;
    this._splat();
    u.dt.value = dt; u.decay.value = Math.exp(-K.velDecay * dt); u.windPull.value = K.windPull;
    T.vel.value = this.V.read.texture; q.run(r, m.advectVel, this.V.write); this.V.swap();
    T.vel.value = this.V.read.texture; q.run(r, m.curl, this.curl);
    T.S.value = this.S.read.textures[0]; u.curlK.value = K.curl; u.turb.value = K.turb; u.time.value = this.time;
    q.run(r, m.vort, this.V.write); this.V.swap();
    T.vel.value = this.V.read.texture; u.expand.value = K.expand;
    q.run(r, m.div, this.div);
    const iters = this.cfg.jacobi;
    for (let i = 0; i < iters; i++) {
      T.P.value = this.P.read.texture; u.keep.value = i === 0 ? K.pressureKeep : 1;
      q.run(r, m.jacobi, this.P.write); this.P.swap();
    }
    this.lastJacobi = iters;
    T.P.value = this.P.read.texture;
    q.run(r, m.project, this.V.write); this.V.swap();
    T.S.value = this.S.read.textures[0]; T.H.value = this.S.read.textures[1]; T.vel.value = this.V.read.texture;
    const rn = this.rain;   // rain scales the reaction (no shader cost)
    u.ignite.value = K.ignite + K.rainIgnite * rn; u.burnRate.value = K.burnRate * (1 - K.rainBurn * rn); u.fireYield.value = K.fireYield; u.fireDecay.value = K.fireDecay * (1 + K.rainDecay * rn);
    u.smokeYield.value = K.smokeYield * (1 + K.rainSmoke * rn); u.smokeDecay.value = K.smokeDecay; u.heatGain.value = K.heatGain; u.cool.value = K.cool * (1 + K.rainCool * rn); u.heatDiffuse.value = K.heatDiffuse;
    u.spread.value = K.spread; u.spreadOff.value = K.spreadDist / W.area.size; u.stick.value = K.stick;
    q.run(r, m.scalars, this.S.write); this.S.swap();
    this.time += dt;
  }

  /** Advance by real time; fixed sub-steps at the tier's rate, at most 3 per call. Returns the number of steps. */
  step(dt) {
    const h = 1 / this.cfg.hz;
    this.accum = Math.min(this.accum + Math.max(0, dt), h * 3);
    let n = 0;
    const r = this.renderer, prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    if (this.pending && this.accum < h) this.accum = h;   // never sit on queued ops
    while (this.accum >= h - 1e-6 && n < 3) { this._step(h); this.accum -= h; n++; }
    if (n) this._summarize();
    r.autoClear = prevAuto;
    r.setRenderTarget(prevRT);
    this.stepsLast = n;
    return n;
  }

  _summarize() {
    const r = this.renderer, q = this.quad, m = this.mats, T = this.T;
    T.S.value = this.S.read.textures[0]; T.H.value = this.S.read.textures[1];
    q.run(r, m.summary, this.summaryRT);
    q.run(r, m.hueSum, this.hueRT);
    const dim = 1.5 * (1 - KNOBS.rainLight * this.rain);   // the fire light dims in the rain
    this.u.lightCols.forEach((v, k) => v.value.set(LIGHT_COLS[k][0] * dim, LIGHT_COLS[k][1] * dim, LIGHT_COLS[k][2] * dim));
    q.run(r, m.lightH, this.lightTmp);
    q.run(r, m.lightV, this.lightRT);
    this._lightColumns();
  }

  /** The light of the columns (the pillar, the demon's fire), additive discs in the 64² light map. */
  _lightColumns() {
    const n = this.lightSplats.length;
    if (!n) return;
    if (!this.lightMesh) {
      const geo = instancedQuad();
      this.lightA = new InstancedBufferAttribute(new Float32Array(16 * 4), 4).setUsage(DynamicDrawUsage);
      this.lightC = new InstancedBufferAttribute(new Float32Array(16 * 4), 4).setUsage(DynamicDrawUsage);
      geo.setAttribute('aL', this.lightA); geo.setAttribute('aC', this.lightC);
      const aL = attribute('aL', 'vec4'), aC = attribute('aC', 'vec4');
      const mat = passMaterial(Fn(() => {
        const vD = positionGeometry.xy;
        const d = dot(vD, vD).toVar();
        return vec4(aC.rgb.mul(max(0.0, float(1.0).sub(d))).mul(float(1.0).sub(d)), 0.0);
      })(), { ...ADD, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor });
      mat.vertexNode = uvToClip(aL.xy.add(positionGeometry.xy.mul(aL.z)).sub(this.u.rect.xy).div(this.u.rect.zw));
      this.lightMesh = new Mesh(geo, mat); this.lightMesh.frustumCulled = false;
    }
    const k = Math.min(n, 16);
    for (let i = 0; i < k; i++) { const L = this.lightSplats[i]; this.lightA.array.set([L.x, L.z, L.r, 0], i * 4); this.lightC.array.set([L.rgb[0], L.rgb[1], L.rgb[2], 0], i * 4); }
    this.lightA.needsUpdate = true; this.lightC.needsUpdate = true; this.lightMesh.geometry.instanceCount = k;
    this.renderer.setRenderTarget(this.lightRT); this.renderer.render(this.lightMesh, this.splatCam);
  }

  /** Every material (warm-up). */
  materials() { return [...Object.values(this.mats), this.splatSMat, this.splatVMat]; }

  /** Clear every field (fresh fire). */
  reset() {
    clearTargets(this.renderer, [this.V.a, this.V.b, this.P.a, this.P.b, this.S.a, this.S.b, this.curl, this.div, this.summaryRT, this.lightTmp, this.lightRT, this.hueRT]);
    this.pending = 0; this.accum = 0;
  }

  dispose() {
    for (const t of [this.V, this.P, this.S]) t.dispose();
    for (const t of [this.curl, this.div, this.summaryRT, this.lightTmp, this.lightRT, this.hueRT]) t.dispose();
    for (const mm of Object.values(this.mats)) mm.dispose();
    this.splatSMat.dispose(); this.splatVMat.dispose(); this.splatMesh.geometry.dispose();
    this.obs.dispose(); this.quad.dispose();
    if (this.lightMesh) { this.lightMesh.geometry.dispose(); this.lightMesh.material.dispose(); }
  }
}
