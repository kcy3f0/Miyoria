// How survival actually progresses, for the game's decision loop (sent with the executor's
// goals, so the director's prompt carries it). She picks the next step from what is really in
// her inventory instead of going straight for diamonds with bare hands.

export const GUIDE = `走路、挖掘、戰鬥這些細節交給遊戲裡的 bot(Baritone / AltoClef / 本機工作模組),你只下高階動作。危險(血量低、敵人靠近、天黑、掉進岩漿)先求生。
像真人一樣一步一步玩:看遊戲狀態裡你實際有的東西(背包、工具、看得到的方塊、已記住的記憶點與箱子),不要跳級去做還沒條件的事。
生存的進度(一步一步來,看背包裡實際有什麼,選下一個「現在做得到」的步驟,不要跳級):
1. 空手 mine 看得到的原木(oak_log 這類)→ 木材(例如 oak_planks)→ 工作台 crafting_table → place 放下來。
2. 木棒 stick → 站在工作台旁做木鎬 wooden_pickaxe。
3. 用木鎬 mine 石頭 stone(得到鵝卵石 cobblestone)→ 石鎬 stone_pickaxe、石劍、石斧;8 個鵝卵石做熔爐 furnace 再 place。
4. mine 煤礦 coal_ore 拿煤炭(沒有就把原木燒成木炭 charcoal)→ 火把 torch。
5. 用石鎬 mine 鐵礦 iron_ore → 在熔爐(或高爐 blast_furnace)把粗鐵 raw_iron 燒成鐵錠 → 做鐵鎬 iron_pickaxe、鐵盾牌 shield、鐵桶 bucket / water_bucket、鐵盔甲。
6. 有鐵鎬才挖得到鑽石、金、紅石;鑽石在很深的地方(Y -54 附近)或洞穴裡。
要任何工具、防具、食物(cooked_beef、bread…)、床(#beds / white_bed)、船(#boats)、弓箭、打火石、煙燻爐/高爐都可用 obtain {item}:程式會照順序自動排步驟(從記憶裡附近打開過的箱子拿、打獵、清樹葉砍樹、探索、地下分支挖礦、合成、熔煉、裝水),做完或卡住會回報原因。
天黑前(看時間)先準備:用 hunt 打獵拿食物和羊毛、用 sleep 找床睡覺設定重生點、用 chest (inspect/store/take)管理箱子、用 manage_inv (equip_best/tidy)穿上最好裝備與清雜物。
記憶點與視野:系統會自動記住 home、bed、mine、last_death、table、furnace 與真正打開過的箱子內容(未開過的箱子不會亂猜)。可用 waypoint 增刪查詢,用 goto {waypoint} 走回去;覺得周圍地形或狀況不明確時可用 inspect 在下次觀察附上畫面截圖。
進行中的 obtain、mine、goto、explore、follow、hunt 可用 steer_task 直接改目標(保留進度與外層任務)。
身體有本能反應(不用下指令):滅火、落地水桶保命、逃離岩漿、窒息、閃沙礫、溺水、墊高脫險、舉盾格檔、反擊、血少/苦力怕逃跑、餓了吃東西、暗處自動插火把、卡住掙脫、撿掉落物。可恢復的反射會暫停原本工作並在結束後自動繼續(reflex_resumed),不必急著重開。
goto {block} 和 mine 只會找你親眼看得到的方塊(不會透視);附近沒有就 explore、使用 obtain 自動分支挖礦,或換目標。
動作失敗時會說原因(缺工具、材料、要在工作台旁…),照著補齊再做,不要重試同一個動作。`;
