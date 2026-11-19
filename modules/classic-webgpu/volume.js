// FIREWRAITH · classic-webgpu · the volume: classic's volume.js in TSL (its header says what the channels mean). A ray
// march over a slab above the terrain into a ½-res (smooth) or ≈ ¼-res (hybrid) two-output target (0: fire coverage,
// coverage × temperature, moon-lit smoke, transmittance; 1: the emission-weighted hue mass), depth-tested against the
// scene, then composited over the scene colour: `smooth` (continuous ramps, bilateral upsample) or `hybrid` (the coarse
// fire-pixel grid, the six colours stepped, a 4×4 Bayer dither at band borders, a crimson rim). Variants as in classic:
// the march with or without the hue reads (HUE) and the eye-in-fire fade (INFIRE); the composite per style, ± HUE.
// The knobs are classic's LOOK; the ramps classic's HUE_RAMPS (shared objects: a bench that tunes one tunes both).
// Screen convention: uv y = 0 at the top of the frame (WebGPU); depth → world goes through the kit's `depthNodes`.
import { Vector2, Vector3, Vector4, NearestFilter, HalfFloatType } from 'three/webgpu';
import {
  Fn, uv, uniform, uniformArray, vec2, vec3, vec4, float, int, If, Loop, Break, Continue, select, min, max, clamp,
  mix, smoothstep, step, abs, dot, exp, pow, sqrt, length, normalize, floor, mod, array, screenCoordinate,
} from 'three/tsl';
import { LOOK, HUE_RAMPS, HUE_ORDER, SMOKE_COL, STEAM_COL, ORANGE_RIM } from '../classic/volume.js';
import { W, ground } from './world.js';
import { makeTarget, passMaterial, texNode, mrtOutput, linColor, clearTargets } from '../../src/kit/webgpu/index.js';

export { LOOK };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** The 4×4 Bayer threshold (0..1) at a cell (classic bayer4). @param {any} c vec2 */
export const bayer4 = (c) => {
  const p = mod(floor(c), 4.0).toVar();
  return array(BAYER.map((x) => float(x))).element(int(p.y).mul(int(4)).add(int(p.x))).add(0.5).div(16.0);
};

