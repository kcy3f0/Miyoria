import { Check, Copy, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PublicSongs, PublicStatus } from "@/api/types";
import { useApi } from "@/app/connection";
import { loginNext } from "@/app/session";
import { LIVE_PAGE } from "../live/LivePage";
import { STATE, stateLabel, usePublicSongs, usePublicStatus } from "../PublicSite";
import { Caustics } from "./Caustics";
import { FogGlass, type Writing } from "./FogGlass";
import her from "./her.webp";
import { Schematic } from "./Schematic";
import "./landing.css";

/** What is written into the fog before anyone comes, and the one swipe across her face. */
const GLASS = {
  wide: { writing: { text: "擦擦看", x: 0.19, y: 0.34, size: 0.085 }, swipe: { x: 0.6, y: 0.3, rx: 0.09, ry: 0.07 } },
  narrow: { writing: { text: "擦擦看", x: 0.05, y: 0.6, size: 0.06 }, swipe: { x: 0.5, y: 0.3, rx: 0.2, ry: 0.06 } },
} satisfies Record<string, { writing: Writing; swipe: { x: number; y: number; rx: number; ry: number } }>;

const NARROW = "(max-width: 760px)";

const REPO = "https://github.com/owenliu0924/Miyoria";

const HABITS = [
  {
    name: "聊天",
    latin: "loquax",
    text: "被叫到時回話，想加入的時候就自己加入。她記得每個人、每個暱稱，也記得自己有多喜歡你。",
  },
  {
    name: "語音",
    latin: "vocalis",
    text: "會進語音頻道聽大家說話，用自己的聲音回答。可以講日文、字幕留中文，你插話她也聽得到。",
  },
  {
    name: "唱歌",
    latin: "cantrix",
    text: "把你點的歌變成她聲音的翻唱，唱的時候歌詞會跟著出現在直播畫面上。",
  },
  {
    name: "直播",
    latin: "spectatrix",
    text: "透過 OBS 在 Discord 開播。表情、手勢和口型跟著她的話動，場景她自己切。",
  },
  {
    name: "遊戲",
    latin: "lusor",
    text: "正當地玩 Minecraft：不透視、真的一步一步進度，一邊玩一邊講給你聽。",
  },
];

const STEPS = [
  { cmd: "git clone https://github.com/owenliu0924/Miyoria", note: "把她的原始碼拿回家" },
  { cmd: "node scripts/setup.mjs", note: "在 Miyoria 資料夾裡跑：裝好 pnpm 和套件，接著問你 LLM key 和 Discord token" },
  { cmd: "pnpm dev doctor", note: "檢查 Node、LLM、Discord 和資料庫" },
  { cmd: "pnpm dev chat", note: "先在終端機跟她聊，不需要 Discord" },
  { cmd: "pnpm dev core", note: "Discord bot、她的心智迴圈和管理面板" },
];

function hours(v: number) {
  return `${Math.round(v * 10) / 10} 小時`;
}

function songTitle(songs: PublicSongs | undefined) {
  const s = songs?.playing;
  if (!s) return null;
  return s.title ?? "歌名還不知道";
}

/** The feeding board: what she is doing right now and what today came to, from the Core. */
function Board({
  status,
  songs,
  failed,
}: {
  status: PublicStatus | undefined;
  songs: PublicSongs | undefined;
  failed: boolean;
}) {
  const playing = songTitle(songs);
  const on = status ? (STATE[status.state].pulse ?? false) : false;
  return (
    <section className="aq-board" aria-label="她現在">
      <h2 className="aq-board-title">
        <span className={on ? "aq-lamp aq-lamp-on" : "aq-lamp"} aria-hidden />
        今天的她
      </h2>
      {status ? (
        <dl className="aq-board-rows">
          <div>
            <dt>現在</dt>
            <dd>{stateLabel(status)}</dd>
          </div>
          {playing && (
            <div>
              <dt>正在唱</dt>
              <dd className="aq-board-song">{playing}</dd>
            </div>
          )}
          <div>
            <dt>今天唱了</dt>
            <dd>{status.today.songs_sung} 首</dd>
          </div>
          <div>
            <dt>今天直播</dt>
            <dd>{hours(status.today.hours_live)}</dd>
          </div>
        </dl>
      ) : (
        <p className="aq-board-wait">{failed ? "現在看不到她的狀態" : "正在看她在不在…"}</p>
      )}
    </section>
  );
}

