import { Check, Copy } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { PublicDay, PublicSongs, PublicStatus } from "@/api/types";
import { useApi } from "@/app/connection";
import { loginNext } from "@/app/session";
import { LIVE_PAGE } from "../live/LivePage";
import { STATE, stateLabel, usePublicSongs, usePublicStatus } from "../PublicSite";
import basinA from "./art/basin-a.webp";
import basinP from "./art/basin-p.webp";
import fingerA from "./art/finger-a.webp";
import fingerP from "./art/finger-p.webp";
import glassesA from "./art/glasses-a.webp";
import glassesP from "./art/glasses-p.webp";
import heartA from "./art/heart-a.webp";
import heartP from "./art/heart-p.webp";
import singA from "./art/sing-a.webp";
import singP from "./art/sing-p.webp";
import sweatA from "./art/sweat-a.webp";
import sweatP from "./art/sweat-p.webp";
import aqua from "./plate-aqua.webp";
import pink from "./plate-pink.webp";
import { Burst, Icon, Stamp, Waves, Whale } from "./Ornaments";
import { Schematic } from "./Schematic";
import "./landing.css";

const REPO = "https://github.com/owenliu0924/Miyoria";
const MAST = "MIYORIA";

/** The contents page: what she does, in the order a reader would meet it. */
const CONTENTS = [
  {
    page: "04",
    name: "聊天",
    text: "叫她會回，沒叫她也可能自己插話。誰叫什麼暱稱、上次聊到哪裡，她都記得。",
  },
  {
    page: "06",
    name: "語音",
    text: "會進語音頻道聽大家講話，再用自己的聲音回。她講日文，字幕是中文，你中途插話她也聽得到。",
  },
  {
    page: "08",
    name: "唱歌",
    text: "你點一首歌，她用自己的聲音翻唱。唱的時候歌詞會跟著跑在直播畫面上。",
  },
  {
    page: "10",
    name: "直播",
    text: "用 OBS 在 Discord 開台。表情、手勢和嘴型跟著她講的話動，場景她自己切。",
  },
  {
    page: "12",
    name: "遊戲",
    text: "真的在玩 Minecraft：不開透視，一格一格挖，邊玩邊跟你講她在幹嘛。",
  },
];

const STEPS = [
  { cmd: "git clone https://github.com/owenliu0924/Miyoria", note: "把她的原始碼拿回家" },
  { cmd: "node scripts/setup.mjs", note: "在 Miyoria 資料夾裡跑：裝好 pnpm 和套件，然後問你 LLM key 和 Discord token" },
  { cmd: "pnpm dev doctor", note: "檢查 Node、LLM、Discord 和資料庫是不是都通" },
  { cmd: "pnpm dev chat", note: "先在終端機跟她聊，不用 Discord" },
  { cmd: "pnpm dev core", note: "Discord bot、她的心智迴圈和管理面板一起開" },
];

/** What the cover line under her state says, by state. */
const STATE_LINE: Record<PublicStatus["state"], string> = {
  singing: "在語音頻道唱歌，點歌的人在排隊",
  playing: "不開外掛，一格一格慢慢挖",
  live: "在 Discord 開台中，進來就看得到",
  in_voice: "在語音頻道裡，講話她聽得到",
  idle: "在 Discord 上晃，叫她名字她會回",
  offline: "現在不在線上，晚點再來找她",
};

function hours(v: number) {
  return `${Math.round(v * 10) / 10} 小時`;
}

function title(s: { title: string | null } | null | undefined) {
  return s?.title ?? "還不知道歌名";
}

/** "2026 冬": the issue line, from today's date. */
function issue(now = new Date()) {
  const m = now.getMonth();
  const season = m < 2 || m === 11 ? "冬" : m < 5 ? "春" : m < 8 ? "夏" : "秋";
  return `創刊號・${now.getFullYear()} ${season}`;
}

