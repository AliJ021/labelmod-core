import { useEffect, useRef } from "react";
import { tokenRgb } from "../../lib/fabric.ts";

/**
 * پارچهٔ خردلی ورود و قفل (طرح ۱۰؛ الهام از «لایه‌های پارچه» در برندبوک).
 *
 * فقط زیر `Backdrop variant="auth"` می‌نشیند؛ صفحه‌های داده هرگز حرکت
 * بی‌پایان پشت عدد مالی ندارند (ADR-002). بودجه‌اش عمداً کوچک است:
 *
 *   - نیم‌وضوح و سقف ۳۰ فریم؛ در تب پنهان هیچ فریمی کشیده نمی‌شود.
 *   - کاهش حرکت: یک فریم ایستا، بی حلقه.
 *   - حالت عملکرد یا کاهش شفافیت: اصلاً ساخته نمی‌شود و زمینهٔ CSS می‌ماند.
 *   - نبود WebGL یا شکست Shader: هیچ خطایی؛ همان مِش CSS زیرش هست.
 *
 * رنگ‌ها از توکن‌ها خوانده می‌شوند (--bg-deep، --brand، --brand-2)، نه از
 * عدد درون Shader؛ پس تم و پالت یک منبع دارند.
 */
const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FS = `precision mediump float;
uniform vec2 r;uniform float t;uniform float light;uniform vec3 base;uniform vec3 m1;uniform vec3 m2;
float h(float x,float i,float t){return .16+i*.145+.055*sin(x*2.1+t*.33+i*1.7)+.028*sin(x*4.6-t*.24+i*2.3);}
void main(){vec2 uv=gl_FragCoord.xy/r;float x=uv.x*r.x/r.y;vec3 col=base;
for(int k=0;k<6;k++){float i=float(k);float d=uv.y-h(x,i,t);
float on=smoothstep(-.006,.006,d);float dd=max(d,0.);float shade=exp(-dd*12.);float lip=exp(-dd*85.)*on;
vec3 m=mix(m2,m1,mod(i,2.));
float a=mix(.07,.16,light)+mix(.20,.26,light)*shade;col=mix(col,mix(base,m,a)+lip*mix(.09,.05,light),on);}
float v=smoothstep(1.25,.25,length(uv-vec2(.62,.55)));col=mix(base,col,.55+.45*v);
gl_FragColor=vec4(col,1.);}`;

export function Fabric() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const root = document.documentElement;
    if (!canvas) return;
    // نتیجه همیشه اعلام می‌شود — live یا off — تا آزمون و CSS هرگز بین دو حالت حدس نزنند.
    const off = () => { canvas.dataset.fabric = "off"; };
    if (root.dataset.perf === "on") return off();
    // کاهش شفافیت زمینهٔ CSS را می‌خواهد (glass.css پنهانش می‌کند)؛ پس بوم حتی ساخته نمی‌شود.
    if (root.dataset.perf !== "off" && matchMedia("(prefers-reduced-transparency: reduce)").matches) return off();
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) return off();
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VS);
    const fs = shader(gl.FRAGMENT_SHADER, FS);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return off();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return off();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const ur = u("r"), ut = u("t"), ul = u("light"), ub = u("base"), um1 = u("m1"), um2 = u("m2");

    let ready = false;
    const readColors = () => {
      const css = getComputedStyle(root);
      const base = tokenRgb(css.getPropertyValue("--bg-deep"));
      const m1 = tokenRgb(css.getPropertyValue("--brand"));
      const m2 = tokenRgb(css.getPropertyValue("--brand-2"));
      ready = Boolean(base && m1 && m2);
      if (!base || !m1 || !m2) return;
      gl.uniform3f(ub, ...base);
      gl.uniform3f(um1, ...m1);
      gl.uniform3f(um2, ...m2);
      // روشنایی زمینه تم را می‌گوید؛ «سیستم» هم بی data-theme درست درمی‌آید.
      gl.uniform1f(ul, base[0] + base[1] + base[2] > 1.5 ? 1 : 0);
    };

    const probe = canvas as HTMLCanvasElement & { lmcFrames?: number };
    const scale = 0.5;
    const t0 = performance.now();
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      if (!ready) return;
      gl.uniform2f(ur, canvas.width, canvas.height);
      gl.uniform1f(ut, (now - t0) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.dataset.drawn = "1";
      // شمارندهٔ فریم بیرون از DOM: آزمون مرورگر حرکت واقعی را می‌سنجد بی آنکه هر فریم یک تغییر ویژگی بسازد.
      probe.lmcFrames = (probe.lmcFrames ?? 0) + 1;
    };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const still = () => draw(t0 + 4000);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return;
      last = now;
      draw(now);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      if (reduce.matches || document.hidden || root.dataset.perf === "on") {
        canvas.dataset.motion = "still";
        still();
        return;
      }
      canvas.dataset.motion = "moving";
      raf = requestAnimationFrame(loop);
    };
    const size = () => {
      canvas.width = Math.max(2, Math.round(innerWidth * scale));
      canvas.height = Math.max(2, Math.round(innerHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (reduce.matches) still();
    };
    const restyle = () => { readColors(); start(); };
    const scheme = matchMedia("(prefers-color-scheme: dark)");

    readColors();
    if (!ready) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return off();
    }
    size();
    // فریم اول همین‌جا و هم‌زمان کشیده می‌شود: «live» یعنی بوم واقعاً تصویر دارد، نه «به‌زودی».
    draw(performance.now());
    start();
    canvas.classList.add("is-live");
    canvas.dataset.fabric = "live";
    addEventListener("resize", size);
    document.addEventListener("visibilitychange", start);
    reduce.addEventListener("change", start);
    scheme.addEventListener("change", restyle);
    const observer = new MutationObserver(restyle);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-perf"] });

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", size);
      document.removeEventListener("visibilitychange", start);
      reduce.removeEventListener("change", start);
      scheme.removeEventListener("change", restyle);
      observer.disconnect();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={ref} className="fabric" aria-hidden="true" />;
}
