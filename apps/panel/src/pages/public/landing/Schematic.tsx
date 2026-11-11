type Node = { x: number; y: number; w: number; name: string; detail: string; main?: boolean };
type Plan = { box: string; pipes: string[]; nodes: Node[]; zones: { x: number; y: number; text: string }[] };

const WIDE: Plan = {
  box: "0 0 890 480",
  pipes: [
    // Discord ↔ core
    "M190 92 H330",
    // core → inference
    "M520 92 H600 Q620 92 620 112 V160 Q620 180 640 180 H700",
    "M620 112 V60 Q620 40 640 40 H700",
    "M620 160 V270 Q620 290 640 290 H700",
    // core ↔ broadcast
    "M425 130 V250 Q425 270 405 270 H300",
    "M300 360 H425 Q445 360 445 340 V130",
    // broadcast → OBS / VTube Studio
    "M120 270 H60 Q40 270 40 290 V420 Q40 440 60 440 H90",
  ],
  nodes: [
    { x: 20, y: 64, w: 170, name: "Discord", detail: "文字・語音・Go Live" },
    { x: 330, y: 54, w: 190, name: "core", detail: "bot・心智迴圈・面板 :7878", main: true },
    { x: 700, y: 12, w: 170, name: "asr", detail: "Qwen3-ASR :8003" },
    { x: 700, y: 152, w: 170, name: "tts", detail: "Qwen3-TTS :8002" },
    { x: 700, y: 262, w: 170, name: "sing", detail: "Demucs + Seed-VC :8005" },
    { x: 120, y: 242, w: 180, name: "voice-node", detail: "語音與開播" },
    { x: 120, y: 332, w: 180, name: "stage", detail: "overlay :7884" },
    { x: 90, y: 412, w: 220, name: "OBS・VTube Studio", detail: "直播機上的程式" },
  ],
  zones: [
    { x: 700, y: 372, text: "推論機・要 NVIDIA 顯卡" },
    { x: 120, y: 232, text: "直播機" },
  ],
};

/** A phone: core on top, everything hangs off one main down the middle. */
const NARROW: Plan = {
  box: "0 0 360 580",
  pipes: [
    "M180 86 V448",
    "M180 158 H170",
    "M180 290 H170",
    "M180 290 H190",
    "M180 358 H170",
    "M180 448 H170",
    "M180 448 H190",
    "M40 476 V504",
  ],
  nodes: [
    { x: 85, y: 10, w: 190, name: "core", detail: "bot・心智迴圈・面板 :7878", main: true },
    { x: 10, y: 130, w: 160, name: "Discord", detail: "文字・語音・Go Live" },
    { x: 10, y: 262, w: 160, name: "asr", detail: "Qwen3-ASR :8003" },
    { x: 190, y: 262, w: 160, name: "tts", detail: "Qwen3-TTS :8002" },
    { x: 10, y: 330, w: 160, name: "sing", detail: "Seed-VC :8005" },
    { x: 10, y: 420, w: 160, name: "voice-node", detail: "語音與開播" },
    { x: 190, y: 420, w: 160, name: "stage", detail: "overlay :7884" },
    { x: 10, y: 504, w: 220, name: "OBS・VTube Studio", detail: "直播機上的程式" },
  ],
  zones: [
    { x: 10, y: 250, text: "推論機・要 NVIDIA 顯卡" },
    { x: 10, y: 410, text: "直播機" },
  ],
};

/**
 * The keepers' room drawing: Miyoria's services as a wiring diagram in the appendix. Every box is a
 * real service from the README with its real port; the pipes are the connections between them.
 */
export function Schematic({ layout }: { layout: "wide" | "narrow" }) {
  const plan = layout === "wide" ? WIDE : NARROW;
  const id = `mz-plant-title-${layout}`;
  return (
    <svg className={`mz-plant mz-plant-${layout}`} viewBox={plan.box} role="img" aria-labelledby={id}>
      <title id={id}>
        Miyoria 的服務：core 連著 Discord，推論機上的 asr、tts、sing，以及直播機上的 voice-node 和 stage
      </title>
      <g>
        {plan.pipes.map((d) => (
          <g key={d}>
            <path d={d} className="mz-pipe" />
            <path d={d} className="mz-flow" />
          </g>
        ))}
      </g>
      {plan.nodes.map((n) => (
        <g key={n.name} transform={`translate(${n.x} ${n.y})`} className={n.main ? "mz-node mz-node-main" : "mz-node"}>
          <rect width={n.w} height={n.main ? 76 : 56} rx="6" />
          <text x="14" y="24" className="mz-node-name">
            {n.name}
          </text>
          <text x="14" y={n.main ? 48 : 43} className="mz-node-detail">
            {n.detail}
          </text>
        </g>
      ))}
      <g className="mz-plant-zone">
        {plan.zones.map((z) => (
          <text key={z.text} x={z.x} y={z.y}>
            {z.text}
          </text>
        ))}
      </g>
    </svg>
  );
}
