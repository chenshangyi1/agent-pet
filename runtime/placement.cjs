'use strict';

/**
 * 头顶净空：忙碌 / 庆祝这类动画会把图标飘到画面顶部（逐帧实测最高到 640×360 的 y=4，
 * 按 300px 宽的视频折算，落在宠物命中框上方 22.7px）。窗口顶端若压在命中框顶边，
 * 这三个图标就被窗口上沿切掉半截。
 * 只在「面板放下方」这条分支需要补：另一条分支窗口本来就向上展开了 345px。
 */
const HEADROOM = 26;

/** Keep the character reachable and reserve transparent room for the activity cards. */
function layoutPet(position, area, mini = false) {
  const scale = typeof mini === 'number' ? Math.max(.65, Math.min(1.25, mini)) : mini ? .8 : 1;
  const width = Math.round(400 * scale), baseHeight = Math.round(480 * scale);
  const characterWidth = 100 * scale, characterHeight = 135 * scale;
  const left = Math.max(area.x, Math.min(position.x, area.x + area.width - characterWidth));
  const top = Math.max(area.y, Math.min(position.y, area.y + area.height - characterHeight));
  const below = area.y + area.height - top >= baseHeight || top - area.y < (baseHeight - 135 * scale);
  // 让出的净空同时加进窗口高度，所以宠物的屏幕位置、面板位置和窗口下沿都不变：
  // 窗口上移 head，内容区的 --pet-top 也 +head，两者相抵。
  // 只让出屏幕上真实存在的空间，否则窗口顶出屏幕会被系统钳回、反而又切一刀。
  const head = below ? Math.min(HEADROOM, (top - area.y) / scale) : 0;
  const height = below ? Math.round(baseHeight + head * scale) : baseHeight;
  const x = Math.max(area.x, Math.min(left - 150 * scale, area.x + area.width - width));
  const y = below ? top - head * scale : top + characterHeight - baseHeight;
  return {
    position: { x: Math.floor(left), y: Math.floor(top) },
    bounds: { x: Math.round(x), y: Math.round(y), width, height },
    content: { left: (left - x) / scale, top: (top - y) / scale, panelLeft: (left - x) / scale - 140, below },
  };
}
module.exports = { layoutPet };
