// How survival actually progresses, for the game's decision loop (appended to the act tool's
// description, so the director's prompt carries it). She picks the next step from what is really
// in her inventory instead of going straight for diamonds with bare hands.

export const GUIDE = `生存的進度(一步一步來,看背包裡實際有什麼,選下一個「現在做得到」的步驟,不要跳級):
1. 空手 mine 看得到的原木(oak_log 這類)→ craft 木材(例如 oak_planks)→ craft 工作台 crafting_table → place 放下來。
2. craft 木棒 stick → 站在工作台旁 craft 木鎬 wooden_pickaxe。
3. 用木鎬 mine 石頭 stone(得到鵝卵石 cobblestone)→ craft 石鎬 stone_pickaxe、石劍、石斧;8 個鵝卵石 craft 熔爐 furnace 再 place。
4. mine 煤礦 coal_ore 拿煤炭(沒有就 smelt 原木燒成木炭)→ craft 火把 torch。
5. 用石鎬 mine 鐵礦 iron_ore → 在熔爐旁 smelt 粗鐵 raw_iron 成鐵錠 → 3 鐵錠 + 2 木棒 craft 鐵鎬 iron_pickaxe。
6. 有鐵鎬才挖得到鑽石、金、紅石;鑽石在很深的地方(Y -59 附近)或洞穴裡。
天黑前(看時間)先準備:食物(殺動物、蘋果、麵包)、床(3 羊毛 + 3 木材)或躲進封起來的小屋 / 洞裡;飢餓 6 以下先吃東西(select 食物再 use,hold_ticks 32)。
goto {block} 和 mine 只會找你親眼看得到的方塊(不會透視);附近沒有就 explore 或到地表、洞穴找,不要硬去找礦。
動作失敗時會說原因(缺什麼工具、材料、要在工作台旁…),照著補齊再做,不要重試同一個動作。`;
