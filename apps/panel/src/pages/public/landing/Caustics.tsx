import { useEffect, useRef } from "react";

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

/*
 * Tank water: a deep teal column lit from above, with the moving net of light a water surface
 * throws onto everything under it. Iterated domain warp; each pass bends the coordinates by the
 * last, and the thin bright ridges where they fold are the caustic lines.
 */
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;
void main(){
  vec2 uv=gl_FragCoord.xy/r;
  float aspect=r.x/r.y;
  vec2 p=vec2(uv.x*aspect,uv.y)*2.4;
  p=mod(p*6.2831,6.2831)-250.;
  vec2 i=p;float c=1.;
  for(int n=0;n<4;n++){
    float tt=t*(1.-(3.5/float(n+1)));
    i=p+vec2(cos(tt-i.x)+sin(tt+i.y),sin(tt-i.y)+cos(tt+i.x));
    c+=1./length(vec2(p.x/(sin(i.x+tt)/.006),p.y/(cos(i.y+tt)/.006)));
  }
  c/=4.;c=1.17-pow(c,1.4);
  float v=pow(abs(c),9.);
  float top=smoothstep(.05,1.,uv.y);
  vec3 deep=vec3(.008,.07,.09);
  vec3 mid=vec3(.02,.24,.29);
  vec3 col=mix(deep,mid,pow(top,1.6));
  float shaft=smoothstep(.55,0.,abs(uv.x-.62+(1.-uv.y)*.12))*top*.22;
  col+=vec3(.35,.62,.62)*shaft;
  col+=vec3(.55,.9,.88)*v*(.22+.7*top);
  gl_FragColor=vec4(col,1.);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

/**
 * The water behind the glass, drawn at a quarter of the pixels (it is soft anyway). Paused when it
 * is off screen or the tab is hidden; under reduced motion it draws one still frame. Without WebGL
 * the element's CSS gradient stays as the water.
 */
export function Caustics({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook.
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uR = gl.getUniformLocation(prog, "r");
    const uT = gl.getUniformLocation(prog, "t");

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scale = 0.5;
    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * scale));
      const h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    const draw = (ms: number) => {
      resize();
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uT, 40 + ms / 1000 / 3.2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    canvas.dataset.ready = "true";

    let raf = 0;
    let visible = true;
    const loop = (ms: number) => {
      draw(ms);
      raf = requestAnimationFrame(loop);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (still.matches || !visible || document.hidden) {
        draw(0);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? true;
      run();
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => draw(performance.now()));
    ro.observe(canvas);
    document.addEventListener("visibilitychange", run);
    still.addEventListener("change", run);
    run();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", run);
      still.removeEventListener("change", run);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden />;
}