/** Bars from the characters of a word, so the barcode is the same every time. */
function Barcode({ text }: { text: string }) {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of `*${text}*`) {
    const code = ch.charCodeAt(0);
    for (let i = 0; i < 5; i++) {
      const w = ((code >> i) & 1) + 1;
      if (i % 2 === 0) bars.push({ x, w });
      x += w + 1;
    }
  }
  return (
    <svg className="mz-barcode" viewBox={`0 0 ${x} 40`} preserveAspectRatio="none" aria-hidden>
      {bars.map((b) => (
        <rect key={b.x} x={b.x} width={b.w} height="40" />
      ))}
    </svg>
  );
}

/** The cover line that is live: her state, the song if there is one, and today's numbers. */
function NowLine({ status, songs, failed }: { status?: PublicStatus; songs?: PublicSongs; failed: boolean }) {
  if (!status) {
    return (
      <section className="mz-now" aria-label="她現在">
        <p className="mz-now-wait">{failed ? "現在看不到她在幹嘛" : "正在看她在不在…"}</p>
      </section>
    );
  }
  const playing = songs?.playing;
  const waiting = songs?.upcoming.length ?? 0;
  return (
    <section className="mz-now" aria-label="她現在">
      <p className="mz-now-state">
        <span className={STATE[status.state].pulse ? "mz-dot mz-dot-on" : "mz-dot"} aria-hidden />
        {stateLabel(status)}
      </p>
      <h2 className="mz-now-title">{playing ? `〈${title(playing)}〉` : stateLabel(status).replace(/^她/, "")}</h2>
      <p className="mz-now-sub">
        {playing && waiting > 0 ? `後面還有 ${waiting} 首在排隊` : STATE_LINE[status.state]}
      </p>
      <p className="mz-now-today">
        今天唱了 <b>{status.today.songs_sung}</b> 首・直播 <b>{hours(status.today.hours_live)}</b>
      </p>
    </section>
  );
}

/** A printed button: the pink plate over an aqua one that is a little off; pressing lines them up. */
function Actions({ loginUrl, live }: { loginUrl: string | null; live: boolean }) {
  return (
    <div className="mz-actions">
      {loginUrl && (
        <a className="mz-btn" href={loginUrl}>
          <span>用 Discord 登入</span>
        </a>
      )}
      <a className={loginUrl ? "mz-link" : "mz-btn"} href={LIVE_PAGE}>
        <span>{live ? "她正在直播，去看" : "去她的直播間"}</span>
      </a>
    </div>
  );
}