export class VolumePassGPU {
  /** @param {any} renderer @param {{ quad: any, noise3: any, depth: any }} o  depth: the kit's depthNodes(), shared */
  constructor(renderer, { quad, noise3, depth }) {
    this.renderer = renderer; this.quad = quad; this.noise3 = noise3; this.D = depth;
    this.style = 'smooth'; this.maxSteps = 72; this.stepScale = 1;
    this.hueOn = false; this.inFireOn = false; this.camFire = 0; this.rain = 0;
    this.rt = null; this.w = 0; this.h = 0; this.frame = 0;
    const m = W.moonDir;
    this.mu = {
      camPos: uniform(new Vector3()), rect: uniform(new Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size)), volRes: uniform(new Vector2(1, 1)),
      time: uniform(0), jitter: uniform(1), flameH: uniform(0), lean: uniform(0), smokeLean: uniform(0), fireGain: uniform(0), smokeK: uniform(0),
      smokeTop: uniform(LOOK.smokeTop), nearFade: uniform(0), stepScale: uniform(1), sheetGain: uniform(LOOK.sheetGain), sheetH: uniform(LOOK.sheetH),
      smokeGlow: uniform(LOOK.smokeGlow), smokeMaxA: uniform(LOOK.smokeMaxA), smokeFar: uniform(LOOK.smokeFar), fineStep: uniform(1), tall: uniform(1),
      inFire: uniform(new Vector3(LOOK.inFireFade0, LOOK.inFireFade1, LOOK.inFireSheet)), inFireCool: uniform(LOOK.inFireCool), camFire: uniform(0),
      coreHeat: uniform(LOOK.coreHeat), wallFade: uniform(LOOK.wallFade), moonDir: uniform(new Vector3(m.x, m.y, m.z)),
    };
    this.mt = { S: texNode(), hueMap: texNode(), vel: texNode(), light: texNode() };
    this.cu = {
      pal: uniformArray(Array.from({ length: 30 }, () => new Vector3()), 'vec3'), rim: uniformArray(Array.from({ length: 5 }, () => new Vector3()), 'vec3'),
      exposure: uniform(LOOK.fireExposure), bright: uniform(LOOK.bright), rimGain: uniform(LOOK.rimGain),
      smokeCol: uniform(new Vector3(...SMOKE_COL)), smokeFloor: uniform(0.3), softSmoke: uniform(1),
    };
    this.ct = { scene: texNode(), vol: texNode(), volHue: texNode() };
    this.setRamps();
    this.cache = new Map();
    this._build();
  }

  /** (Re)load HUE_RAMPS into the composite's palette (orange first) and the hybrid rims (classic setRamps). */
  setRamps() {
    HUE_ORDER.forEach((h, k) => {
      HUE_RAMPS[h].forEach((hex, i) => { const c = linColor(hex); this.cu.pal.array[k * 6 + i].set(c.r, c.g, c.b); });
      if (k === 0) this.cu.rim.array[0].set(...ORANGE_RIM);
      else { const c = linColor(HUE_RAMPS[h][1]); this.cu.rim.array[k].set(c.r, c.g, c.b); }
    });
  }

  // ------------------------------------------------------------------------------------------------ the march (classic MARCH)
  _marchNode({ steps, hue, inFire }) {
    const U = this.mu, T = this.mt, D = this.D, noise3 = this.noise3;
    const flameTemp = (hot, f, d0) => {   // the fire's colour coordinate (0 crimson edge … 0.6 orange body … 1 white-yellow core)
      const d = d0.toVar();
      const r2 = d.mul(0.46).mul(f.mul(0.5).add(0.5)).add(0.2).add(smoothstep(0.55, 1.4, hot).mul(0.36).mul(d).mul(d).mul(f).mul(f));
      const r3 = d.mul(0.42).mul(f.mul(0.55).add(0.45)).add(0.2).add(U.coreHeat.mul(smoothstep(0.3, 0.9, hot)).mul(d).mul(f).mul(f));
      return mix(r2, r3, U.tall);
    };
    return mrtOutput((out1) => {
      const vUv = uv();
      const uvc = floor(vUv.mul(U.volRes)).add(0.5).div(U.volRes).toVar();   // the texel centre (the upsample reads the same depth)
      const { raw, pos: wp } = D.worldAt(uvc);
      const ro = U.camPos;
      const rd = normalize(wp.sub(ro)).toVar();
      const tScene = select(raw.greaterThanEqual(0.99999), float(1e5), length(wp.sub(ro))).toVar();
      // the domain box
      const bmin = vec3(U.rect.x, -16.0, U.rect.y), bmax = vec3(U.rect.x.add(U.rect.z), U.smokeTop.add(1.0), U.rect.y.add(U.rect.w));
      const inv = vec3(1.0).div(rd.add(vec3(1e-6))).toVar();
      const t0 = bmin.sub(ro).mul(inv).toVar(), t1 = bmax.sub(ro).mul(inv).toVar();
      const tmin = min(t0, t1).toVar(), tmax = max(t0, t1).toVar();
      const tIn = max(max(tmin.x, tmin.y), max(tmin.z, 0.15)).toVar();
      const tOut = min(min(tmax.x, tmax.y), min(tmax.z, tScene)).toVar();
      const out0 = vec4(0.0, 0.0, 0.0, 1.0).toVar();
      If(tIn.lessThan(tOut), () => {
        // R = fire coverage (emission = extinction), G = R × temperature, B = moon/sky-lit smoke; T transmittance, Ts the smoke's own
        const Tr = float(1.0).toVar(), Ts = float(1.0).toVar(), acc = vec3(0.0).toVar(), hueAcc = vec4(0.0).toVar();
        // stable white-noise jitter from the noise texture (hybrid: none)
        const jit = mix(0.5, noise3.tex.sample(mod(floor(screenCoordinate.xy), 256.0).add(0.5).div(256.0)).b, U.jitter).toVar();
        let inF, n0, n1;
        if (inFire) {   // the eye stands in fire: fade the near flames, most above the horizon and at the screen centre
          inF = U.camFire;
          const sc = vUv.sub(0.5).mul(vec2(U.volRes.x.div(U.volRes.y), 1.0));
          const wDir = max(max(smoothstep(-0.32, 0.08, rd.y), float(1.0).sub(smoothstep(0.08, 0.42, length(sc))).mul(0.85)), 0.5);
          const wF = inF.mul(wDir).toVar();
          n0 = mix(0.6, U.inFire.x, wF).toVar(); n1 = mix(U.nearFade, U.inFire.y, wF).toVar();
        } else { inF = float(0.0); n0 = float(0.6); n1 = U.nearFade; }
        const t = tIn.add(jit.mul(min(clamp(tIn.mul(0.05), 0.08, 1.0), tIn.mul(0.03).add(0.22))).mul(U.stepScale)).toVar();
        Loop(steps, () => {
          If(t.greaterThanEqual(tOut).or(Tr.lessThan(0.03)), () => { Break(); });
          const p = ro.add(rd.mul(t)).toVar();
          const h = p.y.sub(ground(p.xz)).toVar();
          const dt = clamp(t.mul(0.075), 0.09, 2.0).mul(U.stepScale).toVar();
          const uv0 = p.xz.sub(U.rect.xy).div(U.rect.zw).toVar();
          const L = T.light.sample(uv0).toVar();
          If(h.lessThan(-0.25), () => {
            If(rd.y.lessThan(0.0), () => { Break(); });
            t.addAssign(dt);
            Continue();
          });
          If(h.greaterThan(U.smokeTop).and(rd.y.greaterThanEqual(0.0)), () => { Break(); });   // above the smoke and rising
          If(L.a.lessThan(0.015).or(h.greaterThan(U.smokeTop)), () => { t.addAssign(max(dt, 1.6)); Continue(); });   // empty
          If(Ts.lessThanEqual(float(1.03).sub(U.smokeMaxA)), () => { Break(); });   // the smoke's opacity is capped: the ray ends there
          const near = smoothstep(n0, n1, t).toVar();
          const vel = T.vel.sample(uv0).xy.toVar();
          const hc = max(h, 0.0).toVar();
          // fire: short tongues leaning with the flow; a 2D blob noise cut by a threshold that rises with height
          const q = p.xz.sub(vel.mul(hc).mul(U.lean)).toVar();
          const uvq = q.sub(U.rect.xy).div(U.rect.zw).toVar();
          const s = T.S.sample(uvq).toVar();
          const hot = clamp(s.g, 0.0, 2.0).toVar();
          const aF = float(0.0).toVar(), temp = float(0.0).toVar();
          If(hot.greaterThan(0.02), () => {
            const fh = U.flameH.mul(pow(clamp(hot.mul(0.85).add(s.a.mul(0.15)), 0.0, 1.5), mix(0.6, 0.9, U.tall))).toVar();
            const f = float(1.0).sub(hc.div(max(fh, 0.05))).toVar();
            If(f.greaterThan(0.0), () => {
              dt.assign(mix(dt, min(dt, t.mul(0.03).add(0.22)), U.fineStep));   // finer steps inside the flame layer
              const n = noise3(vec3(q.mul(1.15), U.time.mul(0.55).sub(hc.mul(mix(0.35, 0.8, U.tall))))).toVar();
              If(t.lessThan(22.0).and(hc.lessThan(mix(99.0, 1.6, U.tall))), () => {   // licks near the base only
                n.assign(n.mul(0.62).add(noise3(vec3(q.mul(2.5).add(7.0), hc.mul(1.7).sub(U.time.mul(2.4)))).mul(0.38)));
              });
              const thr = mix(0.22, 0.72, pow(float(1.0).sub(f), mix(0.8, 1.0, U.tall))).toVar();
              const d = smoothstep(thr, thr.add(0.1), n);
              const e = d.mul(pow(f, 0.5)).mul(smoothstep(0.02, 0.45, hot)).mul(U.fireGain).mul(near)
                .mul(smoothstep(0.0, U.wallFade, tScene.sub(t))).toVar();   // fade in front of a surface: no streaks up a wall
              aF.assign(float(1.0).sub(exp(e.mul(dt).negate())));
              temp.assign(flameTemp(hot, f, smoothstep(thr, thr.add(0.22), n)));
              if (inFire) temp.mulAssign(mix(1.0, U.inFireCool, inF.mul(float(1.0).sub(smoothstep(n1, n1.add(3.0), t)))));
            });
          });
          // smoke: translucent charcoal, rolls up and drifts with the flow, thins with distance, never fully opaque
          const sm = s.b.toVar();
          If(hc.greaterThan(1.0).and(sm.greaterThan(0.004)), () => { sm.assign(T.S.sample(uv0.sub(vel.mul(hc).mul(U.smokeLean).div(U.rect.zw))).b); });
          sm.assign(clamp(sm.sub(0.02), 0.0, 2.0));
          const aS = float(0.0).toVar(), cool = float(0.0).toVar(), glow = float(0.0).toVar();
          If(sm.greaterThan(0.01), () => {
            const top = U.smokeTop.sub(1.8).mul(clamp(sm.mul(0.8), 0.0, 1.0)).add(1.8).toVar();
            const prof = smoothstep(0.0, 0.9, hc).mul(float(1.0).sub(smoothstep(top.mul(0.4), top, hc)));
            const bn = noise3(vec3(p.x.mul(0.5), p.z.mul(0.5), hc.mul(0.45).sub(U.time.mul(0.32)))).toVar();
            If(t.lessThan(12.0), () => { bn.assign(bn.mul(0.65).add(noise3(vec3(p.x.mul(1.3), p.z.mul(1.3), hc.mul(1.1).sub(U.time.mul(0.6)))).mul(0.35))); });
            const sd = sm.mul(prof).mul(smoothstep(0.36, 0.7, bn.add(0.1))).mul(U.smokeK).toVar();
            sd.mulAssign(smoothstep(1.0, U.nearFade.mul(2.0), t).mul(float(1.0).sub(smoothstep(U.smokeFar.mul(0.4), U.smokeFar, t))));
            sd.mulAssign(smoothstep(float(1.0).sub(U.smokeMaxA), float(1.25).sub(U.smokeMaxA), Ts));   // the opacity saturates at smokeMaxA
            aS.assign(float(1.0).sub(exp(sd.mul(dt).mul(smoothstep(0.0, U.wallFade, tScene.sub(t))).negate())));
            glow.assign(min(dot(L.rgb, vec3(0.3, 0.55, 0.15)).mul(U.smokeGlow), 0.6).mul(exp(hc.mul(-0.5))));   // lit orange from below
            cool.assign(smoothstep(0.0, U.smokeTop.mul(0.7), hc).mul(0.55).add(0.45));                          // the moon and the sky above
            If(t.lessThan(25.0), () => { cool.mulAssign(exp(T.S.sample(uv0.add(U.moonDir.xz.mul(1.5).div(U.rect.zw))).b.mul(-0.9))); });
          });
          If(aF.add(aS).greaterThan(0.0), () => {
            const ag = aS.mul(glow).toVar();
            if (hue) If(aF.greaterThan(0.0).or(ag.greaterThan(0.002)), () => { hueAcc.addAssign(T.hueMap.sample(uvq).mul(Tr.mul(aF.add(ag)))); });
            acc.addAssign(vec3(Tr.mul(aF.add(ag)), Tr.mul(aF.mul(temp).add(ag.mul(0.12))), Tr.mul(float(1.0).sub(aF)).mul(aS).mul(cool)));
            Tr.mulAssign(float(1.0).sub(aF).mul(float(1.0).sub(aS)));
            Ts.mulAssign(float(1.0).sub(aS));
          });
          t.addAssign(dt);
        });
        // the ground sheet: a thin marbled layer of burning oil where the ray ends on the ground (marbled, molten-looking veins)
        If(tScene.lessThan(1e4).and(tOut.greaterThanEqual(tScene.sub(0.01))).and(Tr.greaterThan(0.03)), () => {
          const pe = ro.add(rd.mul(tScene)).toVar();
          const he = pe.y.sub(ground(pe.xz)).toVar();
          const uvE = pe.xz.sub(U.rect.xy).div(U.rect.zw).toVar();
          If(he.lessThan(0.7).and(uvE.x.greaterThan(0.0)).and(uvE.y.greaterThan(0.0)).and(uvE.x.lessThan(1.0)).and(uvE.y.lessThan(1.0)), () => {
            const vel = T.vel.sample(uvE).xy.toVar();
            const w2 = vec2(noise3(vec3(pe.xz.mul(0.42), U.time.mul(0.2))), noise3(vec3(pe.xz.mul(0.42).add(31.7), U.time.mul(0.2)))).sub(0.5).toVar();
            const uvS = uvE.add(w2.mul(1.3).sub(vel.mul(0.12)).div(U.rect.zw)).toVar();
            const hot = T.S.sample(uvS).g.toVar();
            If(hot.greaterThan(0.02), () => {
              const qm = pe.xz.add(w2.mul(2.4)).sub(vel.mul(0.35)).toVar();
              const mm = noise3(vec3(qm.mul(1.25), U.time.mul(0.3))).toVar();
              const m2 = noise3(vec3(qm.mul(2.9).add(11.0), U.time.mul(0.5))).toVar();
              const vein = pow(float(1.0).sub(abs(mm.mul(2.0).sub(1.0))), 6.0);
              const body = smoothstep(0.03, 0.7, hot).toVar();
              const len = clamp(U.sheetH.div(max(rd.y.negate(), 0.1)), 0.0, 3.0);
              const eS = body.mul(m2.mul(0.55).add(0.45)).mul(U.sheetGain).mul(len).mul(smoothstep(0.6, U.nearFade, tScene)).toVar();
              if (inFire) eS.mulAssign(mix(1.0, U.inFire.z, inF.mul(float(1.0).sub(smoothstep(3.0, 8.0, tScene)))));   // no white-hot floor round an eye in fire
              const aG = float(1.0).sub(exp(eS.negate())).toVar();
              const tS = body.mul(0.4).mul(m2.mul(0.5).add(0.5)).add(0.24).add(vein.mul(0.7).mul(body));   // hot veins reach the white-yellow core
              acc.addAssign(vec3(Tr.mul(aG), Tr.mul(aG).mul(tS), 0.0));
              if (hue) hueAcc.addAssign(T.hueMap.sample(uvS).mul(Tr.mul(aG)));
              Tr.mulAssign(float(1.0).sub(aG));
            });
          });
        });
        out0.assign(vec4(acc, Tr));   // A = transmittance (the composite uses 1 − A)
        out1.assign(hueAcc);
      });
      return out0;
    });
  }

  // ------------------------------------------------------------------------------------------------ the composite (classic COMPOSITE)
  _compositeNode({ hybrid, hue }) {
    const U = this.cu, T = this.ct, D = this.D, volRes = this.mu.volRes;
    const pal = U.pal, rim = U.rim;
    /** hue h's ramp (0 orange, 1 violet, 2 blue, 3 green, 4 lilac), continuous. @param {number|any} h */
    const rampH = (h, x) => {
      const k = clamp(x, 0.0, 1.0).mul(5.0).toVar();
      const i = min(floor(k), 4.0).toVar();
      const idx = (typeof h === 'number' ? int(h * 6) : h.mul(int(6))).add(int(i)).toVar();
      return mix(pal.element(idx), pal.element(idx.add(int(1))), k.sub(i));
    };
    const hueW = (hv, r) => { const w = clamp(hv.div(max(r, 1e-4)), 0.0, 1.0).toVar(); return w.div(max(1.0, dot(w, vec4(1.0)))); };
    /** the hues' ramps blended by weight (orange alone: exactly the orange ramp) */
    const rampMix = (x, w) => {
      if (!hue) return rampH(0, x);
      const c = rampH(0, x).toVar();
      const s = dot(w, vec4(1.0)).toVar();
      If(s.greaterThanEqual(1e-3), () => {
        c.assign(c.mul(float(1.0).sub(s)).add(rampH(1, x).mul(w.x)).add(rampH(2, x).mul(w.y)).add(rampH(3, x).mul(w.z)).add(rampH(4, x).mul(w.w)));
      });
      return c;
    };
    /** hybrid: one hue per fire pixel, the dominant one; where the top two are within 0.35 a Bayer threshold picks */
    const domHue = (w, b2) => {
      const wv = [float(1.0).sub(dot(w, vec4(1.0))).toVar(), w.x, w.y, w.z, w.w];
      const b1 = wv[0].toVar(), h1 = int(0).toVar();
      for (let k = 1; k < 5; k++) If(wv[k].greaterThan(b1), () => { b1.assign(wv[k]); h1.assign(int(k)); });
      const bs = select(h1.equal(int(0)), wv[1], wv[0]).toVar(), h2 = select(h1.equal(int(0)), int(1), int(0)).toVar();
      for (let k = 0; k < 5; k++) If(h1.notEqual(int(k)).and(wv[k].greaterThan(bs)), () => { bs.assign(wv[k]); h2.assign(int(k)); });
      return select(b2.lessThan(float(0.5).sub(b1.sub(bs).div(0.7))), h2, h1);
    };
    /** nearest upsample; a foreground edge inside the fire pixel keeps it crisp (classic volNearest) */
    const volNearest = (vUv) => {
      const uvc = floor(vUv.mul(volRes)).add(0.5).div(volRes).toVar();
      const dC = D.viewDepthAt(uvc).toVar(), dF = D.viewDepthAt(vUv).toVar();
      const v = T.vol.sample(uvc).toVar(), hw = vec4(0.0).toVar();
      If(dF.lessThan(dC.mul(0.85)).and(dF.lessThan(120.0)), () => { v.assign(vec4(0.0, 0.0, 0.0, 1.0)); })
        .Else(() => { if (hue) hw.assign(hueW(T.volHue.sample(uvc), v.r)); });
      return { v, hw };
    };
    /** depth-aware bilateral upsample (classic volSmooth); one hue fetch from the heaviest tap */
    const volSmooth = (vUv, wantHue) => {
      const pc = vUv.mul(volRes).sub(0.5).toVar();
      const i0 = floor(pc).toVar(), fr = pc.sub(i0).toVar();
      const dF = D.viewDepthAt(vUv).toVar();
      const sum = vec4(0.0).toVar(), wsum = float(0.0).toVar(), best = vec4(0.0, 0.0, 0.0, 1.0).toVar(), bestD = float(1e9).toVar();
      const uvW = vUv.toVar(), wMax = float(-1.0).toVar(), sW = vec4(0.0).toVar();
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const uvn = clamp(i0.add(vec2(i, j)), vec2(0.0), volRes.sub(1.0)).add(0.5).div(volRes).toVar();
        const dn = D.viewDepthAt(uvn);
        const bw = (i ? fr.x : float(1.0).sub(fr.x)).mul(j ? fr.y : float(1.0).sub(fr.y)).toVar();
        const diff = abs(dn.sub(dF)).toVar();
        const w = bw.mul(exp(diff.negate().div(dF.mul(0.02).add(0.05)))).add(bw.mul(1e-5)).toVar();
        const s = T.vol.sample(uvn).toVar();
        sum.addAssign(s.mul(w)); wsum.addAssign(w);
        If(diff.lessThan(bestD), () => { bestD.assign(diff); best.assign(s); });
        If(w.mul(s.r).greaterThan(wMax), () => { wMax.assign(w.mul(s.r)); uvW.assign(uvn); sW.assign(s); });
      }
      const hw = vec4(0.0).toVar();
      if (hue && wantHue) hw.assign(hueW(T.volHue.sample(uvW), sW.r));
      const v = select(wsum.greaterThan(1e-3), sum.div(wsum), best).toVar();
      return { v, hw };
    };
    return Fn(() => {
      const vUv = uv();
      const scene = T.scene.sample(vUv).rgb.toVar();
      const col = vec3(0.0).toVar();
      if (hybrid) {
        // the fire is quantised on the coarse grid; its smoke is not (soft, like smooth)
        const { v, hw: hwN } = volNearest(vUv);
        const cov = clamp(v.r.mul(U.exposure), 0.0, 1.0).toVar();
        const temp = clamp(v.g.div(max(v.r, 1e-4)), 0.0, 1.0).toVar();
        const cell = floor(vUv.mul(volRes)).toVar();
        const b = bayer4(cell).sub(0.5).toVar();
        const hd = int(0).toVar();
        if (hue) If(dot(hwN, vec4(1.0)).greaterThan(0.002), () => { hd.assign(domHue(hwN, bayer4(cell.add(vec2(2.0, 1.0))))); });   // orange and empty pixels skip it
        const covS = float(0.0).toVar(), tempS = float(1.0).toVar(), hwS = vec4(0.0).toVar();
        If(U.softSmoke.greaterThan(0.5).and(float(1.0).sub(v.a).greaterThan(0.002)), () => {   // (empty coarse pixels skip the soft sample)
          const { v: vs } = volSmooth(vUv, false);
          covS.assign(clamp(vs.r.mul(U.exposure), 0.0, 1.0));
          tempS.assign(clamp(vs.g.div(max(vs.r, 1e-4)), 0.0, 1.0));
          hwS.assign(hwN);   // the smoke's glow from below takes the fire pixel's hue (no second hue fetch)
          const AsS = clamp(float(1.0).sub(vs.a).sub(covS), 0.0, 1.0).toVar();
          col.assign(scene.mul(float(1.0).sub(AsS)).add(max(U.smokeCol.mul(vs.b), scene.mul(AsS).mul(U.smokeFloor))));
        }).ElseIf(U.softSmoke.greaterThan(0.5), () => {
          col.assign(scene);
        }).Else(() => {   // softSmoke 0: smoke in flat steps on the coarse grid
          const As = clamp(float(1.0).sub(v.a).sub(cov), 0.0, 1.0).toVar();
          const aq = select(As.lessThan(0.14), float(0.0), select(As.lessThan(0.32), float(0.3), float(0.55))).toVar();
          const sm = max(U.smokeCol.mul(v.b.div(max(As, 0.02))), scene.mul(U.smokeFloor));
          col.assign(scene.mul(float(1.0).sub(aq)).add(sm.mul(aq)));
        });
        // the six colours, stepped by temperature; the dither only at the band borders and the fire's own edge
        const lv = clamp(floor(temp.mul(6.0).add(0.35).add(b.mul(0.6))), 0.0, 5.0).toVar();
        const c = pal.element(hd.mul(int(6)).add(int(lv))).mul(select(lv.greaterThan(4.5), U.bright.sub(1.0).mul(0.2).add(1.0), float(1.0)));
        const isFlame = step(0.16, temp).toVar();   // flames (not the smoke's orange underside)
        const fireOn = step(b.mul(0.35).add(0.5), cov).mul(isFlame).toVar();
        const glowOn = float(1.0).sub(fireOn).mul(step(0.18, cov)).mul(isFlame);   // a rim round the flames (not thin veils)
        col.addAssign(rampMix(tempS, hwS).mul(covS).mul(float(1.0).sub(step(0.16, tempS))));   // the smoke's glow from below stays soft
        col.assign(mix(col, rim.element(hd), glowOn.mul(0.9)));
        col.assign(mix(col, c, fireOn));
      } else {
        const { v, hw } = volSmooth(vUv, true);
        const A = clamp(float(1.0).sub(v.a), 0.0, 1.0).toVar();
        const cov = clamp(v.r.mul(U.exposure), 0.0, 1.0).toVar();                // fire coverage
        const temp = clamp(v.g.div(max(v.r, 1e-4)), 0.0, 1.0).toVar();          // emission-weighted temperature
        // the cool flame edge (#a3241a) reads as a rim; HDR only at the hot cores
        const rimW = smoothstep(0.14, 0.19, temp).mul(float(1.0).sub(smoothstep(0.26, 0.42, temp))).toVar();
        const fire = rampMix(temp, hw).mul(mix(cov, sqrt(cov), rimW.mul(0.6))).mul(U.rimGain.mul(rimW).add(1.0)).mul(mix(1.0, U.bright, smoothstep(0.8, 1.0, temp)));
        const As = clamp(A.sub(cov), 0.0, 1.0);
        const smoke = max(U.smokeCol.mul(v.b), scene.mul(As).mul(U.smokeFloor));   // never much darker than what it covers
        col.assign(scene.mul(float(1.0).sub(A)).add(smoke).add(fire));
      }
      return vec4(col, 1.0);
    })();
  }

  /** Materials are cached per style/step count (never disposed on a switch, so their pipelines stay built). */
  _build() {
    for (const hue of [false, true]) {
      const ck = 'c' + this.style + (hue ? 'h' : '');
      for (const inf of [false, true]) {
        const mk = 'm' + this.maxSteps + (hue ? 'h' : '') + (inf ? 'f' : '');
        if (!this.cache.has(mk)) { const m = this._pass(this._marchNode({ steps: this.maxSteps, hue, inFire: inf })); m.name = 'fw-march-' + mk; this.cache.set(mk, m); }
      }
      if (!this.cache.has(ck)) { const m = this._pass(this._compositeNode({ hybrid: this.style === 'hybrid', hue })); m.name = 'fw-composite-' + ck; this.cache.set(ck, m); }
    }
    const k = this.hueOn ? 'h' : '';
    this.marchMat = this.cache.get('m' + this.maxSteps + k + (this.inFireOn ? 'f' : '')); this.compMat = this.cache.get('c' + this.style + k);
  }
  _pass(node) { return passMaterial(node); }

  /** Every variant of the current style/steps (warm-up). */
  variants() { return ['', 'h'].flatMap((k) => [this.cache.get('m' + this.maxSteps + k), this.cache.get('m' + this.maxSteps + k + 'f'), this.cache.get('c' + this.style + k)]); }

  /** The eye in fire (0..1): picks the INFIRE march while it is above ≈ 0.01. */
  setCamFire(x) { this.camFire = x; const on = x > 0.01; if (on !== this.inFireOn) { this.inFireOn = on; this._build(); } }
  /** Coloured fire alive or not: picks the shader variants (index.js, once a frame). */
  setHue(on) { on = !!on; if (on !== this.hueOn) { this.hueOn = on; this._build(); } }
  setStyle(style) { if (style !== this.style) { this.style = style; this._applySteps(); this._build(); this.w = 0; } }
  /** Tier steps; hybrid marches a quarter of the pixels, so it takes finer steps (classic's numbers). */
  setSteps(n, scale) { this.tierSteps = [n, scale]; this._applySteps(); this._build(); }
  _applySteps() {
    const [n, scale] = this.tierSteps || [64, 1];
    this.maxSteps = this.style === 'hybrid' ? Math.round(n * 1.35) : n;
    this.stepScale = this.style === 'hybrid' ? scale * 0.7 : scale;
  }
  /** Fire-pixel size for hybrid: ≈ 4 screen px at 1080p. */
  pixelSize(height) { return this.style === 'hybrid' ? Math.max(2, Math.round(height / 270)) : 2; }

  _ensure(width, height) {
    const k = this.pixelSize(height);
    const w = Math.max(1, Math.ceil(width / k)), h = Math.max(1, Math.ceil(height / k));
    if (this.rt && w === this.w && h === this.h) return;
    this.rt = this._target(w, h);
    this.w = w; this.h = h;
    this.mu.volRes.value.set(w, h);
  }
  _target(w, h) {
    this.rts = this.rts || new Map();
    const key = w + 'x' + h;
    let rt = this.rts.get(key);
    if (!rt) {
      rt = makeTarget(w, h, { type: HalfFloatType, filter: NearestFilter, count: 2 });   // [0] fire/smoke/T, [1] hue mass
      this.rts.set(key, rt);
      if (this.rts.size > 4) { for (const [k2, r2] of this.rts) if (r2 !== rt && r2 !== this.rt) { r2.dispose(); this.rts.delete(k2); break; } }
    }
    return rt;
  }
  /** Allocate (and clear) both styles' targets for a screen size. */
  prealloc(width, height) {
    for (const k of [2, Math.max(2, Math.round(height / 270))]) clearTargets(this.renderer, [this._target(Math.max(1, Math.ceil(width / k)), Math.max(1, Math.ceil(height / k)))], 0x000000, 1);
  }
  /** Forget the targets of a size (warm()'s small frames). */
  dropSize(width, height) {
    for (const k of [2, Math.max(2, Math.round(height / 270))]) {
      const key = Math.max(1, Math.ceil(width / k)) + 'x' + Math.max(1, Math.ceil(height / k)), rt = this.rts?.get(key);
      if (rt) { if (rt === this.rt) { this.rt = null; this.w = 0; this.h = 0; } rt.dispose(); this.rts.delete(key); }
    }
  }

  /** Point the shared depth nodes at this frame's camera + depth. */
  setCamera(camera, depthTex) {
    this.D.set(camera, depthTex);
    this.mu.camPos.value.setFromMatrixPosition(camera.matrixWorld);
  }

  /** March into the volume target (the jet then adds into it). */
  march(solver, { width, height, time }) {
    this._ensure(width, height);
    const u = this.mu, T = this.mt;
    T.S.value = solver.S.read.textures[0]; T.hueMap.value = solver.hueRT.texture; T.vel.value = solver.V.read.texture; T.light.value = solver.lightRT.texture;
    u.time.value = time; this.frame++; u.jitter.value = this.style === 'hybrid' ? 0 : 1;
    const rn = solver.rain || 0; this.rain = rn;
    u.flameH.value = LOOK.flameH * (1 - LOOK.rainFlame * rn); u.lean.value = LOOK.lean; u.smokeLean.value = LOOK.smokeLean; u.fireGain.value = LOOK.fireGain;
    u.smokeK.value = LOOK.smokeK; u.smokeTop.value = LOOK.smokeTop; u.nearFade.value = LOOK.nearFade; u.stepScale.value = this.stepScale;
    u.inFire.value.set(LOOK.inFireFade0, LOOK.inFireFade1, LOOK.inFireSheet); u.inFireCool.value = LOOK.inFireCool; u.camFire.value = this.camFire || 0; u.coreHeat.value = LOOK.coreHeat; u.wallFade.value = LOOK.wallFade;
    u.sheetGain.value = LOOK.sheetGain; u.sheetH.value = LOOK.sheetH; u.smokeGlow.value = LOOK.smokeGlow;
    u.smokeMaxA.value = LOOK.smokeMaxA; u.smokeFar.value = LOOK.smokeFar; u.fineStep.value = LOOK.fineStep; u.tall.value = LOOK.tall;
    this.quad.run(this.renderer, this.marchMat, this.rt);
  }

  /** An empty volume (the ground fire is off): T = 1. */
  clear(width, height) {
    this._ensure(width, height);
    clearTargets(this.renderer, [this.rt], 0x000000, 1);
    this.renderer.setRenderTarget(this.rt);
  }

  composite(colorTex, target, width, height) {
    const u = this.cu, T = this.ct;
    T.scene.value = colorTex; T.vol.value = this.rt.textures[0]; T.volHue.value = this.rt.textures[1];
    u.exposure.value = LOOK.fireExposure; u.bright.value = LOOK.bright; u.softSmoke.value = LOOK.softSmoke; u.rimGain.value = LOOK.rimGain;
    const st = LOOK.rainSteam * (this.rain || 0);   // steamy, paler smoke in the rain
    u.smokeCol.value.set(SMOKE_COL[0] + (STEAM_COL[0] - SMOKE_COL[0]) * st, SMOKE_COL[1] + (STEAM_COL[1] - SMOKE_COL[1]) * st, SMOKE_COL[2] + (STEAM_COL[2] - SMOKE_COL[2]) * st);
    this.quad.run(this.renderer, this.compMat, target);
  }

  dispose() { for (const rt of (this.rts || new Map()).values()) rt.dispose(); this.rt = null; for (const m of this.cache.values()) m.dispose(); }
}
