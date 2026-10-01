/*
 * net-protocol.js — オンライン実験（Online Phase 1）の通信メッセージ定義と検証
 *
 * ゲーム本体（Fighter / AI / 戦闘など）には一切触れません。DOM にも触れません。
 * 相手から届いたデータは必ず decode() を通し、
 *   - 文字列であること・大きさの上限
 *   - JSON として読めること・プレーンなオブジェクトであること
 *   - 既知の type（キー t）であること
 *   - 各値の型・範囲
 * を確認してから、必要な値だけをコピーした新しいオブジェクトを返します。想定外のものは null（破棄）。
 */
(function (KG) {
  'use strict';

  const APP_ID = 'kotaro-online-exp';   // 別アプリと誤接続していないかの確認用
  const PROTO_VERSION = 5;              // 通信の形式を変えたら上げる（違うと接続を断る）。2 = Phase 2（操作実験）/ 3 = Phase 3（予測）/ 4 = Phase 4（攻撃）/ 5 = Phase 5（攻撃の遅延補償）
  const MAX_MSG_CHARS = 1024;           // 1メッセージの上限（文字数）。最大の st（HOST 状態）でも 約 450 文字

  // ルームコード：表示用は「KOTA-3812」。PeerJS 上の ID はアプリ固有の長い接頭辞 + 4桁（他アプリと混ざらない）
  // 同じ4桁が使用中なら PeerJS サーバーが 'unavailable-id' を返すので、別の4桁で作り直す（ID の一意性はサーバーが保証）
  const CODE_LABEL = 'KOTA';
  const PEER_ID_PREFIX = 'kotaro-daikakuto-online-exp1-';
  const TEST_KEYS = ['LEFT', 'RIGHT', 'JUMP'];
  const REJECT_REASONS = ['full', 'version'];

  function randomCode() {
    const a = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return String(a[0] % 10000).padStart(4, '0');
  }
  const displayCode = (code) => CODE_LABEL + '-' + code;
  const peerIdFor = (code) => PEER_ID_PREFIX + code;

  // 入力欄の文字列 → 4桁のコード（読めなければ null）。全角数字・小文字・空白・ハイフン・「KOTA」の有無を許す
  function parseCode(text) {
    if (typeof text !== 'string' || text.length > 40) return null;
    let s = text.normalize ? text.normalize('NFKC') : text;
    s = s.toUpperCase().replace(/[\s\-_ー－‐]/g, '');
    if (s.startsWith(CODE_LABEL)) s = s.slice(CODE_LABEL.length);
    return /^\d{4}$/.test(s) ? s : null;
  }

  // ---- 値の検証 ----
  const isInt = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const BIG = 1e9;
  const TIME_MAX = 1e12; // performance.now() のミリ秒
  const POS_MAX = 1e5;   // 座標の範囲（ステージより十分広い）
  const VEL_MAX = 1e5;   // 速度の範囲
  const isBit = (v) => v === 0 || v === 1;
  const END_REASONS = ['user', 'timeout', 'error'];

  // type ごとの検証と「必要な値だけのコピー」
  const SCHEMA = {
    hello:   (m) => (m.app === APP_ID && isInt(m.v, 0, 1000)) ? { t: 'hello', app: m.app, v: m.v } : null,
    welcome: (m) => isInt(m.v, 0, 1000) ? { t: 'welcome', v: m.v } : null,
    reject:  (m) => REJECT_REASONS.includes(m.reason) ? { t: 'reject', reason: m.reason } : null,
    bye:     () => ({ t: 'bye' }),
    ping:    (m) => (isInt(m.i, 0, BIG) && isNum(m.ts, 0, TIME_MAX)) ? { t: 'ping', i: m.i, ts: m.ts } : null,
    // pong の ht（応答した側の時刻）は Phase 2 で追加。時計のずれの推定に使う（無くてもよい）
    pong:    (m) => (isInt(m.i, 0, BIG) && isNum(m.ts, 0, TIME_MAX) && (m.ht === undefined || isNum(m.ht, 0, TIME_MAX)))
      ? (m.ht === undefined ? { t: 'pong', i: m.i, ts: m.ts } : { t: 'pong', i: m.i, ts: m.ts, ht: m.ht }) : null,
    in:      (m) => TEST_KEYS.includes(m.k) ? { t: 'in', k: m.k } : null,
    // 連続通信テスト：bs=開始 / bp=パケット / ba=受信確認 / be=送信終了 / br=受信側の集計
    bs: (m) => (isInt(m.id, 1, BIG) && isInt(m.n, 1, 1000) && isInt(m.hz, 1, 120)) ? { t: 'bs', id: m.id, n: m.n, hz: m.hz } : null,
    bp: (m) => (isInt(m.id, 1, BIG) && isInt(m.s, 0, 999) && isNum(m.ts, 0, TIME_MAX) && isInt(m.b, 0, 255)) ? { t: 'bp', id: m.id, s: m.s, ts: m.ts, b: m.b } : null,
    ba: (m) => (isInt(m.id, 1, BIG) && isInt(m.s, 0, 999)) ? { t: 'ba', id: m.id, s: m.s } : null,
    be: (m) => (isInt(m.id, 1, BIG) && isInt(m.sent, 0, 1000)) ? { t: 'be', id: m.id, sent: m.sent } : null,
    br: (m) => (isInt(m.id, 1, BIG) && isInt(m.r, 0, 1000) && isInt(m.l, 0, 1000) && isInt(m.o, 0, 1000) && isInt(m.d, 0, 1000))
      ? { t: 'br', id: m.id, r: m.r, l: m.l, o: m.o, d: m.d } : null,

    // ---- Online Phase 2：操作実験 ----
    // ms = 開始（HOST→GUEST）/ mr = 準備完了（GUEST→HOST）/ me = 終了（どちらからでも）
    ms: (m) => isInt(m.id, 1, BIG) ? { t: 'ms', id: m.id } : null,
    mr: (m) => isInt(m.id, 1, BIG) ? { t: 'mr', id: m.id } : null,
    me: (m) => (isInt(m.id, 1, BIG) && END_REASONS.includes(m.r)) ? { t: 'me', id: m.id, r: m.r } : null,
    // mi = GUEST の入力状態：s=入力番号 / l・r・j=左・右・ジャンプを押しているか(0/1) / jp=ジャンプを押した回数の累計 / ts=送信時刻
    //      （座標や速度は受け付けない。入力だけ）
    //      ap=攻撃を押した回数の累計（Phase 4。押しっぱなしでは増えない）
    //      rs, rf（Phase 5。攻撃を押した入力だけ・省略可）= その瞬間に GUEST の画面がコタロの表示に使っていた HOST 状態の番号と、
    //      次の状態までの割合（×1000。新しい状態が遅れて先へ伸ばしている時は 1000 を超える。最大 3000）。座標は送らない
    mi: (m) => {
      if (!(isInt(m.s, 1, BIG) && isBit(m.l) && isBit(m.r) && isBit(m.j) && isInt(m.jp, 0, BIG) && isInt(m.ap, 0, BIG) && isNum(m.ts, 0, TIME_MAX))) return null;
      const out = { t: 'mi', s: m.s, l: m.l, r: m.r, j: m.j, jp: m.jp, ap: m.ap, ts: m.ts };
      if (m.rs !== undefined || m.rf !== undefined) {
        if (!(isInt(m.rs, 1, BIG) && isInt(m.rf, 0, 3000))) return null;
        out.rs = m.rs; out.rf = m.rf;
      }
      return out;
    },
    // mh = HOST で命中（Phase 4）：id=命中番号 / a=攻撃した側(0=コタロ,1=ルミポ) / k=攻撃 ID / d=当たった側のダメージ（反映後）/ x,y=当たった位置 / w=HOST の時刻
    mh: (m) => (isInt(m.id, 1, BIG) && isBit(m.a) && isInt(m.k, 0, BIG) && isNum(m.d, 0, 999) && isNum(m.x, -POS_MAX, POS_MAX) && isNum(m.y, -POS_MAX, POS_MAX) && isNum(m.w, 0, TIME_MAX))
      ? { t: 'mh', id: m.id, a: m.a, k: m.k, d: m.d, x: m.x, y: m.y, w: m.w } : null,
    // ma = GUEST の攻撃の HOST での結果（診断用）：k=攻撃 ID / h=HIT か / v=位置を測れたか / kx,rx=判定が出た瞬間のコタロ・ルミポの x
    //      Phase 5：c=現在位置で判定した場合に当たっていたか / rw=参照した過去（ms）/ pk=遅延補償で参照したコタロの x
    ma: (m) => (isInt(m.k, 1, BIG) && isBit(m.h) && isBit(m.v) && isNum(m.kx, -POS_MAX, POS_MAX) && isNum(m.rx, -POS_MAX, POS_MAX) &&
        isBit(m.c) && isInt(m.rw, 0, 1000) && isNum(m.pk, -POS_MAX, POS_MAX))
      ? { t: 'ma', k: m.k, h: m.h, v: m.v, kx: m.kx, rx: m.rx, c: m.c, rw: m.rw, pk: m.pk } : null,
    // st = HOST のゲーム状態：s=状態番号 / h=HOST のゲーム内時刻(ms) / w=送信時刻 / a=適用済みの最新入力番号
    //      f=[コタロ, ルミポ] それぞれ [x, y, vx, vy, 向き(±1), フラグ, 無敵の残り秒]
    st: (m) => {
      if (!(isInt(m.s, 1, BIG) && isNum(m.h, 0, TIME_MAX) && isNum(m.w, 0, TIME_MAX) && isInt(m.a, 0, BIG))) return null;
      if (!Array.isArray(m.f) || m.f.length !== 2) return null;
      const f = [];
      for (const e of m.f) {
        if (!Array.isArray(e) || e.length !== 10) return null;
        if (!(isNum(e[0], -POS_MAX, POS_MAX) && isNum(e[1], -POS_MAX, POS_MAX) && isNum(e[2], -VEL_MAX, VEL_MAX) && isNum(e[3], -VEL_MAX, VEL_MAX))) return null;
        if (!(e[4] === 1 || e[4] === -1) || !isInt(e[5], 0, 255) || !isNum(e[6], 0, 60)) return null;
        // Phase 4：[7] ダメージ / [8] 技のフレーム（-1 = なし）/ [9] 傾き
        if (!isNum(e[7], 0, 999) || !isInt(e[8], -1, 120) || !isNum(e[9], -1000, 1000)) return null;
        f.push(e.slice(0, 10));
      }
      // p（Phase 3）= ルミポの移動に関わる値 [x, y, vx, vy, 向き, 接地, 空中ジャンプ残り, コヨーテ残り, ジャンプ先行入力残り, 技中のジャンプ保留, 小ジャンプ可, 吹っ飛び中]
      const p = m.p;
      if (!Array.isArray(p) || p.length !== 19) return null;
      if (!(isNum(p[0], -POS_MAX, POS_MAX) && isNum(p[1], -POS_MAX, POS_MAX) && isNum(p[2], -VEL_MAX, VEL_MAX) && isNum(p[3], -VEL_MAX, VEL_MAX))) return null;
      if (!(p[4] === 1 || p[4] === -1) || !isBit(p[5]) || !isInt(p[6], 0, 10) || !isNum(p[7], 0, 10) || !isNum(p[8], 0, 10)) return null;
      if (!isBit(p[9]) || !isBit(p[10]) || !isBit(p[11])) return null;
      // Phase 4：[12] 技のフレーム / [13] 攻撃の先行入力残り / [14] ヒットストップ / [15] 被弾硬直 / [16] 傾き / [17] 攻撃 ID / [18] 最後の攻撃押下の番号
      if (!isInt(p[12], -1, 120) || !isNum(p[13], 0, 10) || !isInt(p[14], 0, 120) || !isInt(p[15], 0, 1000) || !isNum(p[16], -1000, 1000)) return null;
      if (!isInt(p[17], 0, BIG) || !isInt(p[18], 0, BIG)) return null;
      return { t: 'st', s: m.s, h: m.h, w: m.w, a: m.a, f, p: p.slice() };
    },
  };

  // 受信データ → 検証済みメッセージ。{ msg, reason } を返す（msg が null なら破棄。reason はログ用）
  function decode(raw) {
    if (typeof raw !== 'string') return { msg: null, reason: 'not-string' };
    if (raw.length > MAX_MSG_CHARS) return { msg: null, reason: 'too-large(' + raw.length + ')' };
    let m;
    try { m = JSON.parse(raw); } catch (_) { return { msg: null, reason: 'bad-json' }; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { msg: null, reason: 'not-object' };
    if (Object.keys(m).length > 10) return { msg: null, reason: 'too-many-keys' };
    const t = m.t;
    if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMA, t)) return { msg: null, reason: 'unknown-type' };
    const out = SCHEMA[t](m);
    return out ? { msg: out, reason: null } : { msg: null, reason: 'bad-fields(' + t + ')' };
  }

  function encode(msg) { return JSON.stringify(msg); }

  // UTF-8 のバイト数（通信量の概算用）
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const byteLength = (s) => enc ? enc.encode(s).length : s.length;

  KG.NetProtocol = {
    APP_ID, PROTO_VERSION, MAX_MSG_CHARS, CODE_LABEL, PEER_ID_PREFIX, TEST_KEYS,
    randomCode, displayCode, peerIdFor, parseCode, decode, encode, byteLength,
  };
})(window.KG = window.KG || {});
