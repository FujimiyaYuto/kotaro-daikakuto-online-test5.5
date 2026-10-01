/*
 * online-move.js — Online Phase 2：遠隔プレイヤーによるキャラクター操作実験
 *                  Online Phase 3：GUEST 側 Client-side Prediction（ルミポの移動だけ）
 *                  Online Phase 4：通常攻撃「ぽよんアタック」1 種類だけのオンライン同期（HOST が判定）
 *                  Online Phase 5：GUEST の攻撃の遅延補償（Lag Compensation。HOST が自分の履歴で判定）
 *
 *   HOST  … コタロ = HOST 本人の通常操作 / ルミポ = GUEST から届いた「入力」で、既存の Fighter 物理をそのまま使って動かす
 *   GUEST … 自分ではゲームを進めない。HOST から届いた状態（位置・向きなど）を少し遅らせて補間表示するだけ（予測なし）
 *
 * HOST authoritative：正しいゲーム状態は HOST だけが決める。GUEST から受け取るのは左・右・ジャンプの入力だけ。
 *
 * ゲーム本体のファイルは変更しない。操作実験の間だけ、外から次のように差し替え、終了時に元へ戻す：
 *   - ルミポの controller（CpuController）→ RemoteInputController（GUEST の入力）       ※ CPU 対戦の AI には触れない
 *   - コタロの controller（InputManager）→ 移動・ジャンプだけを通すフィルター（攻撃・必殺・泡・ガードは無効）
 *   - ストックを Infinity（場外に落ちても既存ルールで復帰するだけ。勝敗は発生しない）
 *   - game.step（このインスタンスだけ）：HOST は「元の step → 状態送信」、GUEST は「入力送信 → 予測 → 表示 → カメラ」
 *
 * Phase 3（予測）の考え方：
 *   - GUEST は固定ステップ（60 回/秒）ごとに 1 件の入力（番号つき）を HOST へ送る。
 *   - HOST は届いた入力を順番に 1 ステップ 1 件ずつ、既存の Fighter.update() でルミポに適用する（HOST が正解）。
 *     HOST 状態には「どの入力番号まで適用したか（a）」と、ルミポの移動に関わる全ての値（p）を載せる。
 *   - GUEST は同じ入力を、自分の画面用の別の Fighter（同じクラス・同じ移動値・同じステージ）に即座に適用して表示する（予測）。
 *   - HOST 状態が届いたら、予測用 Fighter を HOST の値に置き換え、まだ HOST が適用していない入力（番号 > a）を
 *     もう一度順番に適用し直して「今の予測」を作り直す（reconciliation）。
 *   - 作り直す前と後の差（予測誤差）は、画面の表示位置だけに足して数フレームで消す。大きすぎる時は HOST 状態へ即座に合わせる。
 *   - GUEST から HOST へ送るのは今までどおり入力だけ。予測した位置を HOST が使うことはない。
 *
 * Phase 4（攻撃）の考え方：
 *   - 攻撃も「押した瞬間の回数（ap）」として入力に含めるだけ。攻撃を出せるか・当たったか・ダメージ・吹っ飛びはすべて HOST の既存処理
 *     （Fighter の技処理・Combat.resolve・Knockback）が決める。GUEST は命中を一切判定しない。
 *   - 操作実験の間だけ、両者の通常攻撃を既存の「ぽよんアタック」に揃える（ルミポの技選択をこのインスタンスだけ差し替え。技データは変更しない）。
 *   - 攻撃 ID = その攻撃のもとになった「攻撃を押した入力の番号」。HOST と GUEST の予測で同じ規則で決まるので照合できる。
 *   - GUEST は押した瞬間に予測用ルミポで攻撃を開始して見せる（見た目だけ。当たり判定はしない）。
 *   - HOST で命中したら、命中イベント（mh）と、ダメージ・吹っ飛び後の状態を送る。GUEST は HOST の状態をそのまま使う。
 *
 * Phase 5（遅延補償）の考え方：
 *   - HOST は毎ステップ、コタロの Hurtbox を作るのに必要な値（x, y, 向き, 場にいるか）だけを短いリングバッファに残す。
 *     送った状態の番号 → HOST のステップ番号 の対応も残す。
 *   - GUEST は攻撃を押した入力に「その瞬間、画面のコタロの表示に使っていた HOST 状態の番号と、次の状態までの割合」だけを付ける（座標は送らない）。
 *   - HOST はその番号が本当に自分が送ったものか・未来でないか・古すぎないかを確かめ、「今 − 参照時刻」（巻き戻し量）を上限つきで決める。
 *   - ルミポのぽよんアタックの判定が出ている間だけ、コタロの Hurtbox を「巻き戻し量だけ前の位置」で作って既存の Combat.resolve に渡す。
 *     ゲーム世界（コタロの本当の位置）は巻き戻さない。命中したらダメージ・吹っ飛びは今の HOST の状態に既存処理で適用。
 *   - HOST の攻撃（コタロ → ルミポ）には遅延補償を使わない。
 */
