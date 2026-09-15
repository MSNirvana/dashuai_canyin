// tslib 精简 shim —— 只含 tdesign-miniprogram 运行时真正用到的 3 个 helper
//
// ══ 为什么需要它 ══
// tdesign-miniprogram 从 1.9.0 起，运行时产物里带裸模块引用
// `import{__decorate}from"tslib"`（官方已知问题，见 Tencent/tdesign-miniprogram#3697），
// 但它的 package.json **没有声明任何 dependencies** —— tslib 是隐式依赖，
// 需要由使用方自己提供。于是 Taro 的按需拷贝不会把 tslib 带进产物，运行时直接报：
//
//   module 'npm/tdesign-miniprogram/button/tslib.js' is not defined, require args is 'tslib'
//
// ══ 为什么是「精简 + 逐目录」而不是「整份 tslib.js 拷一份」 ══
// 微信小程序的模块解析对 `npm/` 下的裸模块名会退回**相对当前文件**解析
// （报错信息里给出的候选路径就是 <组件目录>/tslib.js），所以 tslib 必须出现在
// **每个引用它的目录**里，而不是 npm/ 根下。
// 体积账：整份 tslib.js 23KB × 11 个目录 = 253KB，会顶爆主包 2MB 配额；
//         本 shim 约 2KB × 11 ≈ 22KB。
//
// ══ 维护须知 ══
// 函数体逐字取自 node_modules/tslib（v2.8.1）的同名实现，只调整了缩进、
// 去掉了 `(this && this.__x) ||` 前缀（那是为了复用全局定义，模块内无意义）。
// 若 tdesign 升级后用到新的 helper，**构建会直接失败**并告诉你缺哪个
// —— 见 config/tdesign-copy.ts::collectTslibUsage 的校验。届时把新 helper 补到这里。
//
// 由 config/tdesign-copy.ts 自动拷到各组件目录，不要手工复制。
/* eslint-disable */

function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
  return new (P || (P = Promise))(function (resolve, reject) {
    function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
    function rejected(value) { try { step(generator['throw'](value)); } catch (e) { reject(e); } }
    function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}

function __decorate(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === 'object' && typeof Reflect.decorate === 'function') r = Reflect.decorate(decorators, target, key, desc);
  else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
}

function __rest(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
    t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === 'function')
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
}

// 用 CJS 导出：微信小程序对 CommonJS 是原生支持，
// 且它把 `import{a}from"x"` 编译成 `require("x").a`，正好对得上。
exports.__awaiter = __awaiter;
exports.__decorate = __decorate;
exports.__rest = __rest;
