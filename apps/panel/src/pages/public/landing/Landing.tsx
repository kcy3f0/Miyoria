import { Check, Copy } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { PublicSong, PublicSongs, PublicStatus } from "@/api/types";
import { useApi } from "@/app/connection";
import { loginNext } from "@/app/session";
import { LIVE_PAGE } from "../live/LivePage";
import { STATE, stateLabel, usePublicSongs, usePublicStatus } from "../PublicSite";
import { mountBlackHole } from "./blackhole";
import basinPoster from "./her/basin.webp";
import basinLoop from "./her/basin.webm";
import chestPoster from "./her/chest.webp";
import chestLoop from "./her/chest.webm";
import fingerPoster from "./her/finger.webp";
import fingerLoop from "./her/finger.webm";
import glassesPoster from "./her/glasses.webp";
import glassesLoop from "./her/glasses.webm";
import grassPoster from "./her/grass.webp";
import grassLoop from "./her/grass.webm";
import heartPoster from "./her/heart.webp";
import heartLoop from "./her/heart.webm";
import singPoster from "./her/sing.webp";
import singLoop from "./her/sing.webm";
import { mountSea } from "./sea";
import "./landing.css";

const REPO = "https://github.com/owenliu0924/Miyoria";
const NAME = "Miyoria";

const STEPS = [
  "git clone https://github.com/owenliu0924/Miyoria",
  "cd Miyoria && node scripts/setup.mjs",
  "pnpm dev doctor",
  "pnpm dev core",
];

const SECTIONS = [
  { id: "moments", label: "日常" },
  { id: "songs", label: "歌單" },
  { id: "watch", label: "直播" },
  { id: "host", label: "自己架" },
];

type Loop = { src: string; poster: string };
const HER = {
  heart: { src: heartLoop, poster: heartPoster },
  glasses: { src: glassesLoop, poster: glassesPoster },
  basin: { src: basinLoop, poster: basinPoster },
  grass: { src: grassLoop, poster: grassPoster },
  sing: { src: singLoop, poster: singPoster },
  finger: { src: fingerLoop, poster: fingerPoster },
  chest: { src: chestLoop, poster: chestPoster },
} satisfies Record<string, Loop>;

const still = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function title(s: PublicSong | null | undefined) {
  return s?.title ?? "還不知道歌名";
}

/** Her, moving: a 4 s loop recorded from her model (only the recording ships, never the model). */
function Her({ loop, className, style, label }: { loop: Loop; className?: string; style?: CSSProperties; label?: string }) {
  const [moving] = useState(() => !still());
  return (
    <video
      className={className}
      style={style}
      src={loop.src}
      poster={loop.poster}
      autoPlay={moving}
      loop
      muted
      playsInline
      preload="auto"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-drift
    />
  );
}

/** A heading whose letters rise one after another once it scrolls in. */
function Rise({ children, id }: { children: string; id?: string }) {
  let i = 0;
  const lines = children.split("\n");
  return (
    <h2 className="ml-h2 ml-rv" id={id} aria-label={children.replace("\n", "")}>
      {lines.map((line, li) => (
        <span key={line} aria-hidden>
          {[...line].map((ch) => (
            <span key={i} className="ml-ch" style={{ "--i": i++ } as CSSProperties}>
              {ch}
            </span>
          ))}
          {li < lines.length - 1 && <br />}
        </span>
      ))}
    </h2>
  );
}

