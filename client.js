/**
 * dsh-workbuddy 的 Web 面板壳。
 *
 * 这个文件只做三件事：注册右栏 tab 类型、注册它的正文、把正文画成一个 iframe。
 * 真正的界面在 panel/panel.html，由宿主路由 /dsh-workbuddy/panel 每次读盘实时返回 ——
 * 所以调 UI 不用重启 dsh，刷新页面（或 iframe）就生效。
 *
 * 兼容性：
 *   - tab 的 id/kind 唯一（dsh-workbuddy / workbuddy），不接管别人的 kind；
 *   - 不往 shell.overlay 塞东西（那是 purge dock / orb / live2d 的地盘）；
 *   - 样式关在 iframe 里，不写任何全局选择器，也不改 dsh 的主题变量；
 *   - 主题由本壳探测后通过 ?scheme= 与 postMessage 传给 iframe。
 */
window.__ModuleLoader__.load({
	id: 'dsh-workbuddy',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useRef } = react;

		const name = 'dsh-workbuddy';
		const inject = ['slots', 'sidebarRightTabs'];

		const TAB_ID = 'dsh-workbuddy';
		const TAB_KIND = 'workbuddy';
		const PANEL_PATH = '/dsh-workbuddy/panel';
		const DEBUG = true;
		function log(...args) {
			if (!DEBUG) return;
			try {
				console.info('[dsh-workbuddy]', ...args);
			} catch {
				/* ignore */
			}
		}

		/** dsh 的主题由外壳决定：读 body/html 的背景亮度，比猜 prefers-color-scheme 准。 */
		function detectScheme() {
			try {
				for (const node of [document.body, document.documentElement]) {
					if (!node) continue;
					const bg = getComputedStyle(node).backgroundColor || '';
					const m = bg.match(/rgba?\(([^)]+)\)/);
					if (!m) continue;
					const p = m[1].split(',').map((v) => parseFloat(v));
					const a = p.length > 3 ? p[3] : 1;
					if (a < 0.2) continue;
					const lum = ((p[0] || 0) * 299 + (p[1] || 0) * 587 + (p[2] || 0) * 114) / 1000;
					return lum > 140 ? 'light' : 'dark';
				}
			} catch {
				/* ignore */
			}
			return 'dark';
		}

		function WorkbuddyFrame() {
			const [scheme, setScheme] = useState(() => detectScheme());
			const frameRef = useRef(null);

			// 主题变化时既改 src（首次加载用）也 postMessage（已加载时用，避免整页重载）
			useEffect(() => {
				const id = setInterval(() => {
					const next = detectScheme();
					setScheme((prev) => {
						if (prev === next) return prev;
						const frame = frameRef.current;
						if (frame && frame.contentWindow) {
							try {
								frame.contentWindow.postMessage({ type: 'dsh-workbuddy:scheme', scheme: next }, '*');
							} catch {
								/* ignore */
							}
						}
						return next;
					});
				}, 4000);
				return () => clearInterval(id);
			}, []);

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320, minWidth: 0 } },
				h('iframe', {
					ref: frameRef,
					title: 'WorkBuddy 工作台',
					src: `${PANEL_PATH}?scheme=${scheme}`,
					style: {
						flex: '1 1 auto',
						minHeight: 0,
						width: '100%',
						border: 'none',
						background: 'transparent',
						display: 'block',
						colorScheme: scheme,
					},
				}),
			);
		}

		function apply(ctx) {
			const effect = (fn, label) => {
				if (typeof ctx.effect === 'function') return ctx.effect(fn, label);
				return fn();
			};

			// stage 1：tab 类型
			effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						priority: 'extension',
						keepMounted: true,
						title: () => 'WorkBuddy',
						guide: [
							{
								id: 'workbuddy-open',
								order: 40,
								title: () => 'WorkBuddy 工作台',
								description: () => '换模型、派活给本机 WorkBuddy，同时盯多个任务',
							},
						],
					}),
				'dsh-workbuddy: tab type',
			);

			// stage 2：正文（薄壳）+ chip 标题
			effect(
				() =>
					ctx.slots.inject('sidebar.right.pane.tab', () =>
						ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, WorkbuddyFrame),
					),
				'dsh-workbuddy: panel shell',
			);

			effect(
				() =>
					ctx.slots.inject('sidebar.right.pane.tab.title', () =>
						ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () =>
							h('span', { style: { fontSize: 11.5 } }, 'WorkBuddy'),
						),
					),
				'dsh-workbuddy: panel title',
			);

			log('applied (iframe shell →', PANEL_PATH + ')');
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
