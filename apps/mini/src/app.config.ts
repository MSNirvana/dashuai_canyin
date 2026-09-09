// defineAppConfig 是 Taro 4 的全局声明，无需 import
export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/store/list',
    'pages/store/edit',
    'pages/dish/list',
    'pages/dish/edit',
    'pages/persona/index',
    'pages/creation/list',
    'pages/creation/edit',
    'pages/creation/shots',
    'pages/render/compose',
    'pages/recharge/index',
    'pages/mine/index',
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

  // 底部导航栏（白底 + 品牌红选中态）
  tabBar: {
    color: '#9a9ea5',
    selectedColor: '#e63946',
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

  // 分包（页面补齐后开启）
  // subpackages: [
  //   { root: 'pages-creation', pages: ['creation/index', 'script/index', 'shoot/index'] },
  //   { root: 'pages-render',   pages: ['render/index'] },
  //   { root: 'pages-bean',     pages: ['bean/index'] },
  //   { root: 'pages-member',   pages: ['member/index'] },
  //   { root: 'pages-profile',  pages: ['store-list/index', 'store-edit/index', 'dish/index', 'persona/index'] },
  // ],
  // preloadRule: {
  //   'pages/home/index': { network: 'all', packages: ['pages-creation'] },
  // },

  style: 'v2',
})
