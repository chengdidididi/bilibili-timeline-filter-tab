// ==UserScript==
// @name         B站动态分组过滤
// @namespace    https://github.com/chengdidididi
// @version      1.1
// @description  可以在渲染动态时筛选关注列表分组（分组标签栏随B站浅色/深色主题变色）
// @author       chnaxoeng
// @match        https://t.bilibili.com/*
// @grant        unsafeWindow
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    // --- 脚本配置 ---

    const GLOBAL_STATE = {
        isFiltering: false, // 是否开启过滤模式
        targetUids: [], // 当前选中的目标UID列表
        myUid: null,// 当前登录用户的UID
        currentGroupName: '',// 当前过滤的分组名；空串表示「全部动态」。空态提示要用它，避免快速切换分组时提示串台
        switchPending: false,// 正在切分组：遮罩期间不把旧列表露出来
        inflight: 0,// 在途的动态流请求数，用于判断「最后一个请求也空了」再显示空态
        pendingEmpty: null,// 在途请求还没回来时先记下这次空态，等全部请求结束再显示
        consecutiveEmptyResponses:0//熔断计数器，当连续访问分页未命中次数过多时熔断
    };

    const API_CONFIG = {
        TAGS: 'https://api.bilibili.com/x/relation/tags', // 获取分组列表
        TAG_USERS: 'https://api.bilibili.com/x/relation/tag',// 获取分组下的成员
        // 特别关注是虚拟分组（tagid 恒为 -10），成员列表有独立接口，一次返回全部 mid、不分页
        TAG_SPECIAL: 'https://api.bilibili.com/x/relation/tag/special',
        FEED_API: 'polymer/web-dynamic/v1/feed/all'// 动态流API片段
    };

    // 特别关注在 /x/relation/tags 里固定为 -10，属于内置虚拟分组
    const SPECIAL_TAG_ID = -10;

    const UI_CONFIG = {
        MAX_RETRY_PAGES: 10, // 过滤模式下，如果没有匹配内容，最大自动翻页数
        MAX_EMPTY_BATCHES: 3,//最大连续空包数
        EMPTY_STATE_SETTLE_MS: 80,// 等前端把响应渲染完再判断是否补空态，避免和它的重绘抢同一帧
        NOTICE_SETTLE_MS: 120,// 结果回来后等前端替换完子节点再撤掉遮罩，否则会先闪一下旧列表
        NOTICE_TIMEOUT_MS: 15000// 兜底：请求没触发或挂住时，别让遮罩一直挂在页面上
    };

    // --- Fetch API劫持实现动态过滤 ---
    const originalFetch = unsafeWindow.fetch;
    //备份原fetch方法后劫持并重写
    unsafeWindow.fetch = async function(urlOrRequest, options) {//URL标准化，字符串则直接使用，request对象则取出url
        let urlString;
        if (typeof urlOrRequest === 'string') {
            urlString = urlOrRequest;
        } else if (urlOrRequest instanceof Request) {
            urlString = urlOrRequest.url;
        } else {
            urlString = String(urlOrRequest);
        }

        // 仅在开启过滤且请求为动态流时拦截
        if (GLOBAL_STATE.isFiltering && urlString.includes(API_CONFIG.FEED_API)) {
            // 首屏请求不带 offset；脚本自己续页时会塞 offset，所以这个判断只在最外层做一次并一路传下去
            GLOBAL_STATE.inflight++;
            try {
                return await fetchUntilFound(urlString, options, 1, !hasOffsetParam(urlString));
            } finally {
                GLOBAL_STATE.inflight--;
                // 切分组会同时触发「视频」「全部」两个请求，空态要等最后一个也回来了再下结论，
                // 否则先回来的那个是空的，会把内容盖成「暂无新动态」
                if (GLOBAL_STATE.inflight === 0 && GLOBAL_STATE.pendingEmpty) {
                    const pending = GLOBAL_STATE.pendingEmpty;
                    GLOBAL_STATE.pendingEmpty = null;
                    scheduleEmptyState(pending.groupName, pending.replace);
                }
            }
        }

        return originalFetch(urlOrRequest, options);//当过滤未开启或不是动态流api时，调用原fetch方法
    };

    function constructNextUrl(currentUrlString, nextOffset) {//通过URL方法以base地址和当前url构建新的url，并替换offset达到读取下一页的效果
        try {
            const urlObj = new URL(currentUrlString, location.href);
            urlObj.searchParams.set('offset', nextOffset);
            return urlObj.toString();
        } catch (e) {
            return currentUrlString;
        }
    }

    async function fetchUntilFound(url, options, attempt, isFirstScreen) {
        try {
            const response = await originalFetch(url, options);
            if (!response.ok) return response;

            const clone = response.clone();//发起真实请求并clone非报错的response
            let data;
            try {
                data = await clone.json();//response中json解析错误
            } catch (jsonErr) {
                return response;
            }

            if (!data?.data?.items || !Array.isArray(data.data.items)) {//response中json不含有data.data.item或data.data.item不是数组
                return response;
            }

            // 通过filter(item->({}))方法过滤data.data.items中的动态，定义当前循环对象为item
            const filteredItems = data.data.items.filter(item => {
                const mid = item?.modules?.module_author?.mid;
                return GLOBAL_STATE.targetUids.includes(mid);//当targetUids包含遍历到的对象中的item.modules.module_author.mid，则该动态被滤出
            });

            const nextOffset = data.data.offset;
            const hasMore = data.data.has_more;

            if (filteredItems.length > 0) {// 当过滤后至少有一条，则说明命中了数据
                GLOBAL_STATE.consecutiveEmptyResponses = 0;//清空熔断计数器
                GLOBAL_STATE.pendingEmpty = null;//有内容了，之前挂起的空态作废
                revealFeed();// 切分组时撤掉遮罩；滚动加载时顺手清掉底部的「没有更多」
                data.data.items = filteredItems;//重新把过滤后的数组包装成json作response传给前端渲染
                return new Response(JSON.stringify(data), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            }

            // 未命中且动态流显示还能往下、且未达到最大未命中阈值时，继续翻页
            if (hasMore && nextOffset && attempt <= UI_CONFIG.MAX_RETRY_PAGES) {
                const nextUrl = constructNextUrl(url, nextOffset);
                return await fetchUntilFound(nextUrl, options, attempt + 1, isFirstScreen);
            }

            // 达到尝试上限，返回空数据并同步 offset
            GLOBAL_STATE.consecutiveEmptyResponses++;
            data.data.items = [];
            if (nextOffset) {
                data.data.offset = nextOffset;
            }
            if (GLOBAL_STATE.consecutiveEmptyResponses >= UI_CONFIG.MAX_EMPTY_BATCHES){
                data.data.has_more = false;//达到尝试上限的次数达到阈值，触发熔断，将has_more置为false避免再进行刷新
            }

            // B站对「items 为空」的响应基本不做处理，页面会停在上一组的内容上，看起来就像点了没反应。
            // 所以这里必须自己补一个空态提示，否则该分组无论多空都不会有任何视觉反馈。
            // 首屏空 = 整组没内容；翻页空 = 只是这之后没有了，提示要留在底部。
            if (GLOBAL_STATE.inflight > 1) {
                // 切分组会同时发「视频」「全部」两个请求，先回来的那个可能本来就是空的；
                // 先记下来，等最后一个请求结束再决定要不要显示空态
                GLOBAL_STATE.pendingEmpty = { groupName: GLOBAL_STATE.currentGroupName, replace: isFirstScreen };
            } else {
                GLOBAL_STATE.pendingEmpty = null;//没有别的请求在飞，直接下结论
                scheduleEmptyState(GLOBAL_STATE.currentGroupName, isFirstScreen);
            }

            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });

        } catch (e) {
            console.error('Fetch filter error:', e);
            return originalFetch(url, options);
        }
    }

    // --- 列表提示（遮罩 / 空态 / 底部提示） ---
    // B站动态列表容器是 .bili-dyn-list__items，单条动态是 .bili-dyn-list__item。
    // 提示节点始终插成列表的兄弟节点，不去改列表内部的子节点：那里是 B站 自己的渲染结果，插进去会被下次重渲染抹掉。
    //
    // 两种摆法：
    //   cover  盖住列表并占住它的位置（切分组时的「正在筛选」、首屏翻空时的「暂无新动态」）；
    //   bottom 列表保持显示，提示追加在列表末尾（往下翻页翻空时，不能把已有内容顶掉）。
    function showNotice(text, cover, retriesLeft = 10) {
        const list = document.querySelector('.bili-dyn-list__items');
        if (!list) {// 列表还没渲染出来（刚切 tab 的那一瞬间），稍后再试
            if (retriesLeft > 0) setTimeout(() => showNotice(text, cover, retriesLeft - 1), 120);
            return;
        }

        let notice = document.querySelector('.dyn-filter-notice');
        if (!notice) notice = document.createElement('div');
        notice.className = cover ? 'dyn-filter-notice' : 'dyn-filter-notice dyn-filter-notice--bottom';
        notice.textContent = text;

        if (cover) {
            list.parentNode.insertBefore(notice, list);
            list.style.display = 'none';
        } else {
            list.style.display = '';
            list.parentNode.insertBefore(notice, list.nextSibling);
        }
    }

    function clearNotice() {
        const notice = document.querySelector('.dyn-filter-notice');
        if (notice) notice.remove();
        const list = document.querySelector('.bili-dyn-list__items');
        if (list) list.style.display = '';
    }

    function showEmptyState(groupName, replace, retriesLeft = 10) {
        if (!groupName) return;
        const list = document.querySelector('.bili-dyn-list__items');
        // 一条动态都没渲染出来时，即使这次是翻页请求也只能占位，否则提示会孤零零挂在空白下面
        const hasItems = !!(list && list.querySelector('.bili-dyn-list__item'));
        const asReplacement = replace || !hasItems;
        const text = asReplacement ? `「${groupName}」暂无新动态` : `「${groupName}」没有更多新动态了`;
        showNotice(text, asReplacement, retriesLeft);
    }

    // 延后到前端渲染完成再补空态；期间若用户已经切走分组，就不该再显示了
    function scheduleEmptyState(groupName, replace) {
        if (!groupName) return;
        setTimeout(() => {
            if (GLOBAL_STATE.currentGroupName !== groupName) return;
            GLOBAL_STATE.switchPending = false;
            showEmptyState(groupName, replace);
        }, UI_CONFIG.EMPTY_STATE_SETTLE_MS);
    }

    // 切分组时 B站 会先拿内存里的旧列表画一遍，再去请求；不遮的话会先闪一下「全部」的内容，
    // 过几秒过滤结果到了才换掉。这里先盖一块提示顶住，等过滤结果回来再撤。
    let noticeToken = 0;
    function beginSwitch(groupName) {
        GLOBAL_STATE.switchPending = true;
        GLOBAL_STATE.pendingEmpty = null;
        showNotice(`正在筛选「${groupName}」…`, true);
        const token = ++noticeToken;
        setTimeout(() => {
            // 请求没被触发或者挂住了，别让遮罩一直贴在页面上
            if (token === noticeToken && GLOBAL_STATE.switchPending) {
                GLOBAL_STATE.switchPending = false;
                clearNotice();
            }
        }, UI_CONFIG.NOTICE_TIMEOUT_MS);
    }

    // 结果已经交回前端，但它要等下一帧才替换子节点；先等它画完再露出列表，否则会先闪一下旧缓存
    function finishSwitch() {
        GLOBAL_STATE.switchPending = false;
        const token = ++noticeToken;
        setTimeout(() => {
            if (token === noticeToken) clearNotice();
        }, UI_CONFIG.NOTICE_SETTLE_MS);
    }

    // 有内容要展示：切分组时撤遮罩，滚动加载时清掉底部的「没有更多」
    function revealFeed() {
        if (GLOBAL_STATE.switchPending) finishSwitch();
        else clearNotice();
    }

    // 首屏请求不带 offset；带 offset 说明是往下翻页（或脚本自己构造的续页地址）
    function hasOffsetParam(urlString) {
        try {
            return !!new URL(urlString, location.href).searchParams.get('offset');
        } catch (e) {
            return false;
        }
    }

    // --- 动态分组tab实现 ---
    //通过cookie读取你的b站uid
    function getMyUid() {
        const match = document.cookie.match(/DedeUserID=([^;]+)/);
        return match ? match[1] : null;
    }
    //定义一个携带你cookie的fetch方法
    async function fetchJson(url) {
        const res = await fetch(url, { credentials: 'include' });
        return await res.json();
    }

    // 特别关注走独立接口：/x/relation/tag 对 -10 是否可用在B站各端并不一致，
    // 而 /x/relation/tag/special 一次就能拿到全部 mid，失败时再退回分页接口。
    async function fetchSpecialUids() {
        try {
            const json = await fetchJson(API_CONFIG.TAG_SPECIAL);
            if (json.code === 0 && Array.isArray(json.data)) return json.data;
        } catch (e) {
            console.warn('特别关注接口失败，退回分组接口', e);
        }
        return null;
    }

    async function fetchUidsByTag(tagId) {
        if (!GLOBAL_STATE.myUid) GLOBAL_STATE.myUid = getMyUid();//确保拿到了当前用户的 ID

        if (tagId === SPECIAL_TAG_ID) {
            const special = await fetchSpecialUids();
            if (special) return special;
        }

        let page = 1;
        let pageSize = 20;
        let allUids = [];
        let hasMore = true;

        while (hasMore) {
            const url = `${API_CONFIG.TAG_USERS}?mid=${GLOBAL_STATE.myUid}&tagid=${tagId}&pn=${page}&ps=${pageSize}`;
            try {
                const json = await fetchJson(url);
                if (json.code !== 0) {
                    // 第一页就报错说明这次过滤拿不到任何 UID，抛出去让 UI 显示失败而不是静默空掉
                    if (page === 1) throw new Error(json.message || `code ${json.code}`);
                    break;
                }

                const data = json.data;
                if (!data || !data.length) {// 如果 data 是空的，或者长度为 0，说明没数据了，停止
                    hasMore = false;
                    break;
                }

                const uids = data.map(user => user.mid);// 使用map()把 mid (UID) 提取出来变成新数组
                allUids.push(...uids);//将得到的结果push到allUids

                if (data.length < pageSize) {
                    hasMore = false;
                } else {
                    page++;
                    await new Promise(r => setTimeout(r, 100));// 等待0.1秒，防止请求太快触发 B 站的 412/429 频率限制。
                }
            } catch (e) {
                if (page === 1) throw e;
                hasMore = false;
            }
        }
        return allUids;
    }

    // --- UI渲染与交互 ---

    async function forceFeedReload() {// 通过点按视频再点按全部达到强制刷新
        // 获取原生标签栏
        const nativeTabs = document.querySelectorAll('.bili-dyn-list-tabs__item');
        if (nativeTabs.length < 2) {
            console.warn('无法找到原生标签，尝试滚动刷新');
            window.scrollTo({ top: 0, behavior: 'auto' });
            return;
        }

        const allTab = nativeTabs[0]; // “全部”
        const videoTab = nativeTabs[1]; // “视频”
        GLOBAL_STATE.consecutiveEmptyResponses = 0;// 切换标签时，重置熔断计数器
        videoTab.click();
        await new Promise(r => setTimeout(r, 100));
        allTab.click();
        window.scrollTo({ top: 0, behavior: 'smooth' });//滚动回顶部
    }

    // 颜色一律取自 B 站自己的主题变量，浅色/深色模式都会自动跟随。
    // --bew-content-solid 是 BewlyBewly 深色模式下给动态页卡片（含原生 tab 栏）用的底色，
    // 没有它时回退到 B 站的 --bg1，避免深色模式下这块标签栏又变成白条。
    // 不画边框：原生 tab 栏本身就是无边框的圆角卡片，画描边在深色模式下会露出一圈浅色框
    const STYLE_CSS = `
        .tab-container {
            background-color: var(--bew-content-solid, var(--bg1, #ffffff));
            border-radius: 6px;
            padding: 0 10px;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            height: 48px;
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
            position: relative;
            width: 100%;
            box-sizing: border-box;
        }
        .tab-scroll-area {
            display: flex;
            flex-wrap: nowrap;
            overflow-x: auto;
            width: 100%;
            height: 100%;
            align-items: center;
            scrollbar-width: none;
            -ms-overflow-style: none;
            padding: 0 5px;
            scroll-behavior: smooth;
        }
        .tab-scroll-area::-webkit-scrollbar {
            display: none;
        }
        .tab-item {
            position: relative;
            margin-right: 24px;
            font-size: 14px;
            color: var(--text2, #61666d);
            cursor: pointer;
            height: 100%;
            display: flex;
            align-items: center;
            white-space: nowrap;
            flex-shrink: 0;
            transition: color 0.2s;
            user-select: none;
        }
        .tab-item:hover {
            color: var(--brand_blue, #00aeec);
        }
        .tab-item.active {
            color: var(--brand_blue, #00aeec);
            font-weight: 600;
        }
        .tab-item.loading {
            color: var(--brand_pink, #fb7299);
            cursor: wait;
        }
        .dyn-filter-notice {
            padding: 48px 0;
            text-align: center;
            font-size: 14px;
            color: var(--text3, var(--text2, #9499a0));
            user-select: none;
        }
        .dyn-filter-notice--bottom {
            padding: 20px 0;
        }
    `;

    function renderTabs(parentElement, nextSiblingElement, tags) {
        const bar = document.createElement('div');//创建div的容器
        bar.className = 'tab-container';

        const scrollArea = document.createElement('div');//创建div的滚动区域
        scrollArea.className = 'tab-scroll-area';

        scrollArea.addEventListener('wheel', (e) => {//滚动区域监听滚轮，将垂直滚动禁用并加到横向滚动上
            if (e.deltaY !== 0) {
                e.preventDefault();
                scrollArea.scrollLeft += e.deltaY;
            }
        }, { passive: false });

        const defaultTab = { name: '全部动态', id: -1 };//默认第一项为全部动态，此时设置为不开启过滤
        const allTabs = [defaultTab, ...tags.map(t => ({ name: t.name, id: t.tagid, count: t.count }))];//仅获取name和id（count用于校验成员是否真的拉到）

        allTabs.forEach((tab) => {//逐一生成标签
            const item = document.createElement('div');
            item.className = 'tab-item';
            if (tab.id === -1) item.classList.add('active');
            item.innerText = tab.name;

            item.onclick = async function() {// 同一时刻只有一个按钮能active
                const siblings = scrollArea.querySelectorAll('.tab-item');
                siblings.forEach(el => el.classList.remove('active'));
                item.classList.add('active');

                if (tab.id === -1) {//当点击全部动态时关闭过滤
                    GLOBAL_STATE.isFiltering = false;
                    GLOBAL_STATE.targetUids = [];
                    GLOBAL_STATE.currentGroupName = '';
                    GLOBAL_STATE.switchPending = false;
                    clearNotice();
                    forceFeedReload(); // 强制刷新
                } else {
                    const originalText = item.innerText;
                    item.innerText = '加载中...';
                    item.classList.add('loading');

                    try {
                        const uids = await fetchUidsByTag(tab.id);//获取UID

                        if (!uids.length) {
                            // 拿不到任何成员（接口异常或分组本来就是空的），直接说明情况，
                            // 不要开着过滤去请求，否则每点一次就白翻 10 页
                            GLOBAL_STATE.isFiltering = false;
                            GLOBAL_STATE.targetUids = [];
                            GLOBAL_STATE.currentGroupName = tab.name;
                            GLOBAL_STATE.switchPending = false;
                            showEmptyState(tab.name, true);
                            console.warn(`分组「${tab.name}」未取到成员，分组人数标记为 ${tab.count}`);
                            return;
                        }

                        GLOBAL_STATE.targetUids = uids;//更新全局状态
                        GLOBAL_STATE.currentGroupName = tab.name;
                        GLOBAL_STATE.isFiltering = true;
                        beginSwitch(tab.name);// 先盖住旧列表，免得 B站 用缓存把「全部」的内容又画出来

                        await forceFeedReload(); //强制清空并刷新列表

                    } catch (err) {
                        console.error('Group fetch failed', err);
                        item.innerText = '获取失败';
                        GLOBAL_STATE.isFiltering = false;
                        GLOBAL_STATE.targetUids = [];
                        GLOBAL_STATE.currentGroupName = '';
                        GLOBAL_STATE.switchPending = false;
                        clearNotice();
                    } finally {
                        item.classList.remove('loading');
                        // 失败时 innerText 已经被改成「获取失败」，不要再用原名覆盖回去
                        if (item.innerText === '加载中...') item.innerText = originalText;
                    }
                }
            };

            scrollArea.appendChild(item);// 把按钮放入滚动区
        });

        bar.appendChild(scrollArea);//滚动区放入外壳容器
        parentElement.insertBefore(bar, nextSiblingElement);// 把外壳插到页面指定位置
    }

    async function initUI() {
        GLOBAL_STATE.myUid = getMyUid();
        if (!GLOBAL_STATE.myUid) return;// 没登录就直接退出

        const styleEl = document.createElement('style');
        styleEl.innerHTML = STYLE_CSS;
        document.head.appendChild(styleEl);// 把 CSS 样式表插到网页头部

        let tagsData = [];
        try {
            const res = await fetchJson(API_CONFIG.TAGS);// 异步请求分组数据
            if (res.code === 0) tagsData = res.data;
        } catch(e) { console.error(e); }

        const waitForTarget = setInterval(() => {
            const targetElement = document.querySelector('.bili-dyn-list-tabs');//寻找B站原本的标签栏 (.bili-dyn-list-tabs)
            if (targetElement && !document.querySelector('.tab-container')) {
                clearInterval(waitForTarget);
                renderTabs(targetElement.parentNode, targetElement, tagsData);
            }
        }, 500);
    }

    if (document.readyState === 'loading') {//网页loading好了再注入
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

})();
