module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      // headIds/accessoryIds 为旧格式；新格式按身位 lineup 提交，冻结时校验
      required: ['showName', 'venue', 'play', 'tourDate'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-fire-wusheng-a',
      status: '可演出',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱甲-01',
        currentUsable: true
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-fire-wusheng-b',
      status: '可演出',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        accessories: ['红缨冠'],
        boxNo: '木箱甲-02',
        currentUsable: true
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-fire-houwang',
      status: '可演出',
      data: {
        role: '猴王',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '转眼正常',
        accessories: ['紫金冠'],
        boxNo: '木箱甲-03',
        currentUsable: true
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-skeleton-bai',
      status: '可演出',
      data: {
        role: '白骨夫人',
        play: '三打白骨精',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱丙-01',
        currentUsable: true
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-fire-duankao',
      status: '在库',
      data: {
        name: '短靠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-fire-zijin',
      status: '在库',
      data: {
        name: '紫金冠',
        role: '猴王',
        play: '火焰山',
        boxNo: '配件箱-03'
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单草稿',
    'POST /api/tourBoxes/:id/submit 提交巡演并冻结阵容快照',
    'POST /api/tourBoxes/:id/replacements 同剧目同角色临场替换',
    'POST /api/tourBoxes/:id/replacements/:rid/confirm 确认替换（返场清点）',
    'GET /api/tourBoxes/:id/timeline 名单与时间线一致视图',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