(function (KG) {
  'use strict';

  const CFG = {
    stateEverySteps: 2,       // HOST → GUEST 状態送信：ゲームの固定ステップ（60/秒）の 2 回に 1 回 = 30Hz
    inputTimeoutMs: 500,      // HOST：これ以上新しい入力が届かなければルミポの入力をニュートラルへ
    maxInputsPerSec: 150,     // HOST：1 秒あたりこれを超える入力メッセージは無視（通常は 60。タブ復帰時のまとめ送りに余裕）
    // ---- Phase 3：HOST の入力キュー ----
    hostQueueTarget: 3,       // HOST：未適用の入力がこれより多い時は 1 ステップで 2 件適用して追いつく（HOST 側の遅れを 約 50ms までに）
    hostQueueMax: 30,
    hostDrainTicks: 30,       // HOST：未適用が 2 件以上のまま この ステップ数 続いたら 1 件追いつく（Phase 4）         // HOST：未適用の入力の上限（あふれた分は古い順に捨てる）
    // ---- Phase 3：GUEST の予測と補正（単位はゲーム内の座標。ルミポの幅 70、地上の最高速度 340/秒 = 1 ステップ 約 5.7）----
    maxPending: 180,          // GUEST：未確認入力の上限（3 秒分）。超えたら古い順に捨てる
    errIgnore: 0.5,           // これ未満の誤差は「補正」として数えない（表示上は見えない大きさ。同じ方法で静かに吸収）
    errSmall: 24,             // 〜これ：小さい誤差（約 4 ステップ分の移動）→ ゆっくり（時定数 80ms）吸収
    errSnap: 120,             // 〜これ：大きい誤差 → 速め（時定数 40ms）に吸収 / これ以上：HOST 状態へ即座に合わせる（snap）
    tauSmallMs: 80,
    tauLargeMs: 40,
    // ---- Phase 4：攻撃 ----
    attackRejectTicks: 8,     // HOST：攻撃の押下から この ステップ数 以内に攻撃が始まらなければ「出せなかった」扱い（先行入力 0.1 秒 + 余裕）
    hitTauMs: 30,             // GUEST：被弾・命中による差は速め（30ms）に吸収（HOST の被弾結果を優先）
    hitSnap: 300,             // GUEST：被弾・命中による差がこれ以上なら即座に HOST へ
    attackResultTimeoutMs: 1500, // GUEST：予測した攻撃に HOST の結果がこの時間来なければ「HOST で出なかった」と数える
    // ---- Phase 5：遅延補償 ----
    lagMaxMs: 200,            // HOST：巻き戻しの上限（ms）。人工遅延テストの結果から決めた値（docs/ONLINE_PHASE5.md）。URL の ?lagmax= で実験用に変更可（0〜300）
    histTicks: 36,            // HOST：コタロの履歴を残すステップ数（36 = 600ms。上限 200ms + 余裕）
    sentStates: 40,           // HOST：送った状態の番号 → ステップ番号 を残す数（40 件 = 約 1.3 秒）
    interpDelayMs: 70,        // GUEST：表示補間の遅れ（30Hz の状態 約 2 回分）
    maxExtrapolateMs: 100,    // GUEST：新しい状態が遅れた時に速度で先へ伸ばす上限
    snapDistance: 400,        // GUEST：これ以上離れた 2 つの状態の間は補間せず切り替える（リスポーンなど）
    startAckTimeoutMs: 4000,  // HOST：開始の合図に GUEST が応えるまでの上限
    stateStallMs: 1000,       // GUEST：HOST の状態がこれ以上届かなければ警告表示
    stickThreshold: 0.3,      // GUEST：スティック／キーの倒し量をオン・オフに変える境目
  };
  const STATES = ['idle', 'run', 'jump', 'fall', 'attack', 'hurt'];
  const BLOCKED_ACTIONS = ['special', 'shoot', 'guard'];   // Phase 4：通常攻撃（attack）だけ通す
  const POYON = () => KG.MOVES.poyonAttack;
  // 操作実験中だけ使う技選択：通常攻撃 = ぽよんアタック、それ以外の技は出ない（既存の技データ・Fighter はそのまま）
  function poyonOnlySelectMove(kind) { return (kind || 'Neutral') === 'Neutral' ? POYON() : null; }
  const NO_VICTIMS = new Set();
  function overlapAny(hbs, rects) {
    if (!rects) return false;
    for (const hb of hbs) for (const r of rects) if (KG.util.rectsOverlap(hb.rect, r)) return true;
    return false;
  }
  // 攻撃判定と Hurtbox の横の距離（重なっていれば 0）。「どれだけ逃げていたか」の目安
  function gapBetween(hbs, rects) {
    let best = Infinity;
    for (const hb of hbs) for (const r of rects) {
      const a = hb.rect;
      const dx = Math.max(0, Math.max(a.x, r.x) - Math.min(a.x + a.w, r.x + r.w));
      const dy = Math.max(0, Math.max(a.y, r.y) - Math.min(a.y + a.h, r.y + r.h));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best === Infinity ? 0 : best;
  }
  const now = () => performance.now();
  const r1 = (v) => Math.round(v * 10) / 10;
  const lerp = (a, b, k) => a + (b - a) * k;

  // 直近 1 秒間の回数から Hz を出す
  class RateMeter {
    constructor() { this.n = 0; this.t0 = now(); this.hz = 0; }
    hit() { this.n++; this.roll(); }
    roll() {
      const t = now(), d = t - this.t0;
      if (d >= 1000) { this.hz = (this.n * 1000) / d; this.n = 0; this.t0 = t; }
    }
    get value() { this.roll(); return this.hz; }
  }
  // 平均（指数移動平均）と最大
  class Stat {
    constructor() { this.avg = null; this.last = null; this.max = null; this.n = 0; }
    add(v) { this.last = v; this.n++; this.avg = this.avg == null ? v : this.avg + (v - this.avg) * 0.1; this.max = this.max == null ? v : Math.max(this.max, v); }
  }
  // 単純平均と中央値（件数が少ない診断用。直近 500 件）
  class Samples {
    constructor() { this.v = []; }
    add(x) { this.v.push(x); if (this.v.length > 500) this.v.shift(); }
    get n() { return this.v.length; }
    get mean() { return this.v.length ? this.v.reduce((a, b) => a + b, 0) / this.v.length : null; }
    get median() { if (!this.v.length) return null; const s = this.v.slice().sort((a, b) => a - b); return s[s.length >> 1]; }
    get max() { return this.v.length ? Math.max.apply(null, this.v) : null; }
  }

  // ---------------- HOST：ルミポを GUEST の入力で動かす controller ----------------
  // 既存の CpuController と同じ「1 ステップに 1 回 poll() でコマンドを返す」形。Fighter 側は入力元を区別しない。
  // Phase 3：届いた入力（GUEST の 1 ステップ分ずつ）を順番に並べ、HOST の 1 ステップに 1 件ずつ適用する。
  //   GUEST が予測で行う計算と同じ順番・同じ入力になるので、通常は予測とぴったり一致する。
  class RemoteInputController {
    constructor(fighter, stage) { this.isAI = false; this.fighter = fighter; this.stage = stage; this.resetAll(); }
    resetAll() {
      this.queue = [];                 // 届いたがまだ適用していない入力
      this.lastSeq = 0;                // 受信済みの最新番号
      this.lastJp = 0;
      this.lastApplied = 0;            // 適用済みの最新番号（HOST 状態に「a」として載せる）
      this.last = { mx: 0, hj: 0 };    // 最後に適用した入力（次が届くまではこれを続ける）
      this.lastAt = 0; this.neutral = true;
      this.dupTicks = 0; this.catchUps = 0; this.overflow = 0;
      this.lastAp = 0;
      this.lastPressSeq = 0;           // 最後に適用した「攻撃を押した」入力の番号（攻撃 ID の元）
      this.presses = [];               // 適用した攻撃押下 { s, ts }（攻撃が始まったか・出せなかったかの集計用）
      this.tick = 0;
    }
    reset() { /* game.resetTest() から呼ばれる。受信状態は保持（開始時に resetAll 済み） */ }
    // 検証済みの入力メッセージを受け付ける。古い・重複・逆順の番号は捨てる（操作状態が巻き戻らない）
    accept(msg, t) {
      if (msg.s <= this.lastSeq) return 'stale';
      if (msg.jp < this.lastJp || msg.ap < this.lastAp) return 'bad';   // ジャンプ・攻撃の回数は減らない
      const pj = msg.jp > this.lastJp ? 1 : 0;           // 押した瞬間（GUEST の 1 ステップで押せるのは 1 回）
      const pa = msg.ap > this.lastAp ? 1 : 0;           // 攻撃を押した瞬間（同上。押しっぱなしでは増えない）
      this.lastSeq = msg.s; this.lastJp = msg.jp; this.lastAp = msg.ap; this.lastAt = t; this.neutral = false;
      this.queue.push({ s: msg.s, mx: (msg.r ? 1 : 0) - (msg.l ? 1 : 0), hj: msg.j, pj, pa, ts: msg.ts, rs: pa ? msg.rs : undefined, rf: pa ? msg.rf : undefined });
      if (this.queue.length > CFG.hostQueueMax) {        // あふれたら古い入力を捨てる（押した瞬間は次へ持ち越す）
        const d = this.queue.shift();
        this.overflow++;
        this.lastApplied = d.s;
        if (d.pj) this.queue[0].pj = 1;
        if (d.pa) this.queue[0].pa = 1;
      }
      return 'ok';
    }
    setNeutral() { this.queue.length = 0; this.last = { mx: 0, hj: 0 }; this.neutral = true; }
    toCmd(c) {
      const cmd = KG.createEmptyCommand();
      cmd.moveX = c.mx;                 // 左右同時は GUEST 側で片方に決まっている（-1 / 0 / 1）
      cmd.held.jump = !!c.hj;
      cmd.pressed.jump = !!c.pj;        // 押した瞬間 = その 1 ステップだけ
      cmd.pressed.attack = !!c.pa;      // 攻撃も押した瞬間だけ（出せるかどうかは既存の Fighter の規則）
      return cmd;
    }
    // 入力を 1 件適用する直前の記録（攻撃押下の番号）
    noteApplied(c) {
      this.lastApplied = c.s; this.last = c;
      // 攻撃押下：Phase 5 の巻き戻し量はこの瞬間（HOST が押下を適用した時）に決める
      if (c.pa) { this.lastPressSeq = c.s; this.presses.push({ s: c.s, ts: c.ts, tick: this.tick, lag: this.onPress ? this.onPress(c) : null }); }
    }
    poll() {
      const q = this.queue;
      if (!q.length) {
        // 次の入力がまだ届いていない：直前の入力（押しっぱなしの状態）を続ける。押した瞬間は繰り返さない
        if (!this.neutral) this.dupTicks++;
        return this.toCmd({ mx: this.last.mx, hj: this.last.hj, pj: 0, pa: 0 });
      }
      // 未適用がたまっている（通信が一時的に詰まって、まとめて届いた）：このステップで 1 件余分に適用して追いつく
      const f = this.fighter;
      // 未適用が 2 件以上の状態が 0.5 秒続いた時も 1 件追いつく（通信の揺れでたまった分を少しずつ減らし、HOST での反映の遅れを小さく保つ）
      this.standing = q.length > 1 ? (this.standing || 0) + 1 : 0;
      const drain = this.standing >= CFG.hostDrainTicks;
      if ((q.length > CFG.hostQueueTarget || drain) && f.status && f.status.isAlive) {
        this.standing = 0;
        const extra = q.shift();
        this.noteApplied(extra);
        f.update(KG.CONFIG.fixedStep, this.toCmd(extra), this.stage);   // 既存の物理をそのまま 1 回分
        f.fxEvents.length = 0; f.spawnEvents.length = 0;
        if (f.action && !f.action.aid) f.action.aid = this.lastPressSeq;
        this.catchUps++;
      }
      const c = q.shift();
      this.noteApplied(c);
      return this.toCmd(c);
    }
  }

  // ルミポの移動に関わる値（予測の作り直しに必要なものすべて）。HOST はそのまま（丸めずに）送る
  // Phase 4 で技・被弾の値を追加：[12] 技のフレーム（-1 = 技なし）/ [13] 攻撃の先行入力残り / [14] ヒットストップ残り /
  //   [15] 被弾硬直残り / [16] 傾き / [17] 今の技の攻撃 ID / [18] 最後に適用した攻撃押下の番号
  function getLogic(f) {
    const a = f.action;
    return [f.x, f.y, f.vx, f.vy, f.facing < 0 ? -1 : 1, f.grounded ? 1 : 0, f.airJumpsLeft,
      f.coyoteTimer, f.jumpBufferTimer, f.jumpQueuedDuringAction ? 1 : 0, f.canCutJump ? 1 : 0, f.launched ? 1 : 0,
      a ? a.frame : -1, f.attackBufferTimer, f.hitstop, f.hitstun, f.angle, a ? (a.aid || 0) : 0, f.lastPressSeq || 0];
  }
  function setLogic(f, p) {
    f.x = p[0]; f.y = p[1]; f.vx = p[2]; f.vy = p[3]; f.facing = p[4]; f.grounded = !!p[5];
    f.airJumpsLeft = p[6]; f.coyoteTimer = p[7]; f.jumpBufferTimer = p[8];
    f.jumpQueuedDuringAction = !!p[9]; f.canCutJump = !!p[10]; f.launched = !!p[11];
    f.ground = null; f.guardState = 'none';
    f.action = p[12] >= 0 ? { move: POYON(), frame: p[12], hitVictims: new Set(), aid: p[17] } : null;
    f.attackBufferTimer = p[13]; f.hitstop = p[14]; f.hitstun = p[15]; f.angle = f.prevAngle = p[16];
    f.lastPressSeq = p[18];
  }
  // 予測・作り直しで入力 1 件を適用する（HOST の RemoteInputController と同じ規則で攻撃 ID を付ける）
  function applyCmd(f, c, stage) {
    if (c.pa) f.lastPressSeq = c.s;
    const had = f.action;
    f.update(KG.CONFIG.fixedStep, RemoteInputController.prototype.toCmd(c), stage);
    f.fxEvents.length = 0; f.spawnEvents.length = 0;
    if (f.action && !f.action.aid) f.action.aid = f.lastPressSeq;
    return f.action && f.action !== had ? f.action : null;   // このステップで新しく始まった技
  }

  // ---------------- HOST：コタロ（本人の操作）から攻撃系の入力だけを外すフィルター ----------------
  class MoveOnlyController {
    constructor(input) { this.input = input; this.isAI = false; }
    reset() {}
    poll() {
      const cmd = this.input.poll();
      for (const a of BLOCKED_ACTIONS) { cmd.held[a] = false; cmd.pressed[a] = false; }
      return cmd;
    }
  }
  const idleController = { isAI: false, reset() {}, poll() { return KG.createEmptyCommand(); } };

  class OnlineMoveTest {
    constructor(session, hooks) {
      this.session = session;
      this.hooks = hooks || {};
      this.active = false;
      this.starting = null;
      this.role = null;
      this.testId = 0;
      this.timers = [];
      // Phase 3：GUEST の予測 ON / OFF（A/B 比較用）。URL に ?pred=off で最初から OFF
      const qs = new URLSearchParams(location.search);
      this.predEnabled = qs.get('pred') !== 'off';
      // Phase 5：HOST の遅延補償 ON / OFF（A/B 比較用）。URL に ?lagcomp=off で最初から OFF、?lagmax=150 などで上限を変更（実験用）
      this.lagEnabled = qs.get('lagcomp') !== 'off';
      const lm = Number(qs.get('lagmax'));
      if (qs.has('lagmax') && Number.isFinite(lm)) CFG.lagMaxMs = Math.max(0, Math.min(300, lm));
      this.buildDom();
      // P キー：予測 ON / OFF（GUEST・実験中のみ）
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyP' && !e.repeat && this.active && this.role === 'GUEST') { e.preventDefault(); this.setPrediction(!this.predEnabled); }
        if (e.code === 'KeyC' && !e.repeat && this.active && this.role === 'HOST') { e.preventDefault(); this.setLagComp(!this.lagEnabled); }   // Phase 5
      });
      session.on('game', (m) => this.onMsg(m));
      session.on('state', (st) => { if (st !== 'connected' && (this.active || this.starting)) this.stop('disconnect'); });
    }

    log(t, lv) { this.session.log('[MOVE] ' + t, lv); }

    // ---------------- 開始・終了 ----------------
    // HOST が「操作実験を開始」を押した：GUEST へ開始を伝え、準備完了の返事を待ってから両方で開始
    requestStart() {
      const s = this.session;
      if (s.role !== 'HOST' || s.state !== 'connected' || this.active || this.starting) return false;
      const rnd = new Uint32Array(1);
      crypto.getRandomValues(rnd);                    // Math.random は使わない（CPU 対戦の乱数に一切影響させない）
      const id = (rnd[0] % 999999) + 1;
      this.starting = { id, t: now() };
      s.sendGame({ t: 'ms', id });
      this.log('start requested (id ' + id + ') → waiting for GUEST');
      const st = this.starting;
      this.timers.push(setTimeout(() => {
        if (this.starting !== st) return;
        this.starting = null;
        s.sendGame({ t: 'me', id, r: 'timeout' });
        this.log('GUEST did not answer the start request', 'warn');
        if (this.hooks.onStartFailed) this.hooks.onStartFailed('timeout');
      }, CFG.startAckTimeoutMs));
      if (this.hooks.onStarting) this.hooks.onStarting();
      return true;
    }

    // 自分から終了（「操作実験を終了」ボタン）
    end() {
      if (!this.active && !this.starting) return;
      const id = this.active ? this.testId : this.starting.id;
      this.session.sendGame({ t: 'me', id, r: 'user' });
      this.stop('user');
    }

    begin(role, id) {
      const g = KG.game;
      if (!g || this.active) return false;
      this.active = true;
      this.role = role;
      this.testId = id;
      this.resetStats();
      this.saved = {
        pCtl: g.player.controller, cCtl: g.cpu.controller,
        pStocks: g.player.status.initialStocks, cStocks: g.cpu.status.initialStocks,
      };
      // 勝敗・ストックは扱わない：落ちても既存ルールで復帰するだけ
      g.player.status.initialStocks = Infinity;
      g.cpu.status.initialStocks = Infinity;
      if (role === 'HOST') {
        this.remote = new RemoteInputController(g.cpu, g.stage);
        this.remote.onPress = (c) => this.computeRewind(c);
        g.cpu.controller = this.remote;                       // ルミポ：CPU AI を止め、GUEST の入力で動かす
        g.player.controller = new MoveOnlyController(g.input); // コタロ：本人の操作（攻撃系は無効）
      } else {
        this.remote = null;
        g.player.controller = idleController;                 // GUEST は自分でゲームを進めない
        g.cpu.controller = idleController;
      }
      // Phase 4：両者の通常攻撃をぽよんアタックに揃える（このインスタンスだけ。終了時に削除して元に戻す）
      g.player.selectMove = poyonOnlySelectMove;
      g.cpu.selectMove = poyonOnlySelectMove;
      if (role === 'HOST') {
        // 命中の記録：既存の receiveHit を呼んだ後に、命中イベントを GUEST へ送る（ダメージ・吹っ飛びは既存処理のまま）
        for (const victim of [g.player, g.cpu]) {
          const orig = KG.Fighter.prototype.receiveHit;
          victim.receiveHit = (hit) => { orig.call(victim, hit); this.onHostHit(victim, hit); };
        }
        // Phase 5：コタロの Hurtbox（このインスタンスだけ）。ルミポのぽよんアタックの判定が出ている間だけ、遅延補償の過去位置で作る
        const self = this;
        g.player.getHurtboxes = function () { return self.lagHurtboxes() || KG.Fighter.prototype.getHurtboxes.call(this); };
        // Phase 5：診断表示中だけ、今と過去の Hurtbox を重ねて描く
        g.render = (alpha) => { KG.Game.prototype.render.call(g, alpha); this.drawLagViz(alpha); };
      }
      g.startMatch();
      if (role === 'GUEST') {
        // 予測用のルミポ（画面には出さない「計算用」）。同じ Fighter クラス・同じキャラ定義（移動値）・同じステージで動かす
        this.pred = new KG.Fighter(g.cpu.def, { id: 'prediction', status: new KG.CombatStatus({ stocks: Infinity }) });
        this.pred.selectMove = poyonOnlySelectMove;
        setLogic(this.pred, getLogic(g.cpu));               // 開始位置は HOST と同じ（startMatch で同じ出現位置）
        this.pred.state = g.cpu.state;
      }
      // カウントダウンは使わない（正式な試合ではない）。すぐに移動できる状態にする
      g.phase = 'fight';
      g.phaseTime = KG.CONFIG.match.startShow + 0.05;
      this.clearInput();
      const step0 = KG.Game.prototype.step;
      g.step = role === 'HOST'
        ? (dt) => { step0.call(g, dt); this.afterHostStep(dt); }
        : (dt) => this.guestStep(dt);
      document.body.dataset.onlineTest = role.toLowerCase();
      this.hud.hidden = false;
      this.$.role.textContent = role === 'HOST' ? 'HOST：コタロを操作中（ルミポ = GUEST）' : 'GUEST：ルミポを操作中';
      this.hud.dataset.role = role.toLowerCase();
      this.renderPredBtn();
      this.diagTimer = setInterval(() => this.renderDiag(), 250);
      this.renderDiag();
      this.log('move test started as ' + role + ' (id ' + id + ')');
      if (this.hooks.onStart) this.hooks.onStart(role);
      return true;
    }

    // 終了・切断：ゲームを止め、差し替えたものをすべて元に戻してタイトル状態へ
    stop(reason) {
      if (!this.active && !this.starting) return;
      const wasActive = this.active;
      this.starting = null;
      this.active = false;
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
      clearInterval(this.diagTimer);
      const g = KG.game;
      if (wasActive && g) {
        if (this.remote) this.remote.setNeutral();        // 入力をニュートラルへ
        delete g.step;                                    // 元の Game.prototype.step に戻す
        for (const f of [g.player, g.cpu]) { delete f.selectMove; delete f.receiveHit; delete f.lastPressSeq; delete f.getHurtboxes; }  // 差し替えを削除
        delete g.render;
        g.player.controller = this.saved.pCtl;
        g.cpu.controller = this.saved.cCtl;               // CPU AI を元のまま戻す
        g.player.status.initialStocks = this.saved.pStocks;
        g.cpu.status.initialStocks = this.saved.cStocks;
        g.goToTitle();                                    // 位置・ストック・AI などをすべて初期化
        this.padReset();
        this.clearInput();
        delete document.body.dataset.onlineTest;
        this.hud.hidden = true;
        this.log('move test stopped (' + reason + ')');
      }
      this.remote = null;
      this.pred = null;                                   // 予測も止める（切断後にルミポを動かし続けない）
      if (this.hooks.onStop) this.hooks.onStop(reason, wasActive);
    }

    clearInput() {
      const g = KG.game;
      try { g.keyboard.reset(); g.input.releaseAll(); g.input.poll(); } catch (_) { /* noop */ }
      if (this.hooks.clearTouch) this.hooks.clearTouch();
    }

    resetStats() {
      this.st = {
        stepCount: 0, stateSeq: 0, inputSeq: 0, jp: 0,
        cur: { l: 0, r: 0, j: 0, jp: 0 }, lastInputSentAt: 0, sentTimes: new Map(),
        inputRate: new RateMeter(), stateRate: new RateMeter(), inRateWindow: 0, inRateCount: 0,
        staleInputs: 0, badInputs: 0, floodDropped: 0, neutralCount: 0, staleStates: 0,
        lastInputSeqRecv: 0, lastStateSeqRecv: 0, lastStateAt: 0, lastAcked: 0,
        inputDelay: new Stat(), stateDelay: new Stat(), reflect: new Stat(),
        snaps: [], tOff: null, extrapolating: false, extrapCount: 0, waitingFirstState: true,
        // Phase 3：予測
        pending: [], predErr: new Stat(), lastErrX: 0, lastErrY: 0, corrections: 0, snapCount: 0, reconciles: 0, nonZeroErr: 0,
        vis: { x: 0, y: 0 }, blend: false, predHidden: false, hostAlive: true, lastInv: 0, pendingDropped: 0, wasStalled: false, stallCount: 0,
        // Phase 4：攻撃（HOST）
        atk: [{ action: null }, { action: null }], kotaroAid: 0, hitSeq: 0,
        accepted: [0, 0], rejected: 0, hits: [0, 0], misses: [0, 0], startDelay: new Stat(), lastAcceptedAid: 0, lastPressRecv: 0,
        // Phase 4：攻撃（GUEST）
        ap: 0, lastPressSent: 0, predAttacks: new Map(), acceptedAids: new Set(), lastHostAid: 0, hitRecvIds: new Set(), hitRecv: 0, lastHitId: 0,
        acceptRtt: new Stat(), hitShowDelay: new Stat(), matrix: { vv: 0, vm: 0, mv: 0, mm: 0 }, hostRejectedPred: 0, hostOnly: 0,
        dKotaro: new Samples(), dRuimpo: new Samples(), hitCorr: 0, hitErr: new Stat(), hitSnaps: 0, hitPending: false,
        ghost: null, flash: [0, 0], latestF: null,
        // Phase 5：遅延補償（HOST）
        hist: [], sentTicks: new Map(), kotaroHits: 0, lagBlocked: 0, rewindMs: new Samples(), capHits: 0, invalidRewind: 0, noRef: 0,
        lagCls: { both: 0, pastOnly: 0, curOnly: 0, none: 0 }, posDiff: new Samples(), escGap: new Samples(), lagOnlyHits: 0, lagViz: null, escCls: [0, 0, 0],
        // Phase 5：遅延補償（GUEST）
        viewRef: null, matrixCur: { vv: 0, vm: 0, mv: 0, mm: 0 }, gRewind: new Samples(), dKotaroPast: new Samples(),
      };
    }

    // ---------------- 受信 ----------------
    onMsg(m) {
      switch (m.t) {
        case 'ms':   // GUEST：HOST から開始の合図
          if (this.session.role !== 'GUEST') return;
          if (this.active) { if (m.id === this.testId) this.session.sendGame({ t: 'mr', id: m.id }); return; }
          if (this.begin('GUEST', m.id)) this.session.sendGame({ t: 'mr', id: m.id });
          return;
        case 'mr':   // HOST：GUEST の準備完了 → 開始
          if (this.session.role !== 'HOST' || !this.starting || m.id !== this.starting.id) return;
          this.starting = null;
          this.begin('HOST', m.id);
          return;
        case 'me':
          if ((this.active && m.id === this.testId) || (this.starting && m.id === this.starting.id)) this.stop('remote-' + m.r);
          return;
        case 'mi': return this.onInput(m);
        case 'st': return this.onState(m);
        case 'mh': return this.onHitEvent(m);
        case 'ma': return this.onAttackResult(m);
      }
    }

    // ---------------- HOST ----------------
    onInput(m) {
      if (!this.active || this.role !== 'HOST') { this.session.stats.dropped++; return; }
      const st = this.st;
      const t = now();
      // 異常な高頻度：1 秒あたり maxInputsPerSec を超えた分は無視（ゲーム処理は 1 ステップ 1 回の poll なので壊れない）
      if (t - st.inRateWindow > 1000) { st.inRateWindow = t; st.inRateCount = 0; }
      if (++st.inRateCount > CFG.maxInputsPerSec) { st.floodDropped++; return; }
      const prevAp = this.remote.lastAp;
      const res = this.remote.accept(m, t);
      if (res === 'stale') { st.staleInputs++; return; }
      if (res === 'bad') { st.badInputs++; return; }
      st.inputRate.hit();
      st.lastInputSeqRecv = m.s;
      if (m.ap > prevAp) st.lastPressRecv = m.s;   // GUEST が攻撃を押した入力の番号（受信）
      // GUEST の送信時刻を自分の時計に直して、届くまでの時間を推定（Ping から推定した時計のずれを使う）
      const off = this.session.clockOffset;
      if (off != null) st.inputDelay.add(Math.max(0, t - (m.ts - off)));
    }

    afterHostStep() {
      const st = this.st;
      if (!this.active) return;
      st.stepCount++;
      const r = this.remote;
      if (!r.neutral && now() - r.lastAt > CFG.inputTimeoutMs) {
        r.setNeutral();
        st.neutralCount++;
        this.log('GUEST input timed out (' + CFG.inputTimeoutMs + 'ms) → neutral', 'warn');
      }
      r.tick = st.stepCount;
      // Phase 5：コタロの Hurtbox を作るのに必要な値だけを残す（短いリングバッファ）
      const k = KG.game.player;
      st.hist.push({ tick: st.stepCount, x: k.x, y: k.y, facing: k.facing, alive: k.status.isAlive, hits: st.kotaroHits });
      if (st.hist.length > CFG.histTicks) st.hist.shift();
      this.trackHostAttacks();
      if (st.stepCount % CFG.stateEverySteps === 0) this.sendState();
    }

    // HOST：両者の技の開始・終了を見て、攻撃 ID・受理 / 出せなかった・HIT / MISS を記録する（判定そのものは既存処理）
    trackHostAttacks() {
      const g = KG.game, st = this.st, r = this.remote;
      [g.player, g.cpu].forEach((f, idx) => {
        const tr = st.atk[idx];
        const a = f.action;
        if (tr.action && tr.action !== a) this.finishHostAttack(idx, tr);
        if (a && a !== tr.action) {
          if (idx === 1) {
            if (!a.aid) a.aid = r.lastPressSeq;
            // 受理：この攻撃の元になった押下。それより前の押下は（硬直中などで）出せなかった
            let started = null;
            while (r.presses.length && r.presses[0].s <= a.aid) {
              const pr = r.presses.shift();
              if (pr.s === a.aid) started = pr; else st.rejected++;
            }
            const off = this.session.clockOffset;
            if (started && off != null) st.startDelay.add(Math.max(0, now() - (started.ts - off)));
            st.lastAcceptedAid = a.aid;
            a.lag = started && started.lag ? started.lag : { ticks: 0, ms: 0, status: 'none' };   // Phase 5：この攻撃の巻き戻し量
          } else {
            a.aid = ++st.kotaroAid;
          }
          st.accepted[idx]++;
          Object.assign(tr, { action: a, aid: a.aid, hit: false, measured: false, kx: 0, rx: 0, curHit: false, pastHit: false, blocked: false, pk: 0, hitsAtStart: st.kotaroHits, lagMs: a.lag ? a.lag.ms : 0 });
        }
        // Phase 5（GUEST の攻撃だけ）：判定が出ている各フレームで「今の位置なら当たるか」「遅延補償の位置なら当たるか」を両方記録（診断用）
        if (idx === 1 && a && tr.action === a && !tr.hit) {   // 命中した後のフレームは数えない（命中の瞬間は onHostHit で記録）
          const hbs = f.getActiveHitboxes();
          if (hbs.length && g.player.status.canBeHit) {
            const cur = KG.Fighter.prototype.getHurtboxes.call(g.player);
            const past = a.lag && a.lag.ticks > 0 ? this.pastHurtboxes(st.stepCount - a.lag.ticks, tr.hitsAtStart) : null;
            if (overlapAny(hbs, cur)) tr.curHit = true;
            if (overlapAny(hbs, past || cur)) tr.pastHit = true;
            if (past) st.lagViz = { cur, past, hbs, until: now() + 700 };
            else if (a.lag && a.lag.ticks > 0) tr.blocked = true;
          }
        }
        // 判定が出る最初のフレームの位置（GUEST の見た目との比較用）
        if (a && tr.action === a && !tr.measured && a.frame >= a.move.hitboxes[0].start) {
          tr.measured = true; tr.kx = g.player.x; tr.rx = g.cpu.x; tr.kAlive = g.player.status.isAlive;
          tr.pk = tr.kx;
          if (idx === 1 && a.lag && a.lag.ticks > 0 && this.pastHurtboxes(st.stepCount - a.lag.ticks, tr.hitsAtStart)) {
            const p = this.kotaroAt(st.stepCount - a.lag.ticks);
            if (p) { tr.pk = p.x; st.posDiff.add(Math.abs(p.x - tr.kx)); }   // 今の位置と参照した過去の位置の差
          }
        }
      });
      // 押してから先行入力の時間を過ぎても攻撃が始まらなかった押下 = 出せなかった（攻撃硬直中・被弾中など）
      while (r.presses.length && st.stepCount - r.presses[0].tick > CFG.attackRejectTicks) { r.presses.shift(); st.rejected++; }
    }

    finishHostAttack(idx, tr) {
      const st = this.st;
      if (tr.hit) st.hits[idx]++; else st.misses[idx]++;
      if (idx === 1) {   // GUEST の攻撃の結果（診断用。GUEST の見た目との比較に使う）
        const c = tr.curHit, pst = tr.pastHit;
        st.lagCls[c && pst ? 'both' : pst ? 'pastOnly' : c ? 'curOnly' : 'none']++;
        if (tr.blocked) st.lagBlocked++;
        this.session.sendGame({ t: 'ma', k: tr.aid, h: tr.hit ? 1 : 0, v: tr.measured && tr.kAlive ? 1 : 0, kx: r1(tr.kx), rx: r1(tr.rx),
          c: c ? 1 : 0, rw: Math.min(1000, Math.round(tr.lagMs || 0)), pk: r1(tr.pk) });
      }
      tr.action = null;
    }

    // HOST：命中した（既存の Combat.resolve → receiveHit の後）。命中イベントを送る
    onHostHit(victim, hit) {
      if (!this.active || this.role !== 'HOST') return;
      const g = KG.game, st = this.st;
      const attacker = hit.attacker;
      const ai = attacker === g.player ? 0 : attacker === g.cpu ? 1 : -1;
      if (ai < 0) return;
      const tr = st.atk[ai];
      if (tr.action) tr.hit = true;
      const aid = attacker.action && attacker.action.aid ? attacker.action.aid : 0;
      // Phase 5：命中の瞬間に「今の位置なら当たったか」「過去の位置なら当たったか」を記録（被弾の回数を増やす前に）
      if (ai === 1 && victim === g.player && tr.action) {
        const hbs0 = attacker.getActiveHitboxes();
        const a0 = attacker.action;
        const past0 = a0 && a0.lag && a0.lag.ticks > 0 ? this.pastHurtboxes(st.stepCount + 1 - a0.lag.ticks) : null;
        if (overlapAny(hbs0, KG.Fighter.prototype.getHurtboxes.call(victim))) tr.curHit = true;
        if (overlapAny(hbs0, past0 || KG.Fighter.prototype.getHurtboxes.call(victim))) tr.pastHit = true;
      }
      if (victim === g.player) st.kotaroHits++;   // Phase 5：被弾した後は、被弾前の位置へは巻き戻さない（下の pastHurtboxes）
      // Phase 5：遅延補償があったから当たった（今の位置では当たっていない）命中 = HOST から見て「避けたのに当たった」候補
      if (ai === 1 && victim === g.player) {
        const hbs = attacker.getActiveHitboxes();
        const cur = KG.Fighter.prototype.getHurtboxes.call(victim);
        if (hbs.length && !overlapAny(hbs, cur)) {
          const gap = gapBetween(hbs, cur);
          st.lagOnlyHits++; st.escGap.add(gap);
          st.escCls[gap <= 20 ? 0 : gap <= 60 ? 1 : 2]++;   // ほぼ触れている / 少し逃げた / はっきり逃げた
        }
      }
      this.session.sendGame({ t: 'mh', id: ++st.hitSeq, a: ai, k: aid, d: victim.status.damage, x: r1(hit.point.x), y: r1(hit.point.y), w: r1(now()) });
      this.log('HIT #' + st.hitSeq + ' ' + (ai === 0 ? 'コタロ→ルミポ' : 'ルミポ→コタロ') + ' (attack ' + aid + ', damage ' + victim.status.damage + '%)');
    }

    sendState() {
      const g = KG.game;
      const st = this.st;
      const f = g.fighters.slice(0, 2).map((fi) => {
        const s = fi.status;
        const code = Math.max(0, STATES.indexOf(fi.state));
        const flags = (s.isAlive ? 1 : 0) | (fi.grounded ? 2 : 0) | (code << 2) | (fi.hitstop > 0 ? 32 : 0) | (fi.hitstun > 0 ? 64 : 0);
        // [7] 蓄積ダメージ / [8] 技のフレーム（-1 = なし）/ [9] 傾き（被弾時の回転）
        return [r1(fi.x), r1(fi.y), r1(fi.vx), r1(fi.vy), fi.facing < 0 ? -1 : 1, flags, Math.min(60, Math.round(s.invincibleTimer * 100) / 100),
          s.damage, fi.action ? fi.action.frame : -1, Math.round(fi.angle * 100) / 100];
      });
      // a = 適用済みの最新入力番号 / p = ルミポの移動に関わる値（予測の作り直し用。丸めない）
      const ok = this.session.sendGame({ t: 'st', s: ++st.stateSeq, h: r1(g.time * 1000), w: r1(now()), a: this.remote.lastApplied, f, p: getLogic(g.cpu) });
      if (ok) {
        st.stateRate.hit();
        st.sentTicks.set(st.stateSeq, st.stepCount);   // Phase 5：この番号の状態はこのステップのもの
        if (st.sentTicks.size > CFG.sentStates) st.sentTicks.delete(st.sentTicks.keys().next().value);
      }
    }

    // ---------------- Phase 5：遅延補償（HOST） ----------------
    // GUEST の攻撃押下を適用した瞬間に、巻き戻し量を決める。参照は「HOST 自身が送った状態の番号」だけを信用する
    computeRewind(c) {
      const st = this.st;
      const curTick = st.stepCount + 1;                      // 今進めているステップ
      if (c.rs == null) { st.noRef++; return { ticks: 0, ms: 0, status: 'none' }; }
      const t0 = st.sentTicks.get(c.rs);
      if (t0 == null) {   // 送っていない番号（未来・存在しない・古すぎて記録に無い）→ 補償しない（今の位置で判定）
        st.invalidRewind++;
        this.log('invalid rewind reference (state ' + c.rs + ') → no compensation', 'warn');
        return { ticks: 0, ms: 0, status: 'invalid' };
      }
      const t1 = st.sentTicks.has(c.rs + 1) ? st.sentTicks.get(c.rs + 1) : t0 + CFG.stateEverySteps;
      const refTick = t0 + (c.rf / 1000) * (t1 - t0);
      if (refTick > curTick) { st.invalidRewind++; return { ticks: 0, ms: 0, status: 'invalid' }; }   // 未来は参照できない
      let ticks = curTick - refTick;
      const cap = CFG.lagMaxMs / 1000 / KG.CONFIG.fixedStep;
      let status = 'ok';
      if (ticks > cap) { ticks = cap; status = 'cap'; st.capHits++; }   // 上限より昔は見ない（上限まで）
      const ms = ticks * KG.CONFIG.fixedStep * 1000;
      st.rewindMs.add(ms);
      return { ticks, ms, status };
    }

    // 過去のステップ（小数可）のコタロの位置（履歴の前後 2 つから補間）
    kotaroAt(tick) {
      const h = this.st.hist;
      if (!h.length) return null;
      if (tick >= h[h.length - 1].tick) return h[h.length - 1];
      if (tick <= h[0].tick) return h[0];
      for (let i = h.length - 1; i > 0; i--) {
        const a = h[i - 1], b = h[i];
        if (a.tick <= tick && tick <= b.tick) {
          const k = (tick - a.tick) / Math.max(1, b.tick - a.tick);
          return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), facing: k < 0.5 ? a.facing : b.facing, alive: a.alive && b.alive };
        }
      }
      return h[0];
    }
    // 過去の位置のコタロの Hurtbox（既存のキャラ定義の hurtboxes をそのまま使う）。
    // 安全のため、参照する過去から今までの間に「場外・復帰」「被弾」「瞬間移動（1 ステップで 200 以上）」があった時は巻き戻さない（今の位置で判定）
    pastHurtboxes(tick, hitsRef) {
      const st = this.st, h = st.hist, g = KG.game;
      const hits = hitsRef == null ? st.kotaroHits : hitsRef;
      if (!g.player.status.isAlive) return null;
      for (let i = h.length - 1; i >= 0 && h[i].tick >= Math.floor(tick); i--) {
        const e = h[i], prev = h[i - 1];
        const newest = hitsRef != null && e.tick === st.stepCount;   // 診断（ステップ後）で呼ばれた時：このステップの命中は数えない
        if (!e.alive || (!newest && e.hits !== hits) || (prev && Math.abs(e.x - prev.x) + Math.abs(e.y - prev.y) > 200)) return null;
      }
      const p = this.kotaroAt(tick);
      if (!p || !p.alive) return null;
      const def = KG.game.player.def;
      return def.hurtboxes.map((b) => KG.util.orientBox(p.x, p.y, p.facing, b));
    }
    // Combat.resolve から呼ばれるコタロの Hurtbox：ルミポのぽよんアタックの判定が出ている間で、遅延補償 ON の時だけ過去の位置
    lagHurtboxes() {
      if (!this.active || this.role !== 'HOST' || !this.lagEnabled) return null;
      const g = KG.game, a = g.cpu.action;
      if (!a || !a.lag || !(a.lag.ticks > 0) || !g.cpu.getActiveHitboxes().length) return null;
      return this.pastHurtboxes(this.st.stepCount + 1 - a.lag.ticks);
    }

    setLagComp(on) {
      this.lagEnabled = !!on;
      this.renderPredBtn();
      this.renderDiag();
      if (this.active) this.log('lag compensation ' + (on ? 'ON' : 'OFF'));
    }

    // 診断表示中だけ：今のコタロの Hurtbox（実線）と、遅延補償で参照した過去の Hurtbox（点線）、ルミポの攻撃判定（赤）
    drawLagViz(alpha) {
      const st = this.st, g = KG.game;
      if (!this.active || !st || !st.lagViz || st.lagViz.until < now() || this.hud.classList.contains('diag-off')) return;
      const ctx = g.ctx, view = g.camera.getView(alpha), { w, h, dpr } = g.screen;
      const s = view.scale * dpr;
      ctx.save();
      ctx.setTransform(s, 0, 0, s, dpr * (w / 2 - view.cx * view.scale), dpr * (h / 2 - view.cy * view.scale));
      ctx.lineWidth = 3 / view.scale;
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
      for (const r of st.lagViz.cur) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([10 / view.scale, 6 / view.scale]);
      ctx.strokeStyle = 'rgba(255, 220, 120, 0.95)';
      for (const r of st.lagViz.past) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 90, 110, 0.9)';
      for (const hb of st.lagViz.hbs) ctx.strokeRect(hb.rect.x, hb.rect.y, hb.rect.w, hb.rect.h);
      ctx.restore();
    }

    // ---------------- GUEST ----------------
    guestStep(dt) {
      const g = KG.game;
      if (!this.active) return;
      g.time += dt;
      g.phaseTime += dt;
      const st0 = this.st;
      st0.flash[0] = Math.max(0, st0.flash[0] - dt); st0.flash[1] = Math.max(0, st0.flash[1] - dt);
      this.sampleInput(dt);
      this.applyView(dt);
      this.expirePredAttacks();
      g.effects.update(dt);
      g.camera.setTargets(g.activeEntities());
      g.camera.update(dt);
      g.background.update(dt);
    }

    // 自分の入力（キーボード・タッチ。既存の InputManager に集まる）を読み、1 ステップ 1 件として送る（60 回/秒）。
    // 同じ入力を予測用ルミポにもすぐ適用する（HOST の返事を待たない）
    sampleInput(dt) {
      const st = this.st;
      const cmd = KG.game.input.poll();
      const l = cmd.moveX < -CFG.stickThreshold ? 1 : 0;
      const r = cmd.moveX > CFG.stickThreshold ? 1 : 0;
      const j = cmd.held.jump ? 1 : 0;
      const pj = cmd.pressed.jump ? 1 : 0;
      const pa = cmd.pressed.attack ? 1 : 0;
      if (pj) st.jp++;                                  // 押した瞬間を回数で数える（押しっぱなしでは増えない）
      if (pa) st.ap++;                                  // 攻撃も同じ（押しっぱなしでは増えない）
      const t = now();
      const s = ++st.inputSeq;
      const msg = { t: 'mi', s, l, r, j, jp: st.jp, ap: st.ap, ts: r1(t) };
      // Phase 5：攻撃を押した入力だけ、その瞬間の画面のコタロがどの HOST 状態だったか（番号と割合）を付ける。座標は送らない
      if (pa && st.viewRef) { msg.rs = st.viewRef.s; msg.rf = Math.round(st.viewRef.k * 1000); }
      if (!this.session.sendGame(msg)) return; // 切断中は予測もしない
      if (pa) st.lastPressSent = s;
      st.cur = { l, r, j, jp: st.jp };
      st.lastInputSentAt = t;
      st.inputRate.hit();
      st.sentTimes.set(s, t);
      if (st.sentTimes.size > 240) st.sentTimes.delete(st.sentTimes.keys().next().value);
      // 未確認入力として覚えておく（HOST の a で確認済みになったら捨てる）
      const c = { s, mx: r - l, hj: j, pj, pa, t };
      st.pending.push(c);
      if (st.pending.length > CFG.maxPending) { st.pending.shift(); st.pendingDropped++; }
      this.predictStep(c, dt);
    }

    // 予測：既存の Fighter.update() をそのまま 1 回呼ぶ（HOST の RemoteInputController と同じコマンドの作り方）
    predictStep(c, dt) {
      const f = this.pred, st = this.st;
      if (!f || st.predHidden) return;
      if (this.ackStalled()) return;   // HOST が入力を確認していない：先へ進めない（HOST の状態に従う）
      const started = applyCmd(f, c, KG.game.stage);
      if (started) {
        // 攻撃の予測開始（見た目だけ。命中は判定しない）。結果は HOST から届く
        st.ghost = null;
        st.predAttacks.set(started.aid, { t: c.t, visHit: false, kxDisp: null, rxDisp: null, measured: false, done: false, accepted: false });
      }
      if (KG.game.stage.isOutOfBounds(f)) st.predHidden = true;   // 場外へ出た：HOST の判定（復帰）を待つ
    }

    // 予測の作り直し（reconciliation）：HOST の確定状態 + まだ確認されていない入力 → 今の予測
    reconcile(m) {
      const st = this.st, f = this.pred;
      if (!f || !m.p) return;
      while (st.pending.length && st.pending[0].s <= m.a) st.pending.shift();  // HOST が適用済みの入力は捨てる
      const alive = !!(m.f[1][5] & 1);
      st.lastInv = m.f[1][6];
      if (!alive) { st.hostAlive = false; st.predHidden = true; return; }   // 場外・復帰待ち：HOST の判定に従う
      const wasHidden = st.predHidden || !st.hostAlive;
      st.hostAlive = true;
      // HOST で始まった攻撃の ID（受理の確認）
      if (m.p[12] >= 0 && m.p[17] && !st.acceptedAids.has(m.p[17])) {
        st.acceptedAids.add(m.p[17]);
        st.lastHostAid = m.p[17];
        const pa = st.predAttacks.get(m.p[17]);
        if (pa) { pa.accepted = true; st.acceptRtt.add(now() - pa.t); }
      }
      const bx = f.x, by = f.y;
      const beforeAct = f.action ? { move: f.action.move, frame: f.action.frame, aid: f.action.aid } : null;
      // 被弾・命中が絡む作り直しか（HOST の被弾結果を優先する）
      const hitRelated = m.p[14] > 0 || m.p[15] > 0 || st.hitPending;
      st.hitPending = false;
      setLogic(f, m.p);
      st.predHidden = false;
      const dt = KG.CONFIG.fixedStep;
      // HOST が 500ms 以上入力を確認していない（通信が詰まっている・HOST がニュートラルにした）間は、
      // 未確認入力を重ねず HOST の状態をそのまま使う（通信が止まった時に、自分の画面だけ動き続けないように）
      const stalled = this.ackStalled();
      if (stalled !== st.wasStalled) { st.wasStalled = stalled; if (stalled) { st.stallCount++; this.log('inputs not acknowledged for ' + CFG.inputTimeoutMs + 'ms → prediction paused', 'warn'); } }
      if (!stalled) for (const c of st.pending) applyCmd(f, c, KG.game.stage);
      void dt;
      // HOST で攻撃が出なかった（予測していた攻撃が作り直しで消えた）：見た目だけ最後まで再生して自然に終える（被弾中は即座にやめる）
      if (beforeAct && !f.action && f.hitstun === 0 && beforeAct.frame < beforeAct.move.totalFrames) st.ghost = beforeAct;
      if (f.action || f.hitstun > 0) st.ghost = null;
      if (KG.game.stage.isOutOfBounds(f)) st.predHidden = true;
      st.reconciles++;
      if (wasHidden) { st.vis.x = 0; st.vis.y = 0; st.respawnSnap = true; return; }   // 復帰した瞬間は HOST の位置から
      // 予測誤差 = 作り直す前の予測位置 − 作り直した後の予測位置（同じ時点の比較）
      const ex = bx - f.x, ey = by - f.y, e = Math.hypot(ex, ey);
      if (hitRelated) {
        // 被弾・命中による差：予測誤差とは分けて数え、速め（30ms）に HOST の結果へ寄せる。大きすぎれば即座に
        if (e > 0) { st.hitErr.add(e); st.hitCorr++; }
        if (!this.predEnabled) return;
        if (e >= CFG.hitSnap) { st.vis.x = 0; st.vis.y = 0; st.hitSnaps++; }
        else { st.vis.x += ex; st.vis.y += ey; st.fastUntil = now() + 150; }
        return;
      }
      st.lastErrX = ex; st.lastErrY = ey;
      st.predErr.add(e);
      if (e > 0) st.nonZeroErr++;
      if (!this.predEnabled) return;
      if (e >= CFG.errSnap) {                         // 致命的な誤差：HOST 状態へ即座に合わせる
        st.vis.x = 0; st.vis.y = 0; st.snapCount++;
        this.log('prediction snap: error ' + e.toFixed(1), 'warn');
      } else {
        // 画面の位置が急に飛ばないよう、差を表示位置のずれとして残し、数フレームで消す（物理の値は変えない）
        st.vis.x += ex; st.vis.y += ey;
        if (e >= CFG.errIgnore) st.corrections++;
      }
    }

    // GUEST：HOST の命中イベント（同じ ID は 1 回だけ）。見た目（エフェクト・音・白く光る）を出し、ダメージ表示を HOST の値にする
    onHitEvent(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      const st = this.st, g = KG.game;
      if (m.id <= st.lastHitId) return;           // 古い・重複した命中は二重に表示しない
      st.lastHitId = m.id;
      st.hitRecv++;
      const off = this.session.clockOffset;
      if (off != null) st.hitShowDelay.add(Math.max(0, now() - (m.w - off)));
      const attacker = m.a === 0 ? g.player : g.cpu, victim = m.a === 0 ? g.cpu : g.player;
      victim.status.damage = m.d;
      st.flash[m.a === 0 ? 1 : 0] = 0.18;
      if (m.a === 0) st.hitPending = true;        // 自分（ルミポ）が被弾：次の作り直しは HOST の被弾結果を優先
      if (m.a === 1) { const rec = st.predAttacks.get(m.k); if (rec) rec.hostHit = true; }
      try { g.effects.spawnHit(m.x, m.y, KG.util.sign(victim.x - attacker.x) || 1); } catch (_) { /* noop */ }
      try { if (KG.sound) KG.sound.play('hit', { s: 0.6, heavy: 0 }); } catch (_) { /* noop */ }
    }

    // GUEST：自分の攻撃の HOST での結果（HIT / MISS と、判定が出た瞬間の HOST 上の位置）。見た目との比較（診断）だけに使う
    onAttackResult(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      const st = this.st;
      const rec = st.predAttacks.get(m.k);
      if (!rec) { st.hostOnly++; return; }
      if (rec.done) return;
      rec.done = true;
      const vis = rec.visHit, host = !!m.h;
      st.matrix[(vis ? 'v' : 'm') + (host ? 'v' : 'm')]++;
      st.matrixCur[(vis ? 'v' : 'm') + (m.c ? 'v' : 'm')]++;   // Phase 5：同じ攻撃を「今の位置」で判定した場合（HOST の診断値）
      st.gRewind.add(m.rw);
      if (m.v && rec.measured) {
        st.dKotaro.add(Math.abs(rec.kxDisp - m.kx));
        st.dRuimpo.add(Math.abs(rec.rxDisp - m.rx));
        st.dKotaroPast.add(Math.abs(rec.kxDisp - m.pk));       // 自分の画面のコタロと、HOST が遅延補償で参照したコタロの差
      }
    }

    // GUEST：予測した攻撃のうち、HOST の結果が来ないまま時間が過ぎたもの = HOST では出なかった
    expirePredAttacks() {
      const st = this.st, t = now();
      for (const [aid, rec] of st.predAttacks) {
        if (!rec.done && t - rec.t > CFG.attackResultTimeoutMs) { rec.done = true; if (!rec.accepted) st.hostRejectedPred++; }
        if (rec.done && t - rec.t > 5000) st.predAttacks.delete(aid);
      }
    }

    // 一番古い未確認入力が inputTimeoutMs（HOST がニュートラルにする時間）より古いか
    ackStalled() {
      const p = this.st.pending;
      return p.length > 0 && now() - p[0].t > CFG.inputTimeoutMs;
    }

    // 予測 ON / OFF（GUEST だけ。実験中いつでも切り替えられる。表示位置は急に飛ばずに滑らかにつながる）
    setPrediction(on) {
      this.predEnabled = !!on;
      if (this.st) { this.st.blend = true; this.st.blendUntil = now() + 400; }
      this.renderPredBtn();
      this.renderDiag();
      if (this.active) this.log('prediction ' + (on ? 'ON' : 'OFF'));
    }
    renderPredBtn() {
      const b = this.$ && this.$.predBtn;
      if (!b) return;
      b.textContent = this.predEnabled ? '予測 ON' : '予測 OFF';
      b.classList.toggle('is-on', this.predEnabled);
      const lb = this.$.lagBtn;
      if (lb) { lb.textContent = this.lagEnabled ? 'LagComp ON' : 'LagComp OFF'; lb.classList.toggle('is-on', this.lagEnabled); }
    }

    onState(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      const st = this.st;
      if (m.s <= st.lastStateSeqRecv) { st.staleStates++; return; }  // 古い・重複・逆順の状態は捨てる
      const t = now();
      st.lastStateSeqRecv = m.s;
      st.lastStateAt = t;
      st.stateRate.hit();
      st.waitingFirstState = false;
      // HOST のゲーム内時刻 → 自分の時計への対応。届くのが早かった（遅延が小さかった）値に素早く寄せ、遅い値にはゆっくり寄せる
      const sample = m.h - t;
      if (st.tOff == null) st.tOff = sample;
      else st.tOff += (sample - st.tOff) * (sample > st.tOff ? 0.25 : 0.02);
      st.snaps.push({ h: m.h, f: m.f, s: m.s });
      st.latestF = m.f;
      if (st.snaps.length > 60) st.snaps.shift();
      // 入力 → HOST で反映 → その結果の状態が届く、までの往復時間（入力番号 a で対応付け）
      if (m.a > st.lastAcked) {
        const sentAt = st.sentTimes.get(m.a);
        if (sentAt != null) st.reflect.add(t - sentAt);
        st.lastAcked = m.a;
      }
      const off = this.session.clockOffset;
      if (off != null) st.stateDelay.add(Math.max(0, t - (m.w - off)));
      this.reconcile(m);
    }

    // HOST の状態を interpDelayMs だけ遅らせた時刻で、前後 2 つの状態から補間して表示（予測はしない）
    applyView(dt) {
      const st = this.st;
      const snaps = st.snaps;
      if (snaps.length && st.tOff != null) this.applyInterpolated();
      this.applyRuimpo(dt);
    }

    // GUEST のルミポ：予測 ON なら予測用 Fighter の位置 + 表示のずれ、OFF なら Phase 2 と同じ補間の位置
    applyRuimpo(dt) {
      const st = this.st, g = KG.game, fi = g.cpu, f = this.pred;
      const interp = st.interpCpu;                      // applyInterpolated() が計算したルミポの補間結果
      let base, alive;
      if (this.predEnabled && f) {
        base = { x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing, grounded: f.grounded, state: f.state };
        alive = st.hostAlive && !st.predHidden;
      } else if (interp) {
        base = interp; alive = interp.alive;
      } else return;
      const prevX = fi.x, prevY = fi.y;
      if (st.blend) {                                   // ON / OFF を切り替えた瞬間：今の表示位置からつなぐ
        st.vis.x = fi.x - base.x; st.vis.y = fi.y - base.y; st.blend = false;
        if (Math.hypot(st.vis.x, st.vis.y) > CFG.errSnap * 3) { st.vis.x = 0; st.vis.y = 0; }
      }
      // 表示のずれを時間で消す（大きいほど速く）。物理の値には触らない
      const mag = Math.hypot(st.vis.x, st.vis.y);
      if (mag > 0) {
        // ON / OFF 切替直後は、つなぎ目が目立たないようゆっくり（120ms）
        const tau = st.blendUntil > now() ? 120 : st.fastUntil > now() ? CFG.hitTauMs : mag > CFG.errSmall ? CFG.tauLargeMs : CFG.tauSmallMs;
        const k = Math.exp(-(dt * 1000) / tau);
        st.vis.x *= k; st.vis.y *= k;
        if (Math.hypot(st.vis.x, st.vis.y) < 0.05) { st.vis.x = 0; st.vis.y = 0; }
      }
      const wasAlive = fi.status.isAlive;
      fi.x = base.x + st.vis.x; fi.y = base.y + st.vis.y;
      fi.prevX = prevX; fi.prevY = prevY;
      if ((alive && !wasAlive) || st.respawnSnap) { fi.prevX = fi.x; fi.prevY = fi.y; st.respawnSnap = false; }
      fi.vx = base.vx; fi.vy = base.vy; fi.facing = base.facing; fi.grounded = base.grounded; fi.state = base.state;
      fi.status.lifeState = alive ? 'alive' : 'respawning';
      fi.status.invincibleTimer = this.predEnabled ? st.lastInv : base.inv;
      // ---- Phase 4：技・被弾の見た目 ----
      let act = null, hitstop = 0, hitstun = 0, angle = 0;
      if (this.predEnabled && f) {
        if (f.action) act = f.action;
        else if (st.ghost) {   // HOST で出なかった予測攻撃：見た目だけ最後まで
          st.ghost.frame++;
          act = st.ghost.frame <= st.ghost.move.totalFrames ? st.ghost : (st.ghost = null);
        }
        hitstop = f.hitstop; hitstun = f.hitstun; angle = f.angle;
      } else if (interp) {
        act = interp.actFrame >= 0 ? { move: POYON(), frame: interp.actFrame } : null;
        hitstop = interp.hitstop; hitstun = interp.hitstun; angle = interp.angle;
      }
      this.setDisplayAction(fi, act, hitstop, hitstun, angle, st.flash[1]);
      if (st.latestF) fi.status.damage = st.latestF[1][7];
      // 見た目の当たり（診断だけ。命中の判定には使わない）：自分の画面で、予測した攻撃の判定がコタロに重なって見えたか
      if (this.predEnabled && f && f.action && f.action === act) {
        const rec = st.predAttacks.get(f.action.aid);
        const hbs = fi.getActiveHitboxes();
        if (rec && hbs.length) {
          if (!rec.measured) { rec.measured = g.player.status.isAlive; rec.kxDisp = g.player.x; rec.rxDisp = fi.x; }
          if (g.player.status.isAlive) {
            const hurt = g.player.getHurtboxes();
            for (const hb of hbs) for (const hu of hurt) if (KG.util.rectsOverlap(hb.rect, hu)) rec.visHit = true;
          }
        }
      }
    }

    // 表示用 Fighter に技・被弾の見た目を設定（描画は既存の Fighter.draw がそのまま行う）
    setDisplayAction(fi, act, hitstop, hitstun, angle, flash) {
      fi.action = act ? { move: act.move, frame: act.frame, hitVictims: NO_VICTIMS, aid: act.aid } : null;
      fi.hitstop = hitstop; fi.hitstun = hitstun;
      fi.prevAngle = fi.angle; fi.angle = angle;
      fi.shake = hitstop > 0 && hitstun > 0 ? 1 : 0;
      fi.flash = flash;
    }

    // HOST の状態の補間（コタロは常にこれ。ルミポは予測 OFF の時だけ使う）
    applyInterpolated() {
      const st = this.st;
      const snaps = st.snaps;
      const renderH = now() + st.tOff - CFG.interpDelayMs;
      while (snaps.length > 2 && snaps[1].h <= renderH - 500) snaps.shift();   // 古すぎる状態は捨てる
      let A = null, B = null;
      for (let i = snaps.length - 1; i >= 0; i--) {
        if (snaps[i].h <= renderH) { A = snaps[i]; B = snaps[i + 1] || null; break; }
      }
      const g = KG.game;
      st.extrapolating = false;
      // Phase 5：今コタロの表示に使っている HOST 状態の番号と、次の状態までの割合（攻撃を押した時に HOST へ伝える）
      if (A) {
        const k = B ? (renderH - A.h) / Math.max(1, B.h - A.h) : (renderH - A.h) / (1000 * KG.CONFIG.fixedStep * CFG.stateEverySteps);
        st.viewRef = { s: A.s, k: Math.min(3, Math.max(0, k)) };
      } else st.viewRef = snaps.length ? { s: snaps[0].s, k: 0 } : null;
      g.fighters.slice(0, 2).forEach((fi, idx) => {
        let x, y, src;
        if (!A) { src = snaps[0].f[idx]; x = src[0]; y = src[1]; }          // まだ最初の状態より前
        else if (!B) {
          // 新しい状態がまだ無い：速度で少しだけ先へ（最大 maxExtrapolateMs）。それ以上は止めて待つ
          src = A.f[idx];
          const e = Math.min(CFG.maxExtrapolateMs, Math.max(0, renderH - A.h)) / 1000;
          x = src[0] + src[2] * e;
          y = src[1] + (src[5] & 2 ? 0 : src[3] * e);
          if (renderH - A.h > 1) st.extrapolating = true;
        } else {
          const a = A.f[idx], b = B.f[idx];
          const k = Math.min(1, Math.max(0, (renderH - A.h) / Math.max(1, B.h - A.h)));
          src = k < 0.5 ? a : b;
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > CFG.snapDistance || !(a[5] & 1) !== !(b[5] & 1)) { x = src[0]; y = src[1]; }
          else { x = lerp(a[0], b[0], k); y = lerp(a[1], b[1], k); }
        }
        const alive = !!(src[5] & 1);
        if (idx === 1) {   // ルミポは applyRuimpo() で表示する
          st.interpCpu = { x, y, vx: src[2], vy: src[3], facing: src[4], grounded: !!(src[5] & 2), state: STATES[(src[5] >> 2) & 7] || 'idle', alive, inv: src[6],
            actFrame: src[8], hitstop: src[5] & 32 ? 1 : 0, hitstun: src[5] & 64 ? 1 : 0, angle: src[9] };
          return;
        }
        const wasAlive = fi.status.isAlive;
        fi.prevX = fi.x; fi.prevY = fi.y;
        fi.x = x; fi.y = y;
        if (alive && !wasAlive) { fi.prevX = x; fi.prevY = y; }  // 復帰した瞬間は前の位置から滑らせない
        fi.vx = src[2]; fi.vy = src[3];
        fi.facing = src[4];
        fi.grounded = !!(src[5] & 2);
        fi.state = STATES[(src[5] >> 2) & 7] || 'idle';
        fi.status.lifeState = alive ? 'alive' : 'respawning';
        fi.status.invincibleTimer = src[6];
        // コタロの技・被弾の見た目（HOST の状態のまま）とダメージ
        this.setDisplayAction(fi, src[8] >= 0 ? { move: POYON(), frame: src[8] } : null, src[5] & 32 ? 1 : 0, src[5] & 64 ? 1 : 0, src[9], st.flash[0]);
        if (st.latestF) fi.status.damage = st.latestF[0][7];
      });
      if (st.extrapolating) st.extrapCount++;
    }

    // ---------------- 画面（操作実験中だけの小さな表示・GUEST のタッチ操作） ----------------
    buildDom() {
      const root = document.getElementById('game-root') || document.body;
      const hud = this.hud = document.createElement('div');
      hud.id = 'ol-move-hud';
      hud.hidden = true;
      hud.innerHTML =
        '<div class="olm-top">' +
          '<span class="olm-badge">ONLINE TEST・ぽよんアタック</span>' +
          '<span class="olm-role"></span>' +
          '<button type="button" class="olm-btn olm-pred" data-olm="pred">予測 ON</button>' +
          '<button type="button" class="olm-btn olm-lag" data-olm="lag">LagComp ON</button>' +
          '<button type="button" class="olm-btn" data-olm="diag">診断</button>' +
          '<button type="button" class="olm-btn olm-end" data-olm="end">実験を終了</button>' +
        '</div>' +
        '<pre class="olm-diag"></pre>' +
        '<p class="olm-hint">移動：<kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd>　ジャンプ：<kbd>Space</kbd> <kbd>W</kbd> <kbd>↑</kbd>　攻撃（ぽよんアタック）：<kbd>J</kbd>　（必殺・泡・ガードはこの実験では無効）</p>';
      root.appendChild(hud);
      this.$ = { role: hud.querySelector('.olm-role'), diag: hud.querySelector('.olm-diag'), predBtn: hud.querySelector('[data-olm="pred"]'), lagBtn: hud.querySelector('[data-olm="lag"]') };
      const bindBtn = (el, fn) => {
        el.addEventListener('pointerdown', (e) => { e.stopPropagation(); el._armed = e.pointerId; });
        el.addEventListener('pointerup', (e) => { e.stopPropagation(); if (el._armed === e.pointerId) fn(); el._armed = null; });
        el.addEventListener('click', (e) => { if (e.detail === 0) fn(); });
      };
      bindBtn(hud.querySelector('[data-olm="end"]'), () => { if (KG.sound) KG.sound.play('back'); this.end(); });
      bindBtn(hud.querySelector('[data-olm="diag"]'), () => hud.classList.toggle('diag-off'));
      bindBtn(this.$.predBtn, () => { if (KG.sound) KG.sound.play('select'); this.setPrediction(!this.predEnabled); });
      bindBtn(this.$.lagBtn, () => { if (KG.sound) KG.sound.play('select'); this.setLagComp(!this.lagEnabled); });
      if (window.matchMedia && matchMedia('(pointer: coarse)').matches) hud.classList.add('diag-off'); // スマホは最初は畳む

      // GUEST 用のタッチ操作：左に LEFT / RIGHT（指を滑らせて切り替え可）、右に JUMP。マルチタッチ対応
      const pad = this.pad = document.createElement('div');
      pad.id = 'ol-pad';
      pad.innerHTML =
        '<div class="olp-dir" aria-label="左右移動"><span class="olp-key" data-dir="-1">◀<small>LEFT</small></span><span class="olp-key" data-dir="1">▶<small>RIGHT</small></span></div>' +
        '<div class="olp-atk" aria-label="攻撃"><span>●<small>攻撃</small></span></div>' +
        '<div class="olp-jump" aria-label="ジャンプ"><span>▲<small>JUMP</small></span></div>';
      root.appendChild(pad);
      const dir = pad.querySelector('.olp-dir');
      const keys = dir.querySelectorAll('.olp-key');
      this.padState = { dirId: null, dir: 0 };
      const setDir = (d) => {
        this.padState.dir = d;
        keys.forEach((k) => k.classList.toggle('pressed', Number(k.dataset.dir) === d));
        try { KG.game.input.setAxis('olpad', d, 0); } catch (_) { /* noop */ }
      };
      const dirFrom = (e) => {
        const r = dir.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2 ? -1 : 1;
      };
      dir.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.padState.dirId !== null) return;
        this.padState.dirId = e.pointerId;
        try { dir.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
        setDir(dirFrom(e));
      });
      dir.addEventListener('pointermove', (e) => { if (e.pointerId === this.padState.dirId) setDir(dirFrom(e)); });
      const dirUp = (e) => { if (e.pointerId !== this.padState.dirId) return; this.padState.dirId = null; setDir(0); };
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) dir.addEventListener(t, dirUp);
      // 右側のボタン（JUMP・攻撃）：押している指ごとに既存の InputManager へ「押している」を伝える（押した瞬間は InputManager が記録）
      const buttons = [];
      const bindAction = (el, action) => {
        const ids = new Set();
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          ids.add(e.pointerId);
          try { el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
          try { KG.game.input.setHeld(action, 'olpad:' + e.pointerId, true); } catch (_) { /* noop */ }
          el.classList.add('pressed');
        });
        const up = (e) => {
          if (!ids.delete(e.pointerId)) return;
          try { KG.game.input.setHeld(action, 'olpad:' + e.pointerId, false); } catch (_) { /* noop */ }
          if (!ids.size) el.classList.remove('pressed');
        };
        for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
        buttons.push({ el, action, ids });
      };
      bindAction(pad.querySelector('.olp-jump'), 'jump');
      bindAction(pad.querySelector('.olp-atk'), 'attack');   // Phase 4：攻撃（ぽよんアタック）
      this.padReset = () => {
        if (this.padState.dirId !== null) { this.padState.dirId = null; }
        setDir(0);
        for (const b of buttons) {
          for (const id of b.ids) { try { KG.game.input.setHeld(b.action, 'olpad:' + id, false); } catch (_) { /* noop */ } }
          b.ids.clear();
          b.el.classList.remove('pressed');
        }
      };
    }

    renderDiag() {
      if (!this.active) return;
      const s = this.session, st = this.st, p = s.ping;
      const ms = (v) => v == null ? '-' : Math.round(v) + 'ms';
      const hz = (v) => v.toFixed(0) + 'Hz';
      const num = (v) => v == null ? '-' : Math.round(v);
      const lines = ['PING ' + ms(p.last) + '  avg ' + ms(s.pingAvg) + '  (min ' + ms(p.min) + ' / max ' + ms(p.max) + ')'];
      if (this.role === 'HOST') {
        const r = this.remote;
        const L = r.last;
        lines.push(
          'GUEST入力 受信 ' + hz(st.inputRate.value) + '  最後の input seq ' + st.lastInputSeqRecv + '（適用済み ' + r.lastApplied + '）  古い/重複 ' + st.staleInputs + (st.floodDropped ? '  過多で無視 ' + st.floodDropped : ''),
          '入力が届くまで（推定） ' + ms(st.inputDelay.avg) + '  最大 ' + ms(st.inputDelay.max),
          '未適用の入力 ' + r.queue.length + '件  届く前に続けた回数 ' + r.dupTicks + '  追いつき ' + r.catchUps + (r.overflow ? '  あふれ ' + r.overflow : ''),
          'HOST状態 送信 ' + hz(st.stateRate.value) + '  最後の state seq ' + st.stateSeq,
          'ルミポ入力 ' + (r.neutral ? 'ニュートラル（入力なし）' : [L.mx < 0 ? 'LEFT' : '', L.mx > 0 ? 'RIGHT' : '', L.hj ? 'JUMP' : ''].filter(Boolean).join('+') || '-') +
            '  無通信でニュートラル化 ' + st.neutralCount + '回',
          '攻撃 GUEST押下 seq ' + st.lastPressRecv + '  受理 ID ' + st.lastAcceptedAid + '  受理 ' + st.accepted[1] + '  出せなかった ' + st.rejected +
            '  押下→HOSTで開始（推定） ' + ms(st.startDelay.avg),
          'HOST判定 ルミポ HIT ' + st.hits[1] + ' / MISS ' + st.misses[1] + '　コタロ HIT ' + st.hits[0] + ' / MISS ' + st.misses[0] + '（攻撃 ' + st.accepted[0] + '）  命中イベント ' + st.hitSeq,
          'LagComp ' + (this.lagEnabled ? 'ON' : 'OFF') + '（上限 ' + CFG.lagMaxMs + 'ms / 履歴 ' + Math.round(CFG.histTicks * KG.CONFIG.fixedStep * 1000) + 'ms）［C キーで切替］  巻き戻し 平均 ' + num(st.rewindMs.mean) +
            ' / 中央値 ' + num(st.rewindMs.median) + ' / 最大 ' + num(st.rewindMs.max) + 'ms  上限到達 ' + st.capHits + '  不正な参照 ' + st.invalidRewind,
          'ルミポの攻撃 今の位置でも過去でもHIT ' + st.lagCls.both + '  過去だけHIT ' + st.lagCls.pastOnly + '  今だけHIT ' + st.lagCls.curOnly + '  どちらもMISS ' + st.lagCls.none,
          '今と参照した過去のコタロの差 平均 ' + num(st.posDiff.mean) + ' / 中央値 ' + num(st.posDiff.median) + ' / 最大 ' + num(st.posDiff.max) +
            '  遅延補償があったから当たった ' + st.lagOnlyHits + '回（その時の今の位置との距離 平均 ' + num(st.escGap.mean) + ' / 最大 ' + num(st.escGap.max) +
            '。20以下 ' + st.escCls[0] + ' / 20〜60 ' + st.escCls[1] + ' / 60超 ' + st.escCls[2] + '）  補償しなかった（被弾・復帰の直後） ' + st.lagBlocked,
        );
      } else {
        const stall = st.lastStateAt ? now() - st.lastStateAt : null;
        const e = st.predErr;
        const on = this.predEnabled;
        lines.push(
          '予測 ' + (on ? 'ON（ルミポ＝すぐ反応 / コタロ＝補間）' : 'OFF（Phase 2 と同じ：HOST の結果を補間表示）') + '　［P キーで切替］',
          '入力 送信 ' + hz(st.inputRate.value) + '  最後の input seq ' + st.inputSeq + '  HOST ack ' + st.lastAcked + '  未確認 ' + st.pending.length + '件',
          'HOST状態 受信 ' + hz(st.stateRate.value) + '  最後の state seq ' + st.lastStateSeqRecv + (st.staleStates ? '  古い ' + st.staleStates : ''),
          '予測誤差 X ' + st.lastErrX.toFixed(1) + '  Y ' + st.lastErrY.toFixed(1) + '  平均 ' + (e.avg == null ? '-' : e.avg.toFixed(2)) + '  最大 ' + (e.max == null ? '-' : e.max.toFixed(1)) +
            '  （0でない ' + st.nonZeroErr + ' / ' + st.reconciles + '回）',
          '補正 ' + st.corrections + '回  snap ' + st.snapCount + '回  表示のずれ ' + Math.hypot(st.vis.x, st.vis.y).toFixed(1) +
            (this.ackStalled() ? '  ⚠ HOSTが入力を確認していないため予測を停止中' : st.stallCount ? '  予測停止 ' + st.stallCount + '回' : ''),
          '入力→HOSTで反映→受信 ' + ms(st.reflect.avg) + '  最大 ' + ms(st.reflect.max),
          (on
            ? '体感の目安（入力→画面） ルミポ 次のフレーム（約 0〜17ms）／ コタロ 約 ' + (st.stateDelay.avg == null ? '-' : Math.round(st.stateDelay.avg + CFG.interpDelayMs + 8)) + 'ms 遅れて表示'
            : '体感の目安（入力→画面） 約 ' + (st.reflect.avg == null ? '-' : Math.round(st.reflect.avg + CFG.interpDelayMs + 8) + 'ms') + '　予測なし'),
          'HOST状態が届くまで（推定） ' + ms(st.stateDelay.avg) + '  補間 ' + CFG.interpDelayMs + 'ms  外挿 ' + st.extrapCount + 'F' +
            (st.waitingFirstState ? '  HOSTの状態を待っています…' : stall > CFG.stateStallMs ? '  ⚠ HOSTの状態が ' + (stall / 1000).toFixed(1) + '秒 届いていません' : ''),
          '攻撃 押下 seq ' + st.lastPressSent + '  HOST受理 ID ' + st.lastHostAid + '  HOSTで出なかった ' + st.hostRejectedPred + '  押下→受理確認 ' + ms(st.acceptRtt.avg),
          'HITイベント受信 ' + st.hitRecv + '  HOSTでHIT→表示 ' + ms(st.hitShowDelay.avg) + '  被弾/命中の補正 ' + st.hitCorr + '回（最大 ' + (st.hitErr.max == null ? '-' : st.hitErr.max.toFixed(0)) + '）' + (st.hitSnaps ? '  snap ' + st.hitSnaps : ''),
          '見た目×HOST判定  見た目HIT/HOST HIT ' + st.matrix.vv + '  見た目HIT/HOST MISS ' + st.matrix.vm + '  見た目MISS/HOST HIT ' + st.matrix.mv + '  見た目MISS/HOST MISS ' + st.matrix.mm,
          '同じ攻撃を今の位置で判定した場合  見た目HIT/HIT ' + st.matrixCur.vv + '  見た目HIT/MISS ' + st.matrixCur.vm + '  見た目MISS/HIT ' + st.matrixCur.mv + '  見た目MISS/MISS ' + st.matrixCur.mm +
            '  HOSTの巻き戻し 平均 ' + num(st.gRewind.mean) + 'ms',
          '判定の瞬間の位置の差（自分の画面とHOST）  コタロ 平均 ' + (st.dKotaro.mean == null ? '-' : st.dKotaro.mean.toFixed(0)) + ' / 中央値 ' + (st.dKotaro.median == null ? '-' : st.dKotaro.median.toFixed(0)) +
            ' / 最大 ' + (st.dKotaro.max == null ? '-' : st.dKotaro.max.toFixed(0)) + '  ルミポ 平均 ' + (st.dRuimpo.mean == null ? '-' : st.dRuimpo.mean.toFixed(1)) + '（' + st.dKotaro.n + '回）' +
            '  遅延補償で参照した位置との差 平均 ' + num(st.dKotaroPast.mean) + ' / 中央値 ' + num(st.dKotaroPast.median),
        );
      }
      const text = lines.join('\n');
      if (this.$.diag.textContent !== text) this.$.diag.textContent = text;
    }

    // テスト・確認用
    get stats() { return this.st; }
  }

  OnlineMoveTest.CONFIG = CFG;
  OnlineMoveTest.RemoteInputController = RemoteInputController;
  KG.OnlineMoveTest = OnlineMoveTest;
})(window.KG = window.KG || {});
