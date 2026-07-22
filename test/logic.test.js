const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic.js');

test('yuanToFen：合法输入', () => {
  assert.equal(L.yuanToFen('1'), 100);
  assert.equal(L.yuanToFen('0.5'), 50);
  assert.equal(L.yuanToFen('2.50'), 250);
  assert.equal(L.yuanToFen('12.05'), 1205);
});

test('yuanToFen：非法输入返回 NaN', () => {
  assert.ok(Number.isNaN(L.yuanToFen('0')));      // 单价必须 > 0
  assert.ok(Number.isNaN(L.yuanToFen('-1')));
  assert.ok(Number.isNaN(L.yuanToFen('abc')));
  assert.ok(Number.isNaN(L.yuanToFen('1.234'))); // 最多两位小数
  assert.ok(Number.isNaN(L.yuanToFen('')));
});

test('fenToYuan：格式化去零', () => {
  assert.equal(L.fenToYuan(100), '1');
  assert.equal(L.fenToYuan(50), '0.5');
  assert.equal(L.fenToYuan(105), '1.05');
  assert.equal(L.fenToYuan(2600), '26');
  assert.equal(L.fenToYuan(-450), '-4.5');
  assert.equal(L.fenToYuan(0), '0');
});

test('countedCards：普通与全关', () => {
  assert.equal(L.countedCards({ name: '李四', cardsLeft: 4, shutout: false }), 4);
  assert.equal(L.countedCards({ name: '戴六', cardsLeft: 10, shutout: true }), 20);
  assert.equal(L.countedCards({ name: '戴六', cardsLeft: 10, shutout: false }), 10); // 手动取消全关
});

test('roundTransfers：设计文档示例', () => {
  const round = {
    winner: '张三',
    losers: [
      { name: '李四', cardsLeft: 4, shutout: false },
      { name: '王五', cardsLeft: 2, shutout: false },
      { name: '戴六', cardsLeft: 10, shutout: true },
    ],
  };
  const ts = L.roundTransfers(round, 100);
  assert.deepEqual(ts, [
    { from: '李四', to: '张三', cards: 4, fen: 400 },
    { from: '王五', to: '张三', cards: 2, fen: 200 },
    { from: '戴六', to: '张三', cards: 20, fen: 2000 },
  ]);
  // 不变量：本局转账总额 = 赢家所得
  const total = ts.reduce((s, t) => s + t.fen, 0);
  assert.equal(total, 2600);
});

test('roundTransfers：剩 0 张的玩家不产生转账', () => {
  const round = {
    winner: '张三',
    losers: [
      { name: '李四', cardsLeft: 0, shutout: false },
      { name: '王五', cardsLeft: 3, shutout: false },
    ],
  };
  const ts = L.roundTransfers(round, 100);
  assert.deepEqual(ts, [{ from: '王五', to: '张三', cards: 3, fen: 300 }]);
});