function CopyCommand({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="mz-copy"
      aria-label={done ? "已複製" : `複製 ${cmd}`}
      onClick={() => {
        void navigator.clipboard?.writeText(cmd).then(() => setDone(true));
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}

/** The running strip between the cover and the inside pages. */
function Ticker({ status, songs }: { status?: PublicStatus; songs?: PublicSongs }) {
  const items = ["MIYORIA 創刊號"];
  if (status) {
    items.push(stateLabel(status));
    if (songs?.playing) items.push(`正在唱〈${title(songs.playing)}〉`);
    if (songs?.upcoming[0]) items.push(`下一首〈${title(songs.upcoming[0])}〉`);
    items.push(`今天唱了 ${status.today.songs_sung} 首`, `在語音待了 ${hours(status.today.hours_in_voice)}`);
  } else {
    items.push("DeepSeek-chan", "住在 Discord");
  }
  const run = [...items, ...items];
  return (
    <div className="mz-ticker" aria-hidden>
      <div className="mz-ticker-run">
        {run.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function SongChart({ songs }: { songs?: PublicSongs }) {
  const rows = [
    ...(songs?.playing ? [{ s: songs.playing, tag: "現在", on: true }] : []),
    ...(songs?.upcoming ?? []).map((s) => ({ s, tag: s.ready ? "排隊中" : "準備中", on: false })),
    ...(songs?.recent ?? []).map((s) => ({ s, tag: "剛唱完", on: false })),
  ].slice(0, 8);
  if (rows.length === 0) {
    return (
      <div className="mz-chart-empty">
        <Cut art={{ a: sweatA, p: sweatP }} className="mz-sticker" />
        <p>今天還沒有人點歌。登入之後，第一首可以是你點的。</p>
      </div>
    );
  }
  return (
    <ol className="mz-chart">
      {rows.map((r, i) => (
        <li key={i} className={r.on ? "mz-chart-on" : undefined} data-print style={{ "--d": i } as CSSProperties}>
          <span className="mz-chart-n">{String(i + 1).padStart(2, "0")}</span>
          <span className="mz-chart-t">
            {title(r.s)}
            {r.s.artist && <small>{r.s.artist}</small>}
          </span>
          <span className="mz-chart-tag">{r.tag}</span>
        </li>
      ))}
    </ol>
  );
}

function TwoWeeks({ days }: { days: PublicDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.songs_sung));
  return (
    <figure className="mz-weeks" data-print>
      <figcaption>最近兩週，每天唱了幾首</figcaption>
      <div className="mz-weeks-bars">
        {days.map((d, i) => (
          <div
            key={d.date}
            className="mz-weeks-bar"
            style={{ "--h": d.songs_sung / max, "--d": i } as CSSProperties}
            title={`${d.date}：${d.songs_sung} 首`}
          >
            <span>{d.songs_sung}</span>
            <i />
            <small>{Number(d.date.slice(8))}</small>
          </div>
        ))}
      </div>
    </figure>
  );
}

type Art = { a: string; p: string };

/** Her, as the two plates of one picture, without a frame. */
function Cut({ art, className }: { art: Art; className?: string }) {
  return (
    <div className={`mz-cut ${className ?? ""}`} aria-hidden>
      <img src={art.a} alt="" loading="lazy" />
      <img src={art.p} alt="" loading="lazy" />
    </div>
  );
}

/** A printed photo of her, taped onto the page. */
function Photo({ art, caption, className, tilt = 0 }: { art: Art; caption?: string; className?: string; tilt?: number }) {
  return (
    <figure className={`mz-photo ${className ?? ""}`} style={{ "--tilt": `${tilt}deg` } as CSSProperties} data-print>
      <div className="mz-photo-frame">
        <Cut art={art} />
        <i className="mz-tape mz-tape-a" />
        <i className="mz-tape mz-tape-b" />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

/** A record in the song chart: it turns while she is singing. */
function Record({ spinning }: { spinning: boolean }) {
  return (
    <div className={spinning ? "mz-record mz-record-on" : "mz-record"} aria-hidden>
      <div className="mz-record-disc">
        <div className="mz-record-label">
          <img src={pink} alt="" />
        </div>
      </div>
      <div className="mz-record-arm" />
    </div>
  );
}

/** Inside pages print in once, as they reach the viewport. */
function usePrint() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) {
            e.target.setAttribute("data-print", "in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    const watch = () => {
      for (const el of root.querySelectorAll<HTMLElement>("[data-print]:not([data-print='in'])")) io.observe(el);
    };
    watch();
    // The song chart and the two weeks arrive after the first paint, with the Core's answer.
    const mo = new MutationObserver(watch);
    mo.observe(root, { childList: true, subtree: true });
    root.classList.add("mz-armed");
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
  return ref;
}

/** The pointer pulls the two plates out of register a little; they drift back when it leaves. */
function useRegistration() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    const step = () => {
      x += (tx - x) * 0.08;
      y += (ty - y) * 0.08;
      el.style.setProperty("--mx", x.toFixed(3));
      el.style.setProperty("--my", y.toFixed(3));
      frame = Math.abs(tx - x) + Math.abs(ty - y) > 0.001 ? requestAnimationFrame(step) : 0;
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(step);
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      kick();
    };
    const leave = () => {
      tx = 0;
      ty = 0;
      kick();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  return ref;
}

/**
 * `/` for a visitor who is not logged in: a two-colour riso magazine with her on the cover. The
 * cover is for her community (who she is, what she is doing now, log in); the appendix is for
 * people who want to run Miyoria themselves.
 */
export default function Landing({ discord, notice }: { discord: boolean; notice?: string | null }) {
  const api = useApi();
  const status = usePublicStatus();
  const songs = usePublicSongs();
  const root = usePrint();
  const cover = useRegistration();
  const loginUrl = discord ? api.discordLoginUrl(loginNext()) : null;
  const live = status.data?.live ?? false;
  const days = status.data?.days ?? [];

  return (
    <div className="mz" ref={root}>
      <header className="mz-cover" ref={cover} aria-label="封面">
        <div className="mz-flood" aria-hidden />
        <span className="mz-crop mz-crop-tl" aria-hidden />
        <span className="mz-crop mz-crop-tr" aria-hidden />
        <span className="mz-crop mz-crop-bl" aria-hidden />
        <span className="mz-crop mz-crop-br" aria-hidden />

        <div className="mz-meta">
          <span>{issue()}</span>
          <nav aria-label="這一期">
            <a href="#contents">目錄</a>
            <a href="#appendix">自己養一隻</a>
            {loginUrl && <a href={loginUrl}>登入</a>}
          </nav>
          <span className="mz-meta-ink">
            <i className="mz-swatch mz-swatch-a" />
            <i className="mz-swatch mz-swatch-p" />
            <i className="mz-swatch mz-swatch-o" />
            雙色 Riso
          </span>
        </div>

        <div className="mz-mast" aria-hidden>
          {[...MAST].map((ch, i) => (
            <span key={ch + String(i)} style={{ "--i": i } as CSSProperties}>
              {ch}
            </span>
          ))}
        </div>

        <div className="mz-her">
          <img className="mz-plate mz-plate-a" src={aqua} alt="DeepSeek-chan，藍色長髮、戴著鯨魚耳朵的女僕裝女孩" />
          <img className="mz-plate mz-plate-p" src={pink} alt="" />
        </div>

        <a className="mz-line mz-line-keep" href="#appendix">
          <strong>自己養一隻</strong>
          <span>她是開源的。準備一個 Discord bot token 和一組 LLM key，只聊天的話連顯卡都不用。</span>
        </a>

        <NowLine status={status.data} songs={songs.data} failed={status.isError} />

        <div className="mz-lead">
          <h1>
            <span className="mz-lead-name">DeepSeek-chan</span>
          </h1>
          <p>鯨魚耳、女僕裝，平常住在 Discord。會跟你聊天、唱你點的歌，也會自己跑去玩 Minecraft。</p>
          {notice && (
            <p role="alert" className="mz-notice">
              {notice}
            </p>
          )}
          <Actions loginUrl={loginUrl} live={live} />
        </div>

        <div className="mz-price">
          <Barcode text={MAST} />
          <span>定價：免費</span>
        </div>
      </header>

      <Ticker status={status.data} songs={songs.data} />

      <main>
        <section id="contents" className="mz-spread" aria-labelledby="mz-contents-title">
          <div className="mz-page mz-page-l" data-print>
            <h2 id="mz-contents-title" className="mz-h2">
              目錄
            </h2>
            <p className="mz-note">
              這本是 DeepSeek-chan 的介紹。她是一個跑在 Discord 上的 AI，大部分時間沒有人在操作她：要不要說話、要不要進語音、要不要開台，都是她看當下的情況自己決定。指令還是有，只是很少用到。
            </p>
            <p className="mz-sign">編輯部</p>
            <Photo className="mz-photo-feature" art={{ a: fingerA, p: fingerP }} tilt={-3} caption="「指令還是有啦，只是我比較想自己決定。」" />
            <Whale className="mz-whale-spread" />
          </div>
          <ol className="mz-page mz-page-r mz-toc">
            {CONTENTS.map((c, i) => (
              <li key={c.name} data-print style={{ "--d": i } as CSSProperties}>
                <span className="mz-toc-page">{c.page}</span>
                <h3>
                  {c.name}
                  <Icon name={c.name} />
                </h3>
                <p>{c.text}</p>
              </li>
            ))}
            <li data-print style={{ "--d": CONTENTS.length } as CSSProperties}>
              <span className="mz-toc-page">16</span>
              <h3>
                <a href="#appendix">附錄：自己養一隻</a>
              </h3>
              <p>給想在自己伺服器上跑她的人。</p>
            </li>
          </ol>
        </section>

        <Waves />
        <section className="mz-songs" aria-labelledby="mz-songs-title">
          <div className="mz-songs-head" data-print>
            <span className="mz-folio">p. 08</span>
            <h2 id="mz-songs-title" className="mz-h2">
              本期歌單
            </h2>
            <p>她現在在唱的、排隊中的、剛唱完的。資料直接從她那邊來，會自己更新。</p>
          </div>
          <div className="mz-songs-art" data-print>
            <Record spinning={status.data?.state === "singing"} />
            <Cut art={{ a: singA, p: singP }} className="mz-songs-her" />
            {status.data?.state === "singing" && <Stamp ring="NOW SINGING ・ LIVE ・ " mid="現場" className="mz-stamp-live" />}
            {days.length > 1 && (
              <Burst className="mz-burst-week">
                兩週唱了
                <b>{days.reduce((n, d) => n + d.songs_sung, 0)}</b>首
              </Burst>
            )}
          </div>
          <SongChart songs={songs.data} />
          {days.length > 1 && <TwoWeeks days={days} />}
        </section>

        <section id="appendix" className="mz-appendix" aria-labelledby="mz-appendix-title">
          <div className="mz-appendix-head" data-print>
            <span className="mz-folio">p. 16</span>
            <h2 id="mz-appendix-title" className="mz-h2">
              附錄：自己養一隻
            </h2>
            <p>
              Miyoria 是開源的。要準備的只有 Node.js 24、一個 Discord bot token 和一組 LLM API key，其他設定都有預設值。只想聊天的話，不需要顯卡。
            </p>
          </div>
          <div className="mz-appendix-body">
            <div className="mz-coupon">
              <figure className="mz-basin" aria-hidden>
                <Cut art={{ a: basinA, p: basinP }} />
                <figcaption>跑 doctor 之前的她</figcaption>
              </figure>
              <p className="mz-coupon-cut" aria-hidden>
                ✂ 沿虛線剪下，貼在螢幕旁邊
              </p>
              <ol className="mz-steps">
              {STEPS.map((s, i) => (
                <li key={s.cmd} data-print style={{ "--d": i } as CSSProperties}>
                  <div className="mz-cmd">
                    <code>{s.cmd}</code>
                    <CopyCommand cmd={s.cmd} />
                  </div>
                  <p>{s.note}</p>
                </li>
              ))}
              </ol>
            </div>
            <figure className="mz-plant-wrap" data-print>
              <div className="mz-teacher" aria-hidden>
                <Cut art={{ a: glassesA, p: glassesP }} />
                <p className="mz-bubble">卡住的話，先跑 pnpm dev doctor。</p>
              </div>
              <Schematic layout="wide" />
              <Schematic layout="narrow" />
              <figcaption>想開語音、唱歌和直播的話，右邊這幾台要一張 NVIDIA 顯卡。</figcaption>
              <Stamp ring="OPEN SOURCE ・ DIY ・ 自己養 ・ " mid="自製" className="mz-stamp-diy" />
            </figure>
          </div>
          <a className="mz-link mz-repo" href={REPO} target="_blank" rel="noreferrer">
            <span>在 GitHub 上看原始碼</span>
          </a>
        </section>
      </main>

      <footer className="mz-back" aria-labelledby="mz-back-title">
        <div className="mz-back-mast" aria-hidden>
          {MAST}
        </div>
        <Cut art={{ a: heartA, p: heartP }} className="mz-back-her" />
        <Burst className="mz-burst-free">免費</Burst>
        <div className="mz-back-body" data-print>
          <h2 id="mz-back-title">
            訂閱方式：
            <br />
            用 Discord 登入，免費。
          </h2>
          <p>登入之後可以點歌、看她怎麼記得你，也會拿到她送的卡片。</p>
          <Actions loginUrl={loginUrl} live={live} />
        </div>
        <div className="mz-back-foot">
          <Barcode text="DEEPSEEK" />
          <span>MIYORIA・開源專案・DeepSeek-chan 原畫：神宫凉子，本刊以兩色網點重製</span>
        </div>
      </footer>
    </div>
  );
}
