import { renderRss2 } from '../../utils/util';

// 模拟真实桌面 Chrome 的导航请求头，降低被风控拦截的概率（纯匿名，不携带任何账号 cookie）
const browserHeaders = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
	'Accept-Language': 'zh-CN,zh;q=0.9',
	'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"',
	'Sec-Ch-Ua-Mobile': '?0',
	'Sec-Ch-Ua-Platform': '"Windows"',
	'Sec-Fetch-Dest': 'document',
	'Sec-Fetch-Mode': 'navigate',
	'Sec-Fetch-Site': 'none',
	'Sec-Fetch-User': '?1',
	'Upgrade-Insecure-Requests': '1',
	Referer: 'https://www.xiaohongshu.com/',
};

let getUser = async (url) => {
	let res = await fetch(url, {
		headers: browserHeaders,
	});
	if (!res.ok) {
		throw new Error(`请求小红书失败 (HTTP ${res.status})，可能被风控拦截或需登录`);
	}
	let scripts = [];
	let rewriter = new HTMLRewriter()
		.on('script', {
			element(element) {
				scripts.push('');
			},
			text(text) {
				scripts[scripts.length - 1] += text.text;
			},
		})
		.transform(res);
	await rewriter.text();
	let script = scripts.find((script) => script.startsWith('window.__INITIAL_STATE__='));
	if (!script) {
		throw new Error('未能从小红书页面解析用户数据，可能被风控拦截或页面结构已变更');
	}
	script = script.slice('window.__INITIAL_STATE__='.length);
	// replace undefined to null
	script = script.replace(/undefined/g, 'null');
	let state;
	try {
		state = JSON.parse(script);
	} catch (e) {
		throw new Error('解析小红书页面数据失败，可能被风控拦截或页面结构已变更');
	}
	return state.user;
};

let deal = async (ctx) => {
	// const uid = ctx.params.user_id;
	// const category = ctx.params.category;
	const { uid } = ctx.req.param();
	const category = 'notes';
	const url = `https://www.xiaohongshu.com/user/profile/${uid}`;

	const user = (await getUser(url)) || {};
	const { userPageData, notes, collect } = user;
	const basicInfo = userPageData?.basicInfo;
	const interactions = userPageData?.interactions || [];
	const tags = userPageData?.tags || [];
	if (!basicInfo) {
		throw new Error('无法获取小红书用户信息：可能被风控拦截、需要登录或用户不存在');
	}

	const title = `${basicInfo.nickname} - ${category === 'notes' ? '笔记' : '收藏'} • 小红书 / RED`;
	const description = `${basicInfo.desc || ''} ${(tags || []).map((t) => t?.name || '').join(' ')} ${(interactions || []).map((i) => `${i?.count ?? ''} ${i?.name || ''}`).join(' ')}`.trim();
	const image = basicInfo.imageb || basicInfo.images;

	// 注意：小红书在 SSR 阶段已把每条笔记的 noteId 脱敏为空串（实测 web/移动端 API
	// 在无签名/无 cookie 时均返回 406/404，拿不到真实 noteId），因此 link 无法直达
	// 具体笔记。这里回退指向用户主页，避免 RSS 阅读器中出现打不开的坏链接。
	const renderNote = (notes) =>
		(notes || []).flatMap((n) =>
			(n || [])
				.filter((entry) => entry)
				.map((entry) => {
					const noteCard = entry.noteCard || {};
					const cover = noteCard.cover || {};
					const infoList = cover.infoList || [];
					const coverUrl = (infoList[infoList.length - 1] || {}).url || cover.url || '';
					return {
						title: noteCard.displayTitle,
						link: noteCard.noteId ? `${url}/${noteCard.noteId}` : url,
						guid: `${noteCard.displayTitle}-${noteCard.noteId || ''}`,
						description: coverUrl ? `<img src ="${coverUrl}"><br>${noteCard.displayTitle}` : `${noteCard.displayTitle}`,
						author: noteCard.user?.nickname,
						upvotes: noteCard.interactInfo?.likedCount,
					};
				})
		);
	const renderCollect = (collect) => {
		if (!collect) {
			throw Error('该用户已设置收藏内容不可见');
		}
		if (collect.code !== 0) {
			throw Error(JSON.stringify(collect));
		}
		if (!Array.isArray(collect.data?.notes)) {
			throw Error('该用户已设置收藏内容不可见');
		}
		return collect.data.notes
			.filter((item) => item)
			.map((item) => {
				const infoList = item.cover?.info_list || [];
				const coverUrl = (infoList[infoList.length - 1] || {}).url || item.cover?.url || '';
				return {
					title: item.display_title,
					link: item.note_id ? `${url}/${item.note_id}` : url,
					guid: `${item.display_title}-${item.note_id || ''}`,
					description: coverUrl ? `<img src ="${coverUrl}"><br>${item.display_title}` : `${item.display_title}`,
					author: item.user?.nickname,
					upvotes: item.interact_info?.likedCount,
				};
			});
	};

	ctx.header('Content-Type', 'application/rss+xml; charset=UTF-8');
	return ctx.body(
		renderRss2({
			title,
			description,
			image,
			link: url,
			items: category === 'notes' ? renderNote(notes) : renderCollect(collect),
		})
	);
};

let setup = (route) => {
	route.get('/xiaohongshu/user/:uid', deal);
};

export default { setup };
