// How survival actually progresses, for the game's decision loop (sent with the executor's
// goals, so the director's prompt carries it). She picks the next step from what is really in
// her inventory instead of going straight for diamonds with bare hands.

export const GUIDE = `走路、挖掘、戰鬥這些細節交給遊戲裡的 bot(Baritone / AltoClef),你只下高階動作。危險(血量低、敵人靠近、天黑、掉進岩漿)先求生。
像真人一樣一步一步玩:看遊戲狀態裡你實際有的東西(背包、工具、看得到的方塊),不要跳級去做還沒條件的事。
通關推進的進度(一步一步來,看背包裡實際有什麼,選下一個「現在做得到」的步驟,不要跳級):
1. 空手 mine 看得到的原木(oak_log 這類)→ 木材(例如 oak_planks)→ 工作台 crafting_table → place 放下來。
2. 木棒 stick → 站在工作台旁做木鎬 wooden_pickaxe。
3. 用木鎬 mine 石頭 stone(得到鵝卵石 cobblestone)→ 石鎬 stone_pickaxe、石劍、石斧;8 個鵝卵石做熔爐 furnace 再 place。
4. mine 煤礦 coal_ore 拿煤炭(沒有就把原木燒成木炭)→ 火把 torch。
5. 用石鎬 mine 鐵礦 iron_ore → 在熔爐旁把粗鐵 raw_iron 燒成鐵錠 → 做鐵鎬 iron_pickaxe、鐵套防具、鐵桶 bucket、盾牌 shield 與打火石 flint_and_steel。
6. 用鐵鎬挖鑽石做鑽石鎬 diamond_pickaxe，並挖取至少 10 個黑曜石 obsidian。
7. 【下界傳送門】用黑曜石搭建傳送門或用水桶澆灌岩漿池，再用打火石點燃進入下界（nether_portal）。
8. 【下界要塞與資源】在下界探索尋找下界要塞(Nether Fortress)獵殺烈焰人獲取烈焰棒 blaze_rod；在詭異森林擊殺終界使者或與豬靈以金錠交易取得終界珍珠 ender_pearl。
9. 【終界要塞】將烈焰棒拆成烈焰粉，與終界珍珠合成至少 12 顆終界之眼 ender_eye（obtain_eyes）；投擲終界之眼定位要塞（locate_stronghold），進入傳送門房間填滿傳送門方塊啟動並跳入終界（enter_end）。
10. 【終界屠龍】帶充足的床 bed、弓箭與方塊進入終界，優先拆除黑曜石柱頂端的終界水晶，龍停留在傳送門祭壇時在龍頭下方引爆床造成巨額傷害快速擊殺（slay_dragon）。
要任何工具、材料或方塊都用 obtain {item}(例如 oak_planks、crafting_table、iron_pickaxe、flint_and_steel、white_bed、ender_eye):程式照上面的順序自己排好步驟(挖、合成、燒、放)、一步一步做,做完或卡住會回報原因。
若在途中死亡或裝備遺失，冷靜回退到前期步驟重新 obtain 鐵鎬與防具物資，再接續通關目標。
天黑前(看時間)先準備:食物(殺動物、蘋果、麵包)、床(3 羊毛 + 3 木材)或躲進封起來的小屋 / 洞裡。
身體有本能反應(不用下指令):掉進岩漿、快淹死、卡在方塊裡、頭上掉沙會自己逃;被怪打會反擊,血少或苦力怕靠近會逃;餓了會自己吃;卡住約 20 秒會自己掙脫;挖完會撿掉落物。反射打斷動作時會收到事件,結束後再決定下一步。
goto {block} 和 mine 只會找你親眼看得到的方塊(不會透視);附近沒有就 explore 或到地表、洞穴找,不要硬去找礦。
動作失敗時會說原因(缺什麼工具、材料、要在工作台旁…),照著補齊再做,不要重試同一個動作;失敗後有一陣子不能用 goto / mine,要換個方法(obtain、explore)或換個目標。`;
