// Scripted feed for `?demo=1`: lets the overlay be designed, previewed in OBS and screenshotted
// without the Stage. It speaks the same messages the Stage sends.
import type { FeedMessage } from "./feed.js";

interface Line {
  emotion: string;
  text: string;
}

const LINES: Line[] = [
  { emotion: "happy", text: "哈囉,今天也來聊天吧!欸等一下,你剛剛說的那個遊戲,我好像也有聽過。" },
  { emotion: "annoyed", text: "哼,才不是在等你呢。只是剛好有空而已。" },
  { emotion: "surprised", text: "咦?真的假的?!這首歌我還沒唱過耶,可以先排進去嗎?" },
  { emotion: "neutral", text: "好,那我們先來看一下接下來的順序。" },
];

export function startDemo(emit: (m: FeedMessage) => void): () => void {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  void (async () => {
    emit({
      type: "status",
      status: { core: true, vts: true, obs: true, scene: "Game", streaming: true },
    });
    emit({
      type: "queue",
      items: [
        { title: "夜に駆ける", by: "小明" },
        { title: "Minecraft:蓋一座塔", by: "阿翔" },
        { title: "聊聊今天的天氣", by: "Mia" },
      ],
    });
    await wait(600);
    for (let turn = 1; !stopped; turn++) {
      const line = LINES[(turn - 1) % LINES.length] as Line;
      emit({ type: "emotion", name: line.emotion, intensity: line.emotion === "neutral" ? 0.6 : 1 });
      emit({ type: "speaking", state: "started" });
      const chars = [...line.text];
      // Streamed in chunks, the way the agent's text arrives.
      for (let i = 0; i < chars.length && !stopped; i += 4) {
        emit({ type: "subtitle", turn: `demo-${turn}`, text: chars.slice(0, i + 4).join(""), final: false });
        await wait(260);
      }
      emit({ type: "subtitle", turn: `demo-${turn}`, text: line.text, final: true });
      await wait(900);
      emit({ type: "speaking", state: "stopped" });
      await wait(5200);
    }
  })();

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
