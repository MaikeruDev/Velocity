import { BackSide, DoubleSide, FrontSide, GLSL3, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { IUniform, Texture } from 'three';
import { GLSL_BAYER } from '../materials/shared';

/**
 * Materialien des Viewmodels (Plan 006). Die Viewmodel-Kamera sitzt fest im Ursprung und
 * schaut nach −z, deshalb rechnen die Shader direkt im View-Raum (Licht kommt "aus der
 * Kamera", egal wohin der Spieler blickt — wie bei jedem Viewmodel).
 *
 * - Lit: PS2-Vertex-Licht (Gouraud): Hemisphäre in der Level-Umgebungsfarbe (entsättigt,
 *   sonst wäre der weiße Handschuh lila) + Schlüssellicht von oben links aus Kamerarichtung
 *   mit "Wrap" (weiche Graustufen statt harter Terminator) + schmaler Rim in der Trim-Farbe.
 *   Kein Fog, kein Vertex-Snapping (die Hand würde zittern).
 * - Outline: Inverted Hull — Rückseiten, im Clip-Space um `uPx` Low-Res-Pixel entlang der
 *   projizierten Normale geschoben. Pixelgenau statt in Welt-Einheiten: so ist die Kontur bei
 *   jeder Entfernung (Wurf!) gleich dick, wie in den Referenzen.
 * Beide können per Bayer-Screen-Door ausblenden (`uVis`, Karten-Zaubertrick) — kein Blending.
 *
 * Plan 007: optional Vertex-Farbe (USE_VCOLOR, Teile eines Slots in einer Geometrie), gestuftes
 * Glanzband (SHEEN, Gold/Chrom — 3 harte Stufen statt PBR-Glanz) und ein Leucht-Regler (GLOW,
 * Roboter-LED im Takt). Ohne diese Optionen erzeugt der Präprozessor denselben Shader wie vorher.
 */

export interface VmLightUniforms {
  readonly uAmbSky: IUniform<Vector3>;
  readonly uAmbGround: IUniform<Vector3>;
  readonly uKeyDir: IUniform<Vector3>;
  readonly uKeyColor: IUniform<Vector3>;
  readonly uRimColor: IUniform<Vector3>;
  readonly uRes: IUniform<Vector2>;
  readonly uTime: IUniform<number>;
}

/**
 * Skalares Uniform, das pro Frame neu beschrieben wird (Zeit, Kick-Glühen, Unschärfe, Funkeln).
 * Warum eine Klasse: alle `{ value: … }`-Literale teilen sich in V8 EINE Map, und weil viele davon
 * Vektoren halten, ist das Feld "tagged" — jede Zuweisung einer Kommazahl boxt eine neue HeapNumber
 * (gemessen ~1 KiB/s je Uniform). Eine eigene Klasse mit Double-Startwert hält das Feld als Double,
 * Zuweisungen schreiben in place.
 */
export class ScalarUniform implements IUniform<number> {
  value = 0.5;

  constructor(v: number) {
    this.value = v;
  }
}

export function createVmLight(): VmLightUniforms {
  return {
    uAmbSky: { value: new Vector3(0.42, 0.42, 0.46) },
    uAmbGround: { value: new Vector3(0.2, 0.19, 0.25) },
    uKeyDir: { value: new Vector3(-0.55, 0.78, 0.3).normalize() },
    uKeyColor: { value: new Vector3(0.66, 0.65, 0.64) },
    uRimColor: { value: new Vector3(0.2, 0.9, 1.0) },
    uRes: { value: new Vector2(480, 270) },
    uTime: new ScalarUniform(0),
  };
}

const LIT_VERT = /* glsl */ `
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uRimColor;
uniform float uRim;
uniform float uWrap;
#ifdef UV_SCROLL
uniform float uScroll;
#endif
out vec3 vLight;
out vec3 vRim;
out vec2 vUv;
out vec3 vN;
out vec3 vPos;
#ifdef USE_VCOLOR
out vec3 vCol;
#endif
void main() {
  vec3 n = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Licht im View-Raum: Hemisphäre (oben/unten) + Schlüssellicht mit Wrap.
  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
  float k = dot(n, uKeyDir);
  float key = clamp((k + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  vLight = amb + uKeyColor * key;
  // Rim: Kante zur Kamera hin quer, nur unten/außen (wie das Rim der alten Sprite-Hand).
  vec3 v = normalize(-mv.xyz);
  float edge = 1.0 - clamp(dot(n, v), 0.0, 1.0);
  float side = clamp(-n.y * 0.6 + n.x * 0.5 + 0.2, 0.0, 1.0);
  vRim = uRimColor * (uRim * smoothstep(0.55, 0.95, edge) * side);
#ifdef UV_SCROLL
  vUv = uv + vec2(0.0, uScroll);
#else
  vUv = uv;
#endif
  vN = n;
  vPos = mv.xyz;
#ifdef USE_VCOLOR
  vCol = color;
#endif
  gl_Position = projectionMatrix * mv;
}
`;

const LIT_FRAG = /* glsl */ `
${GLSL_BAYER}
uniform vec3 uColor;
uniform vec3 uEmissive;
uniform float uVis;
uniform float uTime;
uniform float uInk;
uniform vec3 uInkColor;
#ifdef USE_TEX
uniform sampler2D uMap;
#endif
#ifdef HOLO
uniform float uHolo;
#endif
#ifdef SHEEN
uniform float uSheen;
uniform vec3 uSheenColor;
#endif
#ifdef GLOW
uniform float uGlow;
#endif
in vec3 vLight;
in vec3 vRim;
in vec2 vUv;
in vec3 vN;
in vec3 vPos;
#ifdef USE_VCOLOR
in vec3 vCol;
#endif
out vec4 fragColor;
void main() {
  if (uVis < 0.999 && bayer4(ivec2(gl_FragCoord.xy)) >= uVis) discard;
#ifdef USE_VCOLOR
  vec3 base = uColor * vCol;
#else
  vec3 base = uColor;
#endif
  float emis = 0.0;
#ifdef USE_TEX
  vec4 t = texture(uMap, vUv);
  base *= t.rgb;
  // Alpha < 1 in der Textur = selbstleuchtend (Neon-Motiv), wie bei der Welt.
  emis = clamp((1.0 - t.a) * 2.0, 0.0, 1.0);
#endif
#ifdef GLOW
  vec3 c = base * mix(vLight, vec3(1.05), emis) + vRim + uEmissive * uGlow;
#else
  vec3 c = base * mix(vLight, vec3(1.05), emis) + vRim + uEmissive;
#endif
#ifdef SHEEN
  // Umgebungs-Glanz als gestuftes Band (kein PBR): Reflexion des Blicks je Pixel, heller
  // Horizont-Streifen + Himmelsglanz, auf 3 harte Stufen quantisiert — liest sich wie Chrom/Gold
  // auf PS2 (Environment-Map-Look) und bleibt im Low-Res-Raster sauber begrenzt.
  vec3 rr = reflect(normalize(vPos), normalize(vN));
  float sheenBand = smoothstep(0.05, 0.3, rr.y) * (1.0 - smoothstep(0.35, 0.6, rr.y)) + 0.8 * smoothstep(0.8, 0.98, rr.y);
  c += uSheenColor * (uSheen * floor(sheenBand * 3.0 + 0.5) / 3.0);
#endif
  // Tinten-Kante: wo die Fläche streifend zur Kamera steht, Konturfarbe. Die Inverted Hull
  // zeichnet nur die Außen-Silhouette — so bekommen auch Finger vor Fingern und Daumen vor
  // Handfläche ihre dunkle Trennlinie wie in den Referenzen.
  if (uInk > 0.0 && dot(normalize(vN), normalize(-vPos)) < uInk) c = uInkColor;
#ifdef HOLO
  // Holo-Folie: Regenbogen-Streifen, die mit dem Blickwinkel wandern (nur wo die Textur
  // Folie markiert: Blau-Kanal-Bit über Alpha 0.75..0.99 wäre zu fein → eigene Maske über uv).
  float foil = step(0.08, vUv.x) * step(vUv.x, 0.92) * step(0.47, vUv.y) * step(vUv.y, 0.9);
  float ph = vUv.x * 3.0 + vUv.y * 2.0 + vN.x * 2.5 + vN.y * 1.5 + uTime * 0.15;
  vec3 rainbow = 0.5 + 0.5 * cos(6.2831 * (ph + vec3(0.0, 0.33, 0.67)));
  float band = smoothstep(0.35, 0.5, fract(ph * 0.5)) * smoothstep(0.75, 0.6, fract(ph * 0.5));
  c += rainbow * (uHolo * (0.12 + 0.45 * band) * foil);
#endif
  fragColor = vec4(c, 1.0);
}
`;

const OUTLINE_VERT = /* glsl */ `
uniform vec2 uRes;
uniform float uPx;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  // Normale in Bildschirm-Pixel projizieren, dort normieren → Kontur in ganzen Low-Res-Pixeln.
  // Ableitung der Projektion an diesem Punkt: d(ndc) = (Pn.xy − ndc·Pn.w) / w. Ohne den
  // zweiten Term zeigt die Richtung bei Teilen weit außen/nah an der Kamera falsch und die
  // Kontur verschwindet an ganzen Silhouetten (Stulpe, Finger am Bildrand).
  vec4 pn = projectionMatrix * vec4(n, 0.0);
  vec2 d = (pn.xy - clip.xy / clip.w * pn.w) * uRes;
  // Chebyshev-Norm (max |x|,|y|) statt Länge: das ist ein quadratischer Pinsel — genau die
  // Dilatation im Pixelraster; schräge Kanten werden nicht dünner als waagerechte.
  float l = max(abs(d.x), abs(d.y));
  if (l > 1e-5) clip.xy += (d / l) * (uPx * 2.0 / uRes) * clip.w;
  // Minimal nach hinten, damit die Hülle nie vor der eigenen Fläche flackert.
  clip.z += 0.002 * clip.w;
  gl_Position = clip;
}
`;

const OUTLINE_FRAG = /* glsl */ `
${GLSL_BAYER}
uniform vec3 uColor;
uniform float uVis;
out vec4 fragColor;
void main() {
  if (uVis < 0.999 && bayer4(ivec2(gl_FragCoord.xy)) >= uVis) discard;
  fragColor = vec4(uColor, 1.0);
}
`;

export interface LitOptions {
  readonly color: number;
  readonly map?: Texture;
  readonly holo?: boolean;
  /** Rim-Stärke (0 = aus). */
  readonly rim?: number;
  /** Wrap des Schlüssellichts (0 = hart, 1 = sehr weich). */
  readonly wrap?: number;
  readonly doubleSided?: boolean;
  readonly emissive?: number;
  /** Tinten-Kante: Schwelle für n·v (0 = aus, ~0.25 = dünne Innenlinien). */
  readonly ink?: number;
  readonly inkColor?: number;
  /** Vertex-Farbe (Attribut `color`) multipliziert die Grundfarbe (Plan 007: Teile je Slot zusammengeführt). */
  readonly vertexColors?: boolean;
  /** Gestuftes Glanzband, Stärke 0..1 (Gold, Chrom); Farbe `sheenColor` (Standard warmes Weiß). */
  readonly sheen?: number;
  readonly sheenColor?: number;
  /** Leucht-Regler: Emissive × glow.value (geteiltes Uniform, z. B. Roboter-LED im Takt der Kick). */
  readonly glow?: IUniform<number>;
  /** Textur-Versatz in v (Handy-Feed scrollt ohne neuen Upload), geteiltes Uniform. */
  readonly scroll?: IUniform<number>;
  /** Einziehbare Krallen (Katze): Vertex-Attribut aClaw (0/1) fährt um (1 − uClaw) · Länge zurück (−y). */
  readonly claws?: ClawUniforms;
}

/** Krallen-Ausfahren (Katzen-Skin): Anteil 0..1 (skinFx) und Rückzugs-Länge (Hand-Einheiten). */
export interface ClawUniforms {
  readonly out: IUniform<number>;
  readonly len: IUniform<number>;
}

const CLAW_DECL = `in float aClaw;\nuniform float uClaw;\nuniform float uClawLen;\n`;

/**
 * Krallen in einen Vertex-Shader einsetzen: Position der Krallen-Vertices entlang −y zurückziehen.
 * NUR für Katzen-Materialien — die übrigen Shader bleiben Zeichen für Zeichen gleich (Pixelgleichheit,
 * Programm-Cache). Wirft, wenn die Stelle fehlt (Shader geändert → hier nachziehen).
 */
function withClaws(src: string, find: string): string {
  if (!src.includes(find)) throw new Error('withClaws: Stelle fehlt im Shader');
  const moved = find.replace('vec4(position, 1.0)', 'vec4(position - vec3(0.0, uClawLen * aClaw * (1.0 - uClaw), 0.0), 1.0)');
  return CLAW_DECL + src.replace(find, moved);
}

export function createLitMaterial(light: VmLightUniforms, o: LitOptions): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (o.map) defines.USE_TEX = '';
  if (o.holo) defines.HOLO = '';
  if (o.vertexColors) defines.USE_VCOLOR = '';
  const sheen = o.sheen ?? 0;
  if (sheen > 0) defines.SHEEN = '';
  if (o.glow) defines.GLOW = '';
  if (o.scroll) defines.UV_SCROLL = '';
  const uniforms: Record<string, IUniform> = {
    uAmbSky: light.uAmbSky,
    uAmbGround: light.uAmbGround,
    uKeyDir: light.uKeyDir,
    uKeyColor: light.uKeyColor,
    uRimColor: light.uRimColor,
    uTime: light.uTime,
    uRim: { value: o.rim ?? 0.35 },
    uWrap: { value: o.wrap ?? 0.55 },
    uColor: { value: hexVec(o.color) },
    uEmissive: { value: hexVec(o.emissive ?? 0x000000) },
    uVis: { value: 1 },
    uInk: { value: o.ink ?? 0 },
    uInkColor: { value: hexVec(o.inkColor ?? 0x0d0c14) },
    uMap: { value: o.map ?? null },
    uHolo: { value: 1 },
  };
  if (sheen > 0) {
    uniforms.uSheen = { value: sheen };
    uniforms.uSheenColor = { value: hexVec(o.sheenColor ?? 0xffed9e) };
  }
  if (o.glow) uniforms.uGlow = o.glow;
  if (o.scroll) uniforms.uScroll = o.scroll;
  if (o.claws) {
    uniforms.uClaw = o.claws.out;
    uniforms.uClawLen = o.claws.len;
  }
  const m = new ShaderMaterial({
    name: 'VmLit',
    glslVersion: GLSL3,
    vertexShader: o.claws ? withClaws(LIT_VERT, 'vec4 mv = modelViewMatrix * vec4(position, 1.0);') : LIT_VERT,
    fragmentShader: LIT_FRAG,
    side: o.doubleSided ? DoubleSide : FrontSide,
    defines,
    uniforms,
  });
  // three deklariert das Attribut `color` nur mit vertexColors (USE_COLOR im Präfix).
  if (o.vertexColors) m.vertexColors = true;
  return m;
}

export function createOutlineMaterial(light: VmLightUniforms, color: number, px: IUniform<number>, claws?: ClawUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    uRes: light.uRes,
    uPx: px,
    uColor: { value: hexVec(color) },
    uVis: { value: 1 },
  };
  if (claws) {
    uniforms.uClaw = claws.out;
    uniforms.uClawLen = claws.len;
  }
  return new ShaderMaterial({
    name: 'VmOutline',
    glslVersion: GLSL3,
    vertexShader: claws ? withClaws(OUTLINE_VERT, 'vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);') : OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: BackSide,
    uniforms,
  });
}

/**
 * Hex → Vector3 0..1 OHNE Farbraum-Umrechnung (three.Color linearisiert sRGB-Hex; die ganze
 * PS2-Pipeline rechnet aber in Anzeige-Werten — wie setVecFromHex für die Welt).
 */
export function hexVec(hex: number): Vector3 {
  return new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}

export function setHexVec(v: Vector3, hex: number): Vector3 {
  return v.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}