/** The sea under the page and the hole on the cover, both drawn while they can be seen. */
function useScenes(sea: React.RefObject<HTMLCanvasElement | null>, hole: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const seaCanvas = sea.current;
    const holeCanvas = hole.current;
    if (!seaCanvas || !holeCanvas) return;
    const water = mountSea(seaCanvas, Math.min(1, 1.25 / window.devicePixelRatio));
    const bh = mountBlackHole(holeCanvas, window.innerWidth < 700 ? 640 : 1024);
    if (!water && !bh) return;
    if (bh) holeCanvas.dataset.on = "true";
    let scroll = window.scrollY / window.innerHeight;
    const frame = (ms: number) => {
      scroll += (window.scrollY / window.innerHeight - scroll) * 0.08;
      if (bh && window.scrollY < window.innerHeight * 1.1) bh.render(ms / 1000);
      if (water && window.scrollY > window.innerHeight * 0.3) water.render(ms / 1000, scroll);
    };
    const onResize = () => water?.resize();
    window.addEventListener("resize", onResize);
    if (still()) {
      bh?.render(2);
      water?.render(2, 1);
      return () => {
        window.removeEventListener("resize", onResize);
        bh?.dispose();
      };
    }
    let raf = requestAnimationFrame(function loop(ms) {
      if (!document.hidden) frame(ms);
      raf = requestAnimationFrame(loop);
    });
    water?.render(0, 1);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      bh?.dispose();
    };
  }, [sea, hole]);
}

/** Things print in as they come into view, and her pictures drift a little against the scroll. */
function useReveal(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("ml-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.2 },
    );
    const watch = () => {
      for (const n of el.querySelectorAll(".ml-rv:not(.ml-in)")) io.observe(n);
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true, subtree: true });
    const drift = () => {
      for (const v of el.querySelectorAll<HTMLElement>("[data-drift]")) {
        const r = v.getBoundingClientRect();
        const c = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
        v.style.setProperty("--py", `${(c * -40).toFixed(1)}px`);
      }
    };
    if (!still()) window.addEventListener("scroll", drift, { passive: true });
    drift();
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", drift);
    };
  }, [root]);
}

/** Her mark: a whale's tail coming up out of the water. */
function Mark() {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a5e8ff" />
          <stop offset="1" stopColor="#3d6ef5" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M12.6 29.5C13.3 26 13.8 22.6 14 19.6C9.6 18.9 5 15.6 2.7 9.4C2.4 8.5 3.2 7.9 4 8.4C7.2 10.7 10.7 11.6 13.4 11.4C14.7 11.3 15.6 12.1 16 13.3C16.4 12.1 17.3 11.3 18.6 11.4C21.3 11.6 24.8 10.7 28 8.4C28.8 7.9 29.6 8.5 29.3 9.4C27 15.6 22.4 18.9 18 19.6C18.2 22.6 18.7 26 19.4 29.5Z" />
    </svg>
  );
}

function DiscordGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="#5865f2" aria-hidden>
      <path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.6 19.6 0 0 0-4.9 1.5C.6 9.1-.3 13.7.1 18.2a19.8 19.8 0 0 0 6 3l1.3-2.1a12.8 12.8 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4-2 1 1.3 2.1a19.7 19.7 0 0 0 6-3c.5-5.2-.8-9.8-3.6-13.8ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  );
}

/** Her state, in one plain line over her name. */
function Now({ status, songs, failed }: { status?: PublicStatus; songs?: PublicSongs; failed: boolean }) {
  let text: ReactNode;
  if (!status) text = failed ? "現在看不到她在幹嘛" : "正在看她在不在…";
  else if (songs?.playing) text = `${stateLabel(status)}，唱到〈${title(songs.playing)}〉了`;
  else text = stateLabel(status);
  return (
    <section className="ml-now ml-fx" style={{ animationDelay: "0.05s" }} aria-label="她現在">
      {status && STATE[status.state].pulse && <span className="ml-now-dot" aria-hidden />}
      <span>{text}</span>
      {status?.live && (
        <a href={LIVE_PAGE} className="ml-now-go">
          去看
        </a>
      )}
    </section>
  );
}

function Av({ me, color }: { me?: boolean; color?: string }) {
  return <span className={me ? "ml-av ml-av-me" : "ml-av"} style={color ? { background: color } : undefined} />;
}

