import { GLSL3, Mesh, NearestFilter, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, OrthographicCamera, UnsignedByteType, Vector3, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { EnvironmentDef } from '../../world/level/LevelFormat';
import { PostPass } from '../post';
import { DEFAULT_RENDER_SETTINGS } from '../types';
import type { ViewModelFrame, ViewModelGlove, ViewModelItem } from '../types';
import { setVecFromHex } from '../util';
import { ViewModel } from './ViewModel';

/**
 * Eigenständige Viewmodel-Vorschau (Kosmetik-Menü, Ergebnis-Banner, Dev-Seite): eigener
 * kleiner WebGL-Kontext in Low-Res, gleiche Hand, gleiche Kontur, gleiche Quantisierung
 * (PostPass mit Dithering, ohne CA/Streifen). Hintergrund: Nachthimmel-Verlauf + Boden mit
 * Trim-Linie, damit Kontur und Rim wie im Spiel wirken. Nur im Menü — hier darf allokiert
 * werden; dispose() gibt den Kontext sofort frei (Browser erlauben nur ~16 gleichzeitig).
 */

const BG_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uFloor;
uniform vec3 uTrim;
uniform float uHorizon;
uniform vec2 uRes;
out vec4 fragColor;
void main() {
  float v = gl_FragCoord.y / uRes.y;
  vec3 c = mix(uBottom, uTop, smoothstep(uHorizon, 1.0, v));
  if (v < uHorizon) c = uFloor * (0.75 + 0.5 * v / uHorizon);
  if (abs(v - uHorizon) * uRes.y < 0.5) c = uTrim;
  fragColor = vec4(c, 1.0);
}
`;

export class ViewModelPreview {
  readonly vm = new ViewModel();
  private readonly renderer: WebGLRenderer;
  private readonly target: WebGLRenderTarget;
  private readonly post: PostPass;
  private readonly bg = new Scene();
  private readonly bgCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bgMat: ShaderMaterial;
  private disposed = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly width: number,
    readonly height: number,
  ) {
    canvas.width = width;
    canvas.height = height;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.target = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      format: RGBAFormat,
      type: UnsignedByteType,
    });
    this.post = new PostPass(this.target.texture);
    this.post.setSettings({ ...DEFAULT_RENDER_SETTINGS, chromatic: 0, scanlines: 0, speedLines: 0 });
    this.post.setResolution(width, height);
    this.bgMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTop: { value: new Vector3(0.08, 0.05, 0.2) },
        uBottom: { value: new Vector3(0.2, 0.1, 0.3) },
        uFloor: { value: new Vector3(0.1, 0.14, 0.25) },
        uTrim: { value: new Vector3(0.2, 0.94, 1) },
        uHorizon: { value: 0.3 },
        uRes: { value: new Vector3(width, height, 0) },
      },
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.bgMat);
    quad.frustumCulled = false;
    this.bg.add(quad);
    this.vm.setResolution(width, height);
  }

  /** Hintergrund (Himmel oben/unten, Boden, Trim) als #rrggbb, Horizont 0..1 der Höhe. */
  setBackground(top: string, bottom: string, floor: string, trim: string, horizon: number): void {
    const u = this.bgMat.uniforms;
    setVecFromHex(u.uTop.value as Vector3, top);
    setVecFromHex(u.uBottom.value as Vector3, bottom);
    setVecFromHex(u.uFloor.value as Vector3, floor);
    setVecFromHex(u.uTrim.value as Vector3, trim);
    u.uHorizon.value = horizon;
  }

  setEnvironment(env: EnvironmentDef): void {
    this.vm.setEnvironment(env);
  }

  prewarm(item: ViewModelItem, glove: ViewModelGlove): void {
    this.vm.prewarm(this.renderer, item, glove);
  }

  render(frame: ViewModelFrame, time: number): void {
    if (this.disposed) return;
    const r = this.renderer;
    this.vm.setTime(time);
    r.setRenderTarget(this.target);
    r.render(this.bg, this.bgCam);
    if (frame.visible) {
      this.vm.apply(frame);
      this.vm.render(r);
    }
    r.setRenderTarget(null);
    this.post.update({ time, speed01: 0, kick: 0, flash: 0, flashColor: [1, 1, 1], fade: 0 });
    r.render(this.post.scene, this.post.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vm.dispose();
    this.post.dispose();
    this.bgMat.dispose();
    this.target.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