function Actions({ loginUrl, live, quiet }: { loginUrl: string | null; live: boolean; quiet?: boolean }) {
  return (
    <div className={quiet ? "aq-actions aq-actions-quiet" : "aq-actions"}>
      {loginUrl && (
        <a className="aq-btn" href={loginUrl}>
          <LogIn aria-hidden />
          用 Discord 登入
        </a>
      )}
      <a className={loginUrl ? "aq-link" : "aq-btn"} href={LIVE_PAGE}>
        {live ? "她正在直播，去看" : "去她的直播間"}
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
      className="aq-copy"
      aria-label={done ? "已複製" : `複製 ${cmd}`}
      onClick={() => {
        void navigator.clipboard?.writeText(cmd).then(() => setDone(true));
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}

/** Sections fade up out of the water once, as they reach the viewport. */
function useSurfacing() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = root.querySelectorAll<HTMLElement>("[data-surface]");
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) {
            e.target.setAttribute("data-surface", "in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const el of items) io.observe(el);
    root.classList.add("aq-armed");
    return () => io.disconnect();
  }, []);
  return ref;
}

/**
 * `/` for a visitor who is not logged in: her tank. The first viewport is for her community (meet
 * her, see what she is doing, log in); the keepers' room further down is for people who want to
 * run Miyoria themselves.
 */
export default function Landing({ discord, notice }: { discord: boolean; notice?: string | null }) {
  const api = useApi();
  const status = usePublicStatus();
  const songs = usePublicSongs();
  const tank = useRef<HTMLDivElement>(null);
  const root = useSurfacing();
  const loginUrl = discord ? api.discordLoginUrl(loginNext()) : null;
  const live = status.data?.live ?? false;
  const [glass] = useState(() => (window.matchMedia(NARROW).matches ? GLASS.narrow : GLASS.wide));

  return (
    <div className="aq" ref={root}>
      <header className="aq-way">
        <a className="aq-mark" href="/">
          Miyoria
        </a>
        <nav aria-label="館內">
          <a href="#habits">觀察紀錄</a>
          <a href="#keepers">飼育員手冊</a>
          {loginUrl && <a href={loginUrl}>登入</a>}
        </nav>
      </header>

      <main>
        <section className="aq-hall" aria-label="DeepSeek-chan">
          <div className="aq-tank" ref={tank}>
            <Caustics className="aq-water" />
            <img className="aq-her" src={her} alt="DeepSeek-chan，藍色長髮、戴著鯨魚耳朵的女僕裝女孩" />
            <div className="aq-floor" aria-hidden />
            {status.data && (
              <p className="aq-board-line" aria-hidden>
                <span className={STATE[status.data.state].pulse ? "aq-lamp aq-lamp-on" : "aq-lamp"} />
                <span>{stateLabel(status.data)}</span>
                {songTitle(songs.data) && <span>{songTitle(songs.data)}</span>}
              </p>
            )}
            <FogGlass surface={tank} writing={glass.writing} swipe={glass.swipe} className="aq-fog" />
          </div>

          <article className="aq-placard">
            <h1>
              <span className="aq-name">DeepSeek-chan</span>
              <span className="aq-latin">Balaena miyoria</span>
            </h1>
            <p className="aq-common">會自己決定要做什麼的鯨魚女孩</p>
            <dl className="aq-facts">
              <div>
                <dt>棲息地</dt>
                <dd>Discord 伺服器</dd>
              </div>
              <div>
                <dt>習性</dt>
                <dd>聊天、唱歌、玩遊戲、開直播。什麼時候做哪一件，她自己決定。</dd>
              </div>
            </dl>
            {notice && (
              <p role="alert" className="aq-notice">
                {notice}
              </p>
            )}
            <Actions loginUrl={loginUrl} live={live} />
          </article>

          <Board status={status.data} songs={songs.data} failed={status.isError} />
        </section>

        <div className="aq-lit">
        <div className="aq-spill" aria-hidden>
          <Caustics />
        </div>
        <section id="habits" className="aq-habits" aria-labelledby="aq-habits-title">
          <div className="aq-habits-lead">
            <h2 id="aq-habits-title">她不是等你下指令的。</h2>
            <p>
              她會注意誰在、大家在做什麼、自己心情好不好，再決定要開口、進語音、唱歌還是開播。指令只是備用。
            </p>
          </div>
          <ul className="aq-habit-list">
            {HABITS.map((h) => (
              <li key={h.name} data-surface>
                <h3>
                  {h.name}
                  <i lang="la">{h.latin}</i>
                </h3>
                <p>{h.text}</p>
              </li>
            ))}
          </ul>
        </section>
        </div>

        <section id="keepers" className="aq-keepers" aria-labelledby="aq-keepers-title">
          <div className="aq-keepers-head">
            <h2 id="aq-keepers-title">飼育員手冊</h2>
            <p>
              Miyoria 是開源的。想在自己的伺服器養一隻？只要 Node.js 24、一個 Discord bot token 和一組 LLM API key，
              <span className="aq-hand">其他都有預設值，只聊天的話連顯卡都不用。</span>
            </p>
          </div>
          <div className="aq-keepers-body">
            <figure className="aq-plant-wrap">
              <Schematic layout="wide" />
              <Schematic layout="narrow" />
            </figure>
            <ol className="aq-steps">
              {STEPS.map((s) => (
                <li key={s.cmd}>
                  <div className="aq-cmd">
                    <code>{s.cmd}</code>
                    <CopyCommand cmd={s.cmd} />
                  </div>
                  <p>{s.note}</p>
                </li>
              ))}
            </ol>
          </div>
          <a className="aq-link aq-repo" href={REPO} target="_blank" rel="noreferrer">
            在 GitHub 上看原始碼
          </a>
        </section>

        <section className="aq-hours aq-lit" aria-label="開放時間">
          <div className="aq-spill aq-spill-up" aria-hidden>
            <Caustics />
          </div>
          <p className="aq-hours-sign">
            <strong>她在的時候都開著</strong>
          </p>
          <Actions loginUrl={loginUrl} live={live} quiet />
        </section>
      </main>
    </div>
  );
}
