import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { layoutPet } = createRequire(import.meta.url)('../runtime/placement.cjs');
const area = { x: 0, y: 0, width: 1440, height: 900 };
const workArea = { ...area, y: 25, height: 875 };

test('character reaches the top and the activity panel flips while the anchor stays fixed', () => {
  for (const y of [130, 111, 110, 109, 90, 26, 25, -500]) {
    const p = layoutPet({ x: 200, y }, area);
    const expected = Math.max(area.y, y);
    assert.equal(p.position.y, expected);
    assert.equal(p.bounds.y + p.content.top, expected);
    assert.equal(p.content.below, area.y + area.height - expected >= 480 || expected - area.y < 345);
    assert.ok(p.bounds.y >= area.y);
    assert.ok(p.bounds.y + p.bounds.height <= area.y + area.height);
  }
});

test('display bounds allow the pet above the macOS work-area top', () => {
  const p = layoutPet({ x: 200, y: 0 }, area);
  assert.equal(p.position.y, 0);
  assert.ok(p.position.y < workArea.y);
  assert.equal(p.bounds.y + p.content.top, 0);
});

test('character stays reachable at all edges, including small mode and negative displays', () => {
  for (const mini of [false, true]) {
    const scale = mini ? .8 : 1;
    for (const display of [area, { x: -1920, y: -400, width: 1920, height: 1080 }]) {
      for (const x of [display.x - 500, display.x + 200, display.x + display.width + 500]) {
        for (const y of [display.y - 500, display.y + 100, display.y + display.height + 500]) {
          const p = layoutPet({ x, y }, display, mini);
          assert.ok(p.position.x >= display.x);
          assert.ok(p.position.y >= display.y);
          assert.ok(p.position.x + 100 * scale <= display.x + display.width);
          assert.ok(p.position.y + 135 * scale <= display.y + display.height);
          assert.ok(Math.abs(p.bounds.x + p.content.left * scale - p.position.x) < 1);
          assert.ok(Math.abs(p.bounds.y + p.content.top * scale - p.position.y) < 1);
          assert.ok(p.bounds.x >= display.x && p.bounds.x + p.bounds.width <= display.x + display.width);
          assert.ok(p.bounds.y >= display.y && p.bounds.y + p.bounds.height <= display.y + display.height);
        }
      }
    }
  }
});

test('the window grows upward so the animation icons above the head stay visible', () => {
  const p = layoutPet({ x: 200, y: 40 }, area);
  assert.equal(p.content.below, true);
  // 忙碌动画的图标最高到命中框上方 22.7px，窗口顶边必须让出这段
  assert.equal(p.content.top, 26);
  assert.equal(p.bounds.y, 14);
  // 宠物屏幕位置和窗口下沿都不变：面板可用空间一寸没少
  assert.equal(p.bounds.y + p.content.top, 40);
  assert.equal(p.bounds.y + p.bounds.height, 40 + 480);
});

test('headroom is capped by the room that actually exists above the character', () => {
  const p = layoutPet({ x: 200, y: 10 }, area);
  assert.equal(p.bounds.y, 0);
  assert.equal(p.content.top, 10);
  assert.equal(p.bounds.y + p.content.top, 10);
});

test('custom pet sizes keep both the character and control panel inside the display', () => {
  for (const scale of [.7, .8, .9, 1, 1.1, 1.2]) {
    const p = layoutPet({ x: 1300, y: 850 }, area, scale);
    assert.equal(p.bounds.width, Math.round(400 * scale));
    assert.equal(p.bounds.height, Math.round(480 * scale));
    assert.ok(p.bounds.x >= area.x && p.bounds.x + p.bounds.width <= area.x + area.width);
    assert.ok(p.bounds.y >= area.y && p.bounds.y + p.bounds.height <= area.y + area.height);
    assert.ok(p.position.x + 100 * scale <= area.x + area.width);
    assert.ok(p.position.y + 135 * scale <= area.y + area.height);
  }
});
