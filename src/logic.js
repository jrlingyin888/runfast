// 跑得快结算纯函数。金额一律以"分"（整数）计算。
// 浏览器：全局 RunfastLogic；Node：module.exports（供测试）。
var RunfastLogic = (function () {
  'use strict';

  const HAND_SIZE = 10;
  const SHUTOUT_MULTIPLIER = 2;

  // 元字符串 -> 分。非法（非数字/超两位小数/<=0）返回 NaN。
  function yuanToFen(str) {
    if (typeof str !== 'string' || !/^\d+(\.\d{1,2})?$/.test(str.trim())) return NaN;
    const fen = Math.round(parseFloat(str) * 100);
    return fen > 0 ? fen : NaN;
  }

  // 分 -> 元字符串，去多余的零：100->'1'，50->'0.5'，105->'1.05'
  function fenToYuan(fen) {
    const sign = fen < 0 ? '-' : '';
    const abs = Math.abs(fen);
    const yuan = Math.floor(abs / 100);
    const rest = abs % 100;
    if (rest === 0) return sign + yuan;
    let dec = (rest < 10 ? '0' : '') + rest;
    if (dec[1] === '0') dec = dec[0];
    return sign + yuan + '.' + dec;
  }

  // 输家本局实际计的牌数（全关双倍）
  function countedCards(loser) {
    return loser.shutout ? loser.cardsLeft * SHUTOUT_MULTIPLIER : loser.cardsLeft;
  }

  // 一局的转账明细（剩 0 张不计）
  function roundTransfers(round, priceFen) {
    return round.losers
      .filter((l) => l.cardsLeft > 0)
      .map((l) => {
        const cards = countedCards(l);
        return { from: l.name, to: round.winner, cards, fen: cards * priceFen };
      });
  }

  const api = { HAND_SIZE, yuanToFen, fenToYuan, countedCards, roundTransfers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
