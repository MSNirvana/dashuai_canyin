// defineAppConfig 是 Taro 4 的全局声明，无需 import
export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/store/list',
    'pages/store/edit',
    'pages/store/detail',
    'pages/dish/list',
    'pages/dish/edit',
    'pages/dish/detail',
    'pages/persona/index',
    'pages/creation/list',
    'pages/creation/edit',
    'pages/creation/shots',
    'pages/render/compose',
    'pages/work/detail',
    'pages/recharge/index',
    'pages/mine/index',
    // 教学中心：分类课程页（?category=SHOOTING|EDITING|OPERATION|MANUAL）
    'pages/tutorial/index',
    // 个人主页：换头像 + 改用户名（点头像/用户名进入）
    'pages/profile/index',
    // 用户协议 / 隐私政策（一个页面承载两份文档，用 ?type=user|privacy 区分）
    'pages/agreement/index',
  ],

  // TDesign 组件全局注册：页面内可直接使用 <t-button /> <t-input /> <t-icon /> 等
  usingComponents: {
    't-button': 'tdesign-miniprogram/button/button',
    't-input': 'tdesign-miniprogram/input/input',
    't-cell': 'tdesign-miniprogram/cell/cell',
    't-cell-group': 'tdesign-miniprogram/cell-group/cell-group',
    't-toast': 'tdesign-miniprogram/toast/toast',
    't-dialog': 'tdesign-miniprogram/dialog/dialog',
    't-icon': 'tdesign-miniprogram/icon/icon',
  },

  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '大帅餐饮',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f5f6f8',
  },

  // 组件按需注入：只把当前页面真正用到的自定义组件注入给它。
  // 不开的话，app.json 里声明的组件会把所有组件代码都注入每个页面 —— 主包会大一圈，
  // 开发者工具「代码质量 → 代码包 → 组件 → 启用组件按需注入」也会判未通过。
  // 前置条件：基础库 ≥ 2.11.1（project.config.json 里 libVersion 是 3.5.0，满足）。
  lazyCodeLoading: 'requiredComponents',

  // 底部导航栏（白底 + 品牌红选中态）
  // 色值与 src/styles/theme.scss 的品牌红 #e1251b / 占位灰 #8e939a 保持一致
  tabBar: {
    color: '#8e939a',
    selectedColor: '#e1251b',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/home/index',
        text: '首页',
        iconPath: 'assets/tabbar/home.png',
        selectedIconPath: 'assets/tabbar/home-active.png',
      },
      {
        pagePath: 'pages/creation/list',
        text: '创作',
        iconPath: 'assets/tabbar/create.png',
        selectedIconPath: 'assets/tabbar/create-active.png',
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-active.png',
      },
    ],
  },

  // ── 分包（当前未启用；主包 1.68MB / 上限 2MB，余量 0.32MB）──────────────────
  //
  // 现状：暂不需要。但主包一旦逼近 1.9MB 就该切分包，**而不是继续压图片** ——
  //       产物自检脚本（scripts/verify-weapp-dist.mjs）会在超过 90% 时给出预警。
  //
  // ★ 原注释里的配置路径全是错的（`creation/index`、`render/index`、`bean/index` …），
  //   对应的是早期规划过但没落地的目录结构，照抄启用只会白屏。
  //
  // 三条硬约束（都踩过/核对过，不是推测）：
  //   1. **分包 root 不能放在主包 pages 目录下**
  //      —— 见 @tarojs/taro/types/taro.config.d.ts 的 SubPackage.root 注释。
  //      所以 `root: 'pages/store'` 这种写法是无效的，必须把页面目录**搬出 pages/**
  //      到 src 下的独立目录（下面的 packageXxx 命名）。
  //   2. **tabBar 页面必须留在主包** → pages/home、pages/creation/list、pages/mine 三个页面
  //      不能下放；且 pages/creation 下同时有 list（留主包）与 edit/shots（可下放），
  //      所以 creation 只能拆一半，拆分成本高于收益，暂不拆。
  //   3. 分包 root 之间不能互相嵌套。
  //
  // 因此启用分包 = **一次真实的重构**（移动文件 + 改所有 Taro.navigateTo 路径），
  // 不是「取消注释」那么轻。届时按下面结构搬：
  //
  //   src/pages/            只留主包：home、creation/list、mine
  //   src/packageStore/     root: 'packageStore'  → ['list/index','edit/index','detail/index']
  //   src/packageDish/      root: 'packageDish'   → ['list/index','edit/index','detail/index']
  //   src/packageRender/    root: 'packageRender' → ['compose/index']
  //   src/packageMisc/      root: 'packageMisc'   → ['persona/index','work/detail/index','recharge/index']
  //
  // 对应配置（Taro 字段名是 subPackages，不是 weapp 原生的小写 subpackages；两者都接受但以 Taro 为准）：
  //
  // subPackages: [
  //   { root: 'packageStore',  pages: ['list/index', 'edit/index', 'detail/index'] },
  //   { root: 'packageDish',   pages: ['list/index', 'edit/index', 'detail/index'] },
  //   { root: 'packageRender', pages: ['compose/index'] },
  //   { root: 'packageMisc',   pages: ['persona/index', 'work/detail/index', 'recharge/index'] },
  // ],
  // preloadRule: {
  //   // 首页进入时预下载体量最大的一组，避免点进去才加载
  //   'pages/home/index': { network: 'all', packages: ['packageStore'] },
  // },

  style: 'v2',
})
