# -*- coding: utf-8 -*-
"""Explicit layer assignment for the XuanYiJi mahjong table.

Keyed on BASE name (Blender's .001/.002 suffix stripped). Every one of the
140 base names in the model is listed exactly once -- no regex, no fallthrough,
so a missing or double-assigned part is a hard error, not a silent mis-render.

VENDORED from the Blender project's tools/layers.py so this repo needs nothing
outside itself. It is pure data with no bpy import, which is why it can live here.
If the layer assignment changes upstream, re-copy this file; scripts/build-cad-layers.py
asserts that every base name it finds in the blend is accounted for here and warns
about any that are not, so a drift shows up as a warning rather than a mis-render.
"""

LAYERS = [
 dict(key="01_exterior_cabinet",
      title="Exterior Cabinet",
      title_cn="外观机身",
      pitch="Rail, skirt and pedestal in one welded body. The only surface a player ever touches.",
      parts=[
        "T3新机芯",                       # 4 side rails + integral legs/pedestal
        "40桌面铝塑板斜18度-300",           # tabletop aluminium-composite panel, 18 deg bevel
        "894-894面板护角",                 # corner guards
        "面布条-50",                      # felt edge strips
      ]),

 dict(key="02_center_column",
      title="Center Column & Control Dome",
      title_cn="中心升降柱 / 玻璃控制盘",
      pitch="Backlit glass dome, capacitive keys, powered dice bowl, and the lift column that raises it.",
      parts=[
        "大玻璃控制盘-WJJ", "大玻璃控制盘功能按键-WJJ", "大玻璃控制盘升降按键1-WJJ",
        "大玻璃控制盘骰子按键1-WJJ", "大玻璃控制盘透光膜-WJJ", "大玻璃控制盘线路板-WJJ",
        "大玻璃托碗-WJJ", "自动恢复 大玻璃骰子碗-WJJ", "112.5玻璃", "导电按键",
        "大骰子-红", "大骰子-白", "骰子转盘-WJJ", "骰子电机", "骰子卡扣-WJJ",
        "塑托-30", "fangke1111111", "杰品旋翼机大盘压盖", "6010轴承",
        "30升降管", "升降管塑托-30mm", "11mm轴承", "U型导向支架102(默认)",
        "25转中心升降电机", "老中心升降电机支架", "老中心升降曲柄-38", "零件1",
      ]),

 dict(key="03_deck_cover",
      title="Deck Cover",
      title_cn="轨道盖板 / 转盘装饰板",
      pitch="One-piece PET deck with four recessed tile slots. The only interior surface tiles ever touch.",
      parts=[
        "FQS-2617-轨道盖板1-1-PET-1.002-3-5.sldasm-Part-200",
        "FQS-2618-转盘装饰板1出2-PET-1.002.sldasm-Part-110",
        "2025-09-16.sldasm-Part-1", "2025-09-16.sldasm-Part-2",
        "600桶-旋翼机方盖板-1",
      ]),

 dict(key="04_wall_builder",
      title="Wall Builder & Lift",
      title_cn="升牌 / 储牌轨道",
      pitch="Stores a sorted row, then a one-way geared crank lifts the finished wall flush to the deck.",
      parts=[
        "旋翼机升牌板-50-ABS-264-2", "升牌板头-直头", "旋翼机升牌板轴-4-55",
        "旋翼机升牌拉钩-POM-3", "升牌槽调节片-(36#-48)(40#-50)-264",
        "旋翼机-升牌板轴座-小牌", "旋翼机-升牌圆盘-40#桌面（4倍速）20-80(264-3)",
        "旋翼机-升牌齿圈-40桌面（40#-48-54,80齿）", "旋翼机-升牌拨杆（40#-48-54）-长尾",
        "旋翼机-升牌曲柄-POM-连杆联动-42-52", "旋翼机-升牌曲柄轴-48-54",
        "升牌联动轴", "旋翼机-升牌联动杆-42-52（20-80）（264）",
        "旋翼机-联动齿圈-40#桌面（80齿-内定位）20-80",
        "旋翼机-联动齿圈-40#桌面（80齿-内定位）20-80（",
        "旋翼机-联动齿圈-40#桌面（80齿-内定位）20-80（2",
        "旋翼机-联动齿圈-40#桌面（80齿-内定位）20-80（26",
        "联动齿盘挡块(20-80)", "三角联动杆-40桌面", "联动杆压板",
        "40#-42-54储牌轨道（樱花）",
        "52外导圈-40桌面（输送进口斜2度）", "40#-52-17内导圈-改50-18",
        "40#-54-17内导圈-改52-17", "上牌圆盘中心轴1-POM",
        "单向齿轮-模数2，齿数20-5", "单向齿轮模数2，齿数27-3", "主动齿轮芯套-3",
        "9齿轮-1.75模", "9齿套", "PC棘爪", "小弹簧", "弹簧压套",
        "6-4-4磁钢", "推升磁控", "方圆硅胶", "8mm轴承", "3P插头-弯头-2",
        "10电机输送轨道上挡片-短", "600桶-40#-52输送上挡块",
        "40#旋翼机可调输送进口挡片-48-50-改",
        "翻板加强铁片（190-26-3）（264）", "70电机", "上牌电机卡位板-70电机",
        "中心管限位塞", "旋翼机推头-40#桌面（42-52）",
      ]),

 dict(key="05_shuffle_feed",
      title="Shuffle & Feed",
      title_cn="洗牌桶 / 吸牌轮 / 输送",
      pitch="Magnetic pickup wheels lift tiles face-correct out of the drum; a belt and cam head feed them on.",
      parts=[
        "40桌面-旋翼机610洗牌桶", "610桶-40#桌面旋翼机输送电机架",
        "600桶-74吸牌轮48-54", "600桶-6-67吸牌轮轴", "吸牌轮轴套6-14-5厚",
        "600桶-旋翼机吸牌轮齿轮套", "旋翼机黑磁吸牌轮隔磁片", "白加黑磁铁",
        "600桶-40桌面旋翼机输送带", "600桶-旋翼机带边输送轮",
        "600桶-输送出口滚轮32-14-改直", "MST输送出口滚轮-13", "MST输送张紧轮",
        "旋翼机输送张紧杆", "6-60输送轮轴", "输送电机-60转", "600桶-12齿齿轮",
        "旋翼机40#轨道基座（配128小立柱）", "旋翼机-轨道底垫-46-52(输送出口斜2度)（265）",
        "40#机头凸轮罩-（一体罩）",
        "42-52-机头圆柱凸轮-27齿-凸轮曲线0-5-60-220-310-355",
        "42-52-机头圆柱凸轮-27齿-凸轮曲线0-5-60-220-310-355-",
        "42-52-机头圆柱凸轮-27齿-凸轮曲线0-5-60-220-310-355-3",
        "42-52-机头圆柱凸轮-27齿-凸轮曲线0-5-60-220-310-35",
        "8-78凸轮轴", "旋翼机机头拨杆-48-54(264)(默认)", "机头拨杆轴套",
        "旋翼机机头光控-3插", "旋翼机机头光控卡扣", "旋翼机头磁控6+6",
        "ZYJ机头挡牌头消音片", "旋翼机头6P插头-弯脚", "3P插头-弯头", "电容",
        "旋翼机-42-54承牌-3", "6-75承牌轴", "复兴号旋翼机承牌贴",
        "旋翼机PTC加热器外壳", "旋翼机PTC加热器外壳盖", "旋翼机通风风扇60-60-15",
      ]),

 dict(key="06_turntable",
      title="Turntable",
      title_cn="大盘 / 拨牌",
      pitch="Felted disc on twelve rollers. Tiles dropped through the deck land here and are swept to each drum.",
      parts=[
        "十电机旋翼机610大盘", "610大盘布", "610-拨牌条",
        "大盘牛筋块-杰品", "大盘牛筋块-上向下装", "大盘滚轮-直径20",
        "杰品旋翼机大盘滚轮支架", "大盘电机双联齿轮-30", "80大盘电机",
        "巨无霸大盘电机支架1", "翻牌磁铁85-65",
      ]),

 dict(key="07_chassis_frame",
      title="Structural Frame",
      title_cn="大铁板 / 立柱",
      pitch="One folded steel deck carries every subassembly, so tolerances stack against a single datum.",
      parts=[
        "合丰40#大铁板", "128小立柱",
      ]),

 dict(key="08_power_electronics",
      title="Power & Control",
      title_cn="电脑板 / 电箱 / 环变",
      pitch="Toroidal transformer and the main board, in a shielded box slung under the deck.",
      parts=[
        "95mm大铁板电箱", "KZJ电脑板支架-孔距130", "四口机通用电脑小板",
        "普通环变", "4P插头",
      ]),
]

BASE2KEY = {}
for L in LAYERS:
    for p in L["parts"]:
        assert p not in BASE2KEY, "DUPLICATE base name: %s" % p
        BASE2KEY[p] = L["key"]
