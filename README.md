# bilibili-timeline-filter-tab
> 其实本来已经有很多个实现了类似功能的油猴插件，其中最有名的是[这个项目](https://github.com/hi94740/bilibili-timeline-filter.user.js) 。但是据我所知，所有host在greasyfork的、实现这个功能的项目都已经停止维护很久。其中前者提到的项目在几个月前还能勉强使用，但是最近已经完全失效，连UI组件都渲染不出来了，具体理由我没有深入研究（我看了下，他依赖的锚点并没有变，可能是它引入组件的方法和b站的什么前端实现冲突了）。

> 我询问AI了解了一下前文提到的项目的实现方法，可能是因为有一些额外的需求，实现用的是很复杂的清洗页面已有内容的过滤方法，我通过新的b站fetch API，通过更简洁的劫持动态流并过滤更改response实现了b站通过关注分组过滤动态的功能。

## 功能支持
- **通过关注分组过滤动态** 可以依照你已经分类好的关注，筛选并渲染动态页面
- **在分组的基础上兼容b站原本的视频、动态、文档分类** 因为使用的是劫持动态流的实现方法，因此可以直接兼容
## 功能演示
<img src="assets/demo.gif" width="600" alt="演示动画">

## 使用
### 第一步：安装脚本管理器
本脚本需要配合浏览器扩展 **Tampermonkey (油猴)** 使用。如果你尚未安装，请根据你的浏览器点击下方链接安装：

- [Chrome / Edge 版本](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Firefox 版本](https://addons.mozilla.org/zh-CN/firefox/addon/tampermonkey/)
- [Safari 版本 (Userscripts)](https://apps.apple.com/app/userscripts/id1463298887)

### 第二步：安装脚本
确保第一步完成后，点击下方的安装链接即可：

**[点击此处安装B站动态分组过滤](https://greasyfork.org/zh-CN/scripts/558232-b%E7%AB%99%E5%8A%A8%E6%80%81%E5%88%86%E7%BB%84%E8%BF%87%E6%BB%A4)**

> **提示**：点击后会跳转到 Tampermonkey 的安装页面，点击页面上的 **“安装”** 或 **“Install”** 按钮即可。

---

### 使用说明
1. 脚本安装完成后，打开 [Bilibili 动态首页](https://t.bilibili.com/)。
2. 等待页面加载，你会发现在原本的标签栏上方出现了一个**新的横向分组栏**。
3. 点击任意分组（如“特别关注”），列表将自动刷新并只显示该分组下的动态。
4. 再次点击“全部动态”可恢复默认状态。

