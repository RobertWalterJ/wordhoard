// Landfall — colour science, so the palette is measured rather than asserted.
//
// "Colourblind-friendly" is usually taken to mean "avoid red and green", which
// is both a shame and not the actual requirement. The requirement is that NO
// INFORMATION IS LOST: for any two things the app needs you to tell apart,
// something other than hue has to separate them. A palette can be as saturated
// and as regional as you like provided that test passes.
//
// So this file gives the three numbers needed to run that test:
//   contrast()   WCAG 2.1 relative-luminance ratio. Survives ANY colour vision,
//                including total achromatopsia, because it is lightness alone.
//   deltaE()     CIEDE2000 perceptual difference — the full-colour judgement.
//   simulate()   the palette as a dichromat sees it, so deltaE can be re-run
//                through protanopia, deuteranopia and tritanopia.
//
// Dichromacy simulation is Machado, Oliveira & Gomes (2009), "A Physiologically-
// based Model for Simulation of Color Vision Deficiency", IEEE TVCG 15(6). The
// matrices act on LINEAR RGB and are given here at severity 1.0, i.e. true
// dichromacy — the worst case, which is the one worth designing against.
// Anomalous trichromacy (the far commoner form) is strictly milder, and
// severity can be sampled by mixing with identity.

// -- transfer ------------------------------------------------------------
export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function parse(hex) {
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

export const format = (rgb) => '#' + rgb
  .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
  .join('').toUpperCase();

// Flatten a translucent colour onto what is actually behind it. A veil at 10%
// alpha is not a colour anyone sees; the composite is.
export function over(fg, alpha, bg) {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
}

// -- WCAG relative luminance and contrast --------------------------------
export function luminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// -- CIE Lab -------------------------------------------------------------
const WHITE = [0.95047, 1, 1.08883];            // D65, 2 degree observer

export function toLab(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0],
    (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / WHITE[1],
    (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WHITE[2],
  ];
  const f = xyz.map((v) => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

// CIEDE2000 (Sharma, Wu & Dalal 2005 formulation). Roughly: under 2 is a
// match, under 10 is a near-match, over 25 is unmistakable.
export function deltaE(rgbA, rgbB) {
  const [L1, a1, b1] = toLab(rgbA), [L2, a2, b2] = toLab(rgbB);
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (b, ap) => { if (b === 0 && ap === 0) return 0; const h = Math.atan2(b, ap) * deg; return h < 0 ? h + 360 : h; };
  const hp1 = hp(b1, ap1), hp2 = hp(b2, ap2);
  const dLp = L2 - L1, dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * rad);
  const Lbar = (L1 + L2) / 2, Cpbar = (Cp1 + Cp2) / 2;
  let hpbar = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hpbar += (hp1 + hp2 < 360) ? 360 : -360;
    hpbar /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hpbar - 30) * rad) + 0.24 * Math.cos(2 * hpbar * rad)
    + 0.32 * Math.cos((3 * hpbar + 6) * rad) - 0.20 * Math.cos((4 * hpbar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpbar - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cpbar;
  const Sh = 1 + 0.015 * Cpbar * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// -- colour vision deficiency -------------------------------------------
// Machado et al. 2009, severity 1.0, applied to linear RGB.
const CVD = {
  protanopia: [                      // no long-wave (red) cone. ~1% of men.
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [                    // no medium-wave (green) cone. ~1% of men,
    [0.367322, 0.860646, -0.227968], // and anomalous deutan is ~5% more — this
    [0.280085, 0.672501, 0.047413],  // is by far the most common case.
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [                      // no short-wave (blue) cone. Rare, and not
    [1.255528, -0.076749, -0.178779],// sex-linked, so it hits everyone equally.
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

export const VISIONS = ['normal', 'deuteranopia', 'protanopia', 'tritanopia', 'greyscale'];

export function simulate(rgb, vision) {
  if (!vision || vision === 'normal') return rgb;
  if (vision === 'greyscale') {
    // Not a colour vision deficiency: this is the floor. A screen in direct
    // Caribbean sun, a cheap panel, or a printout. If two things separate here
    // they separate everywhere.
    const y = luminance(rgb);
    return [toSrgb(y), toSrgb(y), toSrgb(y)];
  }
  const m = CVD[vision];
  if (!m) throw new Error('unknown vision: ' + vision);
  const lin = rgb.map(toLinear);
  return m.map((row) => toSrgb(Math.max(0, Math.min(1,
    row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))));
}