function Msg({ who, me, color, time, children }: { who: string; me?: boolean; color?: string; time?: string; children: ReactNode }) {
  return (
    <div className="ml-msg">
      <Av me={me} color={color} />
      <div>
        <b className={me ? "ml-bot" : undefined}>{who}</b>
        {me && <span className="ml-tag">BOT</span>}
        {time && <time>{time}</time>}
        <p>{children}</p>
      </div>
    </div>
  );
}

function Moments() {
  return (
    <section className="ml-sec" id="moments" aria-labelledby="ml-moments">
      <div className="ml-wrap">
        <Rise id="ml-moments">她平常在群組裡</Rise>
        <p className="ml-sub ml-rv">不用指令，直接標她就好。</p>
        <div className="ml-moments">
          <article className="ml-tile ml-big ml-rv">
            <Her loop={HER.glasses} className="ml-cut ml-cut-big" />
            <div className="ml-dc ml-seq">
              <Msg who="阿哲" color="#f59e0b" time="今天 23:41">
                @{NAME} 明天微積分期中，極限到底怎麼算
              </Msg>
              <div className="ml-typing" aria-hidden>
                <i />
                <i />
                <i />
                <span>{NAME} 正在輸入…</span>
              </div>
              <Msg who={NAME} me time="今天 23:41">
                你現在才問？好啦，先把式子貼上來，我一題一題帶你寫。寫完去睡覺喔
              </Msg>
            </div>
            <h3>
              聊天<small>會記得你上次說過什麼，也會記仇</small>
            </h3>
          </article>
          <article className="ml-tile ml-rv">
            <Her loop={HER.basin} className="ml-cut ml-cut-small" />
            <div className="ml-vc ml-seq">
              <div className="ml-vc-ch">🔊 深夜閒聊</div>
              <div className="ml-vc-u ml-talk">
                <Av me />
                {NAME}
              </div>
              <div className="ml-vc-u">
                <Av color="#22c55e" />
                小魚乾
              </div>
              <div className="ml-vc-u">
                <Av color="#f472b6" />
                Mika
              </div>
            </div>
            <h3>
              語音<small>進來陪你講話，被吐槽會躲起來</small>
            </h3>
          </article>
          <article className="ml-tile ml-rv">
            <Her loop={HER.grass} className="ml-cut ml-cut-small" />
            <div className="ml-dc ml-dc-short ml-seq">
              <Msg who={NAME} me>
                我在 Minecraft 蓋了一間房子！！雖然門是歪的
              </Msg>
            </div>
            <h3>
              遊戲<small>自己決定要玩什麼</small>
            </h3>
          </article>
        </div>
      </div>
    </section>
  );
}

function Songs({ songs }: { songs?: PublicSongs }) {
  const playing = songs?.playing ?? null;
  const queue = [
    ...(songs?.upcoming ?? []).map((s) => ({ s, tag: s.ready ? "練好了" : "還在練" })),
    ...(songs?.recent ?? []).map((s) => ({ s, tag: "剛唱完" })),
  ].slice(0, 4);
  const thumbs = [HER.heart.poster, HER.chest.poster, HER.finger.poster, HER.glasses.poster];
  return (
    <section className="ml-sec" id="songs" aria-labelledby="ml-songs">
      <div className="ml-wrap">
        <Rise id="ml-songs">點一首歌給她</Rise>
        <p className="ml-sub ml-rv">她會自己去練，練好了就排進歌單唱給大家聽。</p>
        <div className="ml-songs">
          <Her loop={HER.sing} className="ml-sing ml-rv" />
          <div className="ml-player ml-rv">
            {playing ? (
              <div className="ml-playing">
                <div className="ml-art" />
                <div>
                  <small>
                    <span className="ml-eq" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    正在唱
                  </small>
                  <b>{title(playing)}</b>
                  {playing.artist && <span>{playing.artist}</span>}
                </div>
              </div>
            ) : (
              <p className="ml-quiet">她現在沒在唱。登入之後，下一首可以是你點的。</p>
            )}
            {playing && (
              <div className="ml-bar" aria-hidden>
                <i />
              </div>
            )}
            {queue.length > 0 && (
              <ol className="ml-queue ml-seq">
                {queue.map((r, i) => (
                  <li key={`${title(r.s)}-${i}`}>
                    <i style={{ backgroundImage: `url(${thumbs[i % thumbs.length]})` }} />
                    <div>
                      {title(r.s)}
                      {r.s.artist && <em>{r.s.artist}</em>}
                    </div>
                    <span>{r.tag}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Watch({ live }: { live: boolean }) {
  return (
    <section className="ml-sec" id="watch" aria-labelledby="ml-watch">
      <div className="ml-wrap">
        <Rise id="ml-watch">什麼時候開台，她自己決定</Rise>
        <p className="ml-sub ml-rv">
          開了就在直播間，聊天室的留言她都看得到。<a href={LIVE_PAGE}>{live ? "她正在直播，去看" : "去她的直播間"}</a>
        </p>
        <a className="ml-stage ml-rv" href={LIVE_PAGE} aria-label="去她的直播間">
          <span className="ml-room" />
          <Her loop={HER.finger} className="ml-stage-her" />
          <span className="ml-lv">
            {live ? <b>LIVE</b> : <em>還沒開台</em>}
          </span>
          <span className="ml-cap">「等一下，這首歌的高音我昨天練了一整晚，你們不准笑」</span>
          <span className="ml-chat" aria-hidden>
            {[
              ["阿哲", "", "可以唱アイドル嗎"],
              ["Mika", "p", "她又在拖延了 www"],
              ["小魚乾", "y", "女僕裝今天也很可愛"],
              ["路人A", "", "第一次來，這是真人嗎"],
              ["Mika", "p", "不是喔是鯨魚"],
            ].map(([who, tone, text], i) => (
              <span key={`${who}${text}`} style={{ animationDelay: `${0.5 + i * 0.7}s` }}>
                <b className={tone}>{who}</b>
                {text}
              </span>
            ))}
          </span>
        </a>
      </div>
    </section>
  );
}

function Host() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const all = STEPS.join("\n");
  return (
    <section className="ml-sec" id="host" aria-labelledby="ml-host">
      <div className="ml-wrap">
        <Rise id="ml-host">想在自己的群組養一隻？</Rise>
        <p className="ml-sub ml-rv">整個專案都是開源的。設定精靈會一步步問你 bot token、模型、要不要開語音。</p>
        <div className="ml-host">
          <div className="ml-term ml-rv">
            <div className="ml-term-bar">
              <i />
              <i />
              <i />
              <button
                type="button"
                className="ml-cp"
                aria-label={copied ? "已複製" : "複製這幾行指令"}
                onClick={() => {
                  void navigator.clipboard?.writeText(all).then(() => setCopied(true));
                }}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </button>
            </div>
            <pre>
              {STEPS.map((cmd, i) => (
                <span key={cmd} className="ml-line" style={{ animationDelay: `${0.3 + i * 0.75}s` }}>
                  <span className="ml-p">$ </span>
                  {cmd}
                </span>
              ))}
              <span className="ml-line ml-ok" style={{ animationDelay: `${0.3 + STEPS.length * 0.75}s` }}>
                ✓ {NAME} 已上線
              </span>
              <span className="ml-caret" />
            </pre>
          </div>
          <Her loop={HER.chest} className="ml-host-her" />
          <div className="ml-note ml-rv">
            需要 Node 22、pnpm、一個 Discord bot，跟任何 OpenAI 相容的 API。只聊天的話連顯卡都不用。
            <a className="ml-gh" href={REPO} target="_blank" rel="noreferrer">
              在 GitHub 上看 →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Her front door, for anyone not logged in: a black hole on the cover with her name and state, then
 * the night sea under what she does in the server, her songs, her live room and how to host her.
 */
export default function Landing({ discord, notice }: { discord: boolean; notice?: string | null }) {
  const api = useApi();
  const status = usePublicStatus();
  const songs = usePublicSongs();
  const loginUrl = discord ? api.discordLoginUrl(loginNext()) : null;
  const live = status.data?.live ?? false;
  const root = useRef<HTMLDivElement>(null);
  const sea = useRef<HTMLCanvasElement>(null);
  const hole = useRef<HTMLCanvasElement>(null);
  useScenes(sea, hole);
  useReveal(root);

  return (
    <div className="ml" ref={root}>
      <canvas className="ml-sea" ref={sea} aria-hidden />
      <nav className="ml-nav" aria-label="這一頁">
        <a className="ml-wm" href="#top">
          <Mark />
          <span>{NAME}</span>
        </a>
        <div className="ml-links">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </div>
        <div className="ml-right">
          {loginUrl ? (
            <a className="ml-login" href={loginUrl}>
              <DiscordGlyph />
              用 Discord 登入
            </a>
          ) : (
            <a className="ml-login" href={LIVE_PAGE}>
              去她的直播間
            </a>
          )}
        </div>
      </nav>

      <main>
        <header className="ml-hero" id="top">
          <canvas className="ml-hole" ref={hole} aria-hidden />
          <div className="ml-scrim" aria-hidden />
          <Her loop={HER.heart} className="ml-hero-her" label={`${NAME}，藍色長髮、戴著鯨魚耳朵的女僕裝女孩`} />
          <div className="ml-copy">
            <Now status={status.data} songs={songs.data} failed={status.isError} />
            <h1>
              <span className="ml-ln">
                <span>{NAME}</span>
              </span>
              <span className="ml-ln">
                <span>住在 Discord</span>
              </span>
            </h1>
            <p className="ml-lede ml-fx" style={{ animationDelay: "0.35s" }}>
              一隻穿女僕裝的鯨魚。會跟你聊天、唱你點的歌，
              <br />
              無聊的時候自己跑去玩 Minecraft。
            </p>
            {notice && (
              <p role="alert" className="ml-notice">
                {notice}
              </p>
            )}
            <div className="ml-cta ml-fx" style={{ animationDelay: "0.5s" }}>
              {loginUrl && (
                <a className="ml-b1" href={loginUrl}>
                  用 Discord 登入 <b>→</b>
                </a>
              )}
              <a className={loginUrl ? "ml-b2" : "ml-b1"} href={LIVE_PAGE}>
                {live ? "她正在直播，去看" : "看她直播"}
              </a>
            </div>
          </div>
          <span className="ml-hint ml-fx" style={{ animationDelay: "1.2s" }} aria-hidden>
            <i />
            往下看她平常在做什麼
          </span>
        </header>

        <Moments />
        <Songs songs={songs.data} />
        <Watch live={live} />
        <Host />
      </main>

      <footer className="ml-foot">
        <div className="ml-wrap ml-fgrid">
          <div className="ml-fbrand">
            <a className="ml-wm" href="#top">
              <Mark />
              <span>{NAME}</span>
            </a>
            <p>住在 Discord 的鯨魚女僕。開源，可以自己架一隻。</p>
          </div>
          <nav aria-label="她">
            <h4>她</h4>
            <a href="#moments">日常</a>
            <a href="#songs">歌單</a>
            <a href={LIVE_PAGE}>直播間</a>
          </nav>
          <nav aria-label="自己架">
            <h4>自己架</h4>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="#host">安裝步驟</a>
          </nav>
          <nav aria-label="其他">
            <h4>其他</h4>
            {loginUrl && <a href={loginUrl}>登入</a>}
            <a href="/login">管理面板</a>
          </nav>
        </div>
        <div className="ml-wrap ml-fbot">
          <span>
            {NAME}・開源專案
          </span>
          <span>立繪：神宫凉子・黑洞 shader：glsl-black-hole（MIT）</span>
        </div>
      </footer>
    </div>
  );
}
